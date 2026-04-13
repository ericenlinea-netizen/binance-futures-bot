from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime

from futures_bot.config import Settings
from futures_bot.data_engine import BinanceFuturesClient, DataEngine
from futures_bot.execution_engine import ExecutionEngine
from futures_bot.models import AccountState, BacktestTrade, SignalSide, TradeSignal
from futures_bot.monitoring import Monitor, setup_logging
from futures_bot.persistence import SQLiteStore
from futures_bot.portfolio_manager import PortfolioManager
from futures_bot.risk_engine import RiskEngine
from futures_bot.strategy_engine import StrategyEngine
from futures_bot.status_server import StatusServer


class TradingBot:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        setup_logging(settings.log_level)
        self.logger = logging.getLogger("futures_bot.bot")
        self.store = SQLiteStore(settings.sqlite_path)
        self.monitor = Monitor(settings)
        self.strategy = StrategyEngine(settings.min_signal_score)
        self.risk = RiskEngine(settings)
        self.portfolio = PortfolioManager(settings)
        self.last_diagnostics: dict[str, dict] = {}
        self.account = AccountState(
            equity=settings.initial_equity,
            available_balance=settings.initial_equity,
        )
        self.status_server = StatusServer(self.account, self.portfolio, self.last_diagnostics)

    async def _bootstrap_balance(self, client: BinanceFuturesClient) -> None:
        if not self.settings.is_live:
            return
        account = await client.fetch_account_balance()
        available = float(account.get("availableBalance", self.settings.initial_equity))
        wallet = float(account.get("totalWalletBalance", available))
        self.account.equity = wallet
        self.account.available_balance = available
        self.account.peak_equity = wallet

    async def _open_position(
        self,
        signal: TradeSignal,
        quantity: float,
        leverage: int,
        execution: ExecutionEngine,
    ) -> None:
        required_margin = (signal.entry_price * quantity) / max(leverage, 1)
        usable_balance = max(
            self.account.available_balance * (1 - self.settings.margin_buffer_ratio),
            0.0,
        )
        if required_margin > usable_balance:
            self.logger.info(
                "Skipping %s due to insufficient margin buffer: required=%.4f usable=%.4f",
                signal.symbol,
                required_margin,
                usable_balance,
            )
            return
        result = await execution.place_entry(signal, quantity, leverage, order_type="MARKET")
        position = self.portfolio.build_position(
            symbol=signal.symbol,
            side=signal.side,
            quantity=quantity,
            entry_price=result.avg_price,
            stop_loss=signal.stop_loss,
            tp1=signal.take_profit_1,
            tp2=signal.take_profit_2,
            leverage=leverage,
        )
        self.account.trades_today += 1
        used_margin = (result.avg_price * quantity) / max(leverage, 1)
        self.account.available_balance = max(self.account.available_balance - used_margin, 0.0)
        self.portfolio.add_position(position)
        self.store.record_open_trade(position)
        await self.monitor.on_trade_opened(
            symbol=signal.symbol,
            side=signal.side.value,
            quantity=quantity,
            entry=result.avg_price,
            score=signal.score,
            leverage=leverage,
            stop_loss=signal.stop_loss,
            tp1=signal.take_profit_1,
            tp2=signal.take_profit_2,
            available_balance=self.account.available_balance,
        )

    async def _close_position(
        self,
        symbol: str,
        quantity: float,
        last_price: float,
        reason: str,
        execution: ExecutionEngine,
    ) -> None:
        position = self.portfolio.positions[symbol]
        result = await execution.exit_position(position, quantity, last_price)
        direction = 1 if position.side is SignalSide.LONG else -1
        pnl = (result.avg_price - position.entry_price) * quantity * direction
        fees = (position.entry_price * quantity * self.settings.fee_rate) + (result.avg_price * quantity * self.settings.fee_rate)
        pnl -= fees
        released_margin = (position.entry_price * quantity) / max(position.leverage, 1)
        self.account.available_balance = min(self.account.available_balance + released_margin, self.account.equity)
        self.risk.register_realized_pnl(self.account, pnl)
        if quantity >= position.quantity or reason != "partial_tp":
            self.portfolio.close_position(symbol)
        else:
            position.quantity -= quantity
        trade = BacktestTrade(
            symbol=symbol,
            side=position.side,
            entry_time=position.opened_at,
            exit_time=datetime.now(UTC),
            entry_price=position.entry_price,
            exit_price=result.avg_price,
            quantity=quantity,
            pnl=pnl,
            pnl_pct=pnl / max(self.account.equity, 1.0),
            fee_paid=fees,
            reason=reason,
        )
        self.store.record_closed_trade(trade)
        self.store.record_equity(self.account)
        await self.monitor.on_trade_closed(
            symbol=symbol,
            side=position.side.value,
            reason=reason,
            quantity=quantity,
            entry=position.entry_price,
            exit_price=result.avg_price,
            pnl=pnl,
            equity=self.account.equity,
            fee_paid=fees,
        )
        await self.monitor.on_losses(self.account)

    async def _scan_symbol(
        self,
        symbol: str,
        data_engine: DataEngine,
        execution: ExecutionEngine,
    ) -> TradeSignal | None:
        snapshot = await data_engine.snapshot(symbol)
        closes = [c.close for c in snapshot.base_candles]
        if len(closes) >= 2:
            self.portfolio.register_return(symbol, (closes[-1] - closes[-2]) / closes[-2])
        diag = self.strategy.diagnostics(snapshot)
        if diag:
            self.last_diagnostics[symbol] = diag

        existing = self.portfolio.positions.get(symbol)
        if existing and not existing.closed:
            exit_reason, quantity = self.portfolio.evaluate_exit(symbol, closes[-1])
            if self.strategy.exit_on_trend_change(snapshot, existing.side):
                exit_reason = exit_reason or "trend_change"
                quantity = quantity or existing.quantity
            if exit_reason and quantity > 0:
                await self._close_position(symbol, quantity, closes[-1], exit_reason, execution)
            return None

        signal = self.strategy.evaluate(snapshot)
        if not signal:
            return None

        await self.monitor.on_signal(signal)
        self.store.record_signal(signal.symbol, signal.side.value, signal.score, signal.reasons, signal.timestamp.isoformat())
        return signal

    def _rank_signals(self, signals: list[TradeSignal]) -> list[TradeSignal]:
        return sorted(
            signals,
            key=lambda signal: (
                signal.score,
                signal.trend_strength,
                signal.atr / max(signal.entry_price, 1e-9),
            ),
            reverse=True,
        )

    async def run(self) -> None:
        last_summary_day = ""
        last_heartbeat_slot = ""
        last_hourly_summary_slot = ""
        if self.settings.is_live and (not self.settings.api_key or not self.settings.api_secret):
            raise RuntimeError("Live mode requires BINANCE_API_KEY and BINANCE_API_SECRET")
        await self.status_server.start(self.settings.service_port)
        try:
            async with BinanceFuturesClient(self.settings) as client:
                await self._bootstrap_balance(client)
                data_engine = DataEngine(client, self.settings)
                execution = ExecutionEngine(client, self.settings)
                self.logger.info("Bot started in %s mode for %s", self.settings.mode, ",".join(self.settings.symbols))
                await self.monitor.on_startup(self.settings.mode, self.settings.symbols, self.account)

                while True:
                    try:
                        scanned = await asyncio.gather(
                            *(self._scan_symbol(symbol, data_engine, execution) for symbol in self.settings.symbols)
                        )
                        candidates = [signal for signal in scanned if signal is not None]
                        ranked_signals = self._rank_signals(candidates)
                        for signal in ranked_signals:
                            open_positions = self.portfolio.open_positions()
                            open_symbols = [position.symbol for position in open_positions]
                            if self.portfolio.correlation_too_high(signal.symbol, open_symbols):
                                continue
                            allowed, reason = self.risk.validate_signal(self.account, signal, open_positions)
                            if not allowed:
                                self.logger.info("Signal rejected for %s: %s", signal.symbol, reason)
                                continue
                            quantity, leverage = self.risk.calculate_position_size(self.account, signal)
                            if quantity <= 0:
                                continue
                            await self._open_position(signal, quantity, leverage, execution)

                        now = datetime.now(self.settings.tzinfo)
                        current_day = now.date().isoformat()
                        current_heartbeat_slot = f"{current_day}-{now.hour}-{now.minute // max(self.settings.heartbeat_minutes, 1)}"
                        current_hourly_summary_slot = (
                            f"{current_day}-{now.hour}-{now.minute // max(self.settings.hourly_summary_minutes, 1)}"
                        )
                        if last_summary_day != current_day and now.hour == 23:
                            await self.monitor.daily_summary(self.account)
                            last_summary_day = current_day
                        if current_hourly_summary_slot != last_hourly_summary_slot:
                            await self.monitor.hourly_capital_summary(self.account)
                            last_hourly_summary_slot = current_hourly_summary_slot
                        if current_heartbeat_slot != last_heartbeat_slot:
                            await self.monitor.heartbeat(
                                self.account,
                                len(self.portfolio.open_positions()),
                                self.last_diagnostics,
                            )
                            last_heartbeat_slot = current_heartbeat_slot
                        self.store.record_equity(self.account)
                        await asyncio.sleep(self.settings.poll_seconds)
                    except Exception as exc:
                        self.logger.exception("Main loop error: %s", exc)
                        await asyncio.sleep(min(self.settings.poll_seconds * 2, 30))
        finally:
            await self.status_server.stop()
