from __future__ import annotations

import asyncio
import math
import uuid
from typing import Any

from futures_bot.config import Settings
from futures_bot.data_engine import BinanceFuturesClient
from futures_bot.models import OrderResult, Position, SignalSide, SymbolRules, TradeSignal


class ExecutionEngine:
    def __init__(self, client: BinanceFuturesClient, settings: Settings) -> None:
        self.client = client
        self.settings = settings

    def _apply_slippage(self, price: float, side: SignalSide, reduce_only: bool = False) -> float:
        bps = self.settings.slippage_bps / 10_000
        if side is SignalSide.LONG:
            return price * (1 - bps if reduce_only else 1 + bps)
        if side is SignalSide.SHORT:
            return price * (1 + bps if reduce_only else 1 - bps)
        return price

    @staticmethod
    def round_quantity(quantity: float, rules: SymbolRules | None) -> float:
        if not rules or rules.quantity_step <= 0:
            return quantity
        rounded = math.floor(quantity / rules.quantity_step) * rules.quantity_step
        precision = max(0, min(8, int(round(-math.log10(rules.quantity_step))) if rules.quantity_step < 1 else 0))
        return round(max(rounded, 0.0), precision)

    @staticmethod
    def round_price(price: float, rules: SymbolRules | None) -> float:
        if not rules or rules.price_tick <= 0:
            return price
        rounded = round(price / rules.price_tick) * rules.price_tick
        precision = max(0, min(8, int(round(-math.log10(rules.price_tick))) if rules.price_tick < 1 else 0))
        return round(rounded, precision)

    async def place_protection_orders(
        self,
        position: Position,
        rules: SymbolRules | None = None,
    ) -> None:
        if not self.settings.is_live:
            return
        exit_side = "SELL" if position.side is SignalSide.LONG else "BUY"
        stop_price = self.round_price(position.stop_loss, rules)
        take_profit_price = self.round_price(position.take_profit_2, rules)
        orders = [
            {
                "symbol": position.symbol,
                "side": exit_side,
                "type": "STOP_MARKET",
                "stopPrice": f"{stop_price:.8f}",
                "closePosition": "true",
                "workingType": "MARK_PRICE",
            },
            {
                "symbol": position.symbol,
                "side": exit_side,
                "type": "TAKE_PROFIT_MARKET",
                "stopPrice": f"{take_profit_price:.8f}",
                "closePosition": "true",
                "workingType": "MARK_PRICE",
            },
        ]
        for payload in orders:
            await self.client.create_order(payload)

    async def place_entry(
        self,
        signal: TradeSignal,
        quantity: float,
        leverage: int,
        order_type: str = "MARKET",
        rules: SymbolRules | None = None,
    ) -> OrderResult:
        order_type = order_type.upper()
        quantity = self.round_quantity(quantity, rules)
        if rules and (quantity < rules.min_quantity or quantity * signal.entry_price < rules.min_notional):
            raise ValueError(f"{signal.symbol} quantity below exchange minimums")
        for attempt in range(1, 4):
            try:
                if self.settings.is_live:
                    await self.client.set_leverage(signal.symbol, leverage)
                    payload: dict[str, Any] = {
                        "symbol": signal.symbol,
                        "side": "BUY" if signal.side is SignalSide.LONG else "SELL",
                        "type": order_type,
                        "quantity": f"{quantity:.6f}",
                    }
                    if order_type == "LIMIT":
                        payload["price"] = f"{self.round_price(signal.entry_price, rules):.8f}"
                        payload["timeInForce"] = "GTC"
                    raw = await self.client.create_order(payload)
                    avg_price = float(raw.get("avgPrice") or raw.get("price") or signal.entry_price)
                    return OrderResult(
                        symbol=signal.symbol,
                        side=signal.side,
                        quantity=quantity,
                        avg_price=avg_price,
                        status=raw.get("status", "NEW"),
                        order_id=str(raw.get("orderId")),
                        raw=raw,
                    )
                avg_price = self._apply_slippage(signal.entry_price, signal.side)
                return OrderResult(
                    symbol=signal.symbol,
                    side=signal.side,
                    quantity=quantity,
                    avg_price=avg_price,
                    status="FILLED",
                    order_id=str(uuid.uuid4()),
                )
            except Exception:
                if attempt == 3:
                    raise
                await asyncio.sleep(1.5 * attempt)
        raise RuntimeError("unreachable")

    async def exit_position(
        self,
        position: Position,
        quantity: float,
        last_price: float,
        rules: SymbolRules | None = None,
    ) -> OrderResult:
        side = SignalSide.SHORT if position.side is SignalSide.LONG else SignalSide.LONG
        quantity = self.round_quantity(quantity, rules)
        for attempt in range(1, 4):
            try:
                if self.settings.is_live:
                    raw = await self.client.create_order(
                        {
                            "symbol": position.symbol,
                            "side": "BUY" if side is SignalSide.LONG else "SELL",
                            "type": "MARKET",
                            "quantity": f"{quantity:.6f}",
                            "reduceOnly": "true",
                        }
                    )
                    avg_price = float(raw.get("avgPrice") or raw.get("price") or last_price)
                    return OrderResult(
                        symbol=position.symbol,
                        side=side,
                        quantity=quantity,
                        avg_price=avg_price,
                        status=raw.get("status", "FILLED"),
                        order_id=str(raw.get("orderId")),
                        reduce_only=True,
                        raw=raw,
                    )
                avg_price = self._apply_slippage(last_price, position.side, reduce_only=True)
                return OrderResult(
                    symbol=position.symbol,
                    side=side,
                    quantity=quantity,
                    avg_price=avg_price,
                    status="FILLED",
                    order_id=str(uuid.uuid4()),
                    reduce_only=True,
                )
            except Exception:
                if attempt == 3:
                    raise
                await asyncio.sleep(1.5 * attempt)
        raise RuntimeError("unreachable")
