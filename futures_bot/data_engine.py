from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import time
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from futures_bot.config import Settings
from futures_bot.models import Candle, MarketSnapshot, SymbolRules


class BinanceFuturesClient:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.rest_base = (
            "https://testnet.binancefuture.com" if settings.testnet else "https://fapi.binance.com"
        )

    async def __aenter__(self) -> "BinanceFuturesClient":
        return self

    async def __aexit__(self, *_: object) -> None:
        return None

    def _request_sync(
        self,
        method: str,
        path: str,
        params: dict[str, Any] | None = None,
        signed: bool = False,
    ) -> Any:
        query = dict(params or {})
        headers: dict[str, str] = {}
        if signed:
            query["timestamp"] = int(time.time() * 1000)
            payload = urlencode(query)
            signature = hmac.new(
                self.settings.api_secret.encode(),
                payload.encode(),
                hashlib.sha256,
            ).hexdigest()
            query["signature"] = signature
            headers["X-MBX-APIKEY"] = self.settings.api_key
        elif self.settings.api_key:
            headers["X-MBX-APIKEY"] = self.settings.api_key

        url = f"{self.rest_base}{path}"
        body: bytes | None = None
        if method.upper() == "GET":
            if query:
                url = f"{url}?{urlencode(query)}"
        else:
            body = urlencode(query).encode()
            headers["Content-Type"] = "application/x-www-form-urlencoded"

        request = Request(url=url, data=body, headers=headers, method=method.upper())
        with urlopen(request, timeout=20) as response:
            return json.loads(response.read().decode())

    async def _request(
        self,
        method: str,
        path: str,
        params: dict[str, Any] | None = None,
        signed: bool = False,
    ) -> Any:
        return await asyncio.to_thread(self._request_sync, method, path, params, signed)

    async def fetch_klines(self, symbol: str, interval: str, limit: int) -> list[Candle]:
        raw = await self._request(
            "GET",
            "/fapi/v1/klines",
            {"symbol": symbol, "interval": interval, "limit": limit},
        )
        candles: list[Candle] = []
        for row in raw:
            candles.append(
                Candle(
                    open_time=datetime.fromtimestamp(row[0] / 1000, UTC),
                    open=float(row[1]),
                    high=float(row[2]),
                    low=float(row[3]),
                    close=float(row[4]),
                    volume=float(row[5]),
                    close_time=datetime.fromtimestamp(row[6] / 1000, UTC),
                )
            )
        return candles

    async def fetch_account_balance(self) -> dict[str, Any]:
        return await self._request("GET", "/fapi/v2/account", signed=True)

    async def fetch_exchange_info(self) -> dict[str, Any]:
        return await self._request("GET", "/fapi/v1/exchangeInfo")

    async def fetch_symbol_rules(self, symbols: list[str]) -> dict[str, SymbolRules]:
        info = await self.fetch_exchange_info()
        wanted = set(symbols)
        rules: dict[str, SymbolRules] = {}
        for item in info.get("symbols", []):
            symbol = item.get("symbol")
            if symbol not in wanted:
                continue
            quantity_step = 0.001
            min_quantity = 0.0
            price_tick = 0.01
            min_notional = 5.0
            for rule in item.get("filters", []):
                if rule.get("filterType") == "LOT_SIZE":
                    quantity_step = float(rule.get("stepSize", quantity_step))
                    min_quantity = float(rule.get("minQty", min_quantity))
                elif rule.get("filterType") == "PRICE_FILTER":
                    price_tick = float(rule.get("tickSize", price_tick))
                elif rule.get("filterType") in {"MIN_NOTIONAL", "NOTIONAL"}:
                    min_notional = float(rule.get("notional", rule.get("minNotional", min_notional)))
            rules[symbol] = SymbolRules(
                symbol=symbol,
                quantity_step=quantity_step,
                min_quantity=min_quantity,
                price_tick=price_tick,
                min_notional=min_notional,
            )
        return rules

    async def set_leverage(self, symbol: str, leverage: int) -> dict[str, Any]:
        return await self._request(
            "POST",
            "/fapi/v1/leverage",
            {"symbol": symbol, "leverage": leverage},
            signed=True,
        )

    async def create_order(self, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._request("POST", "/fapi/v1/order", payload, signed=True)


class DataEngine:
    def __init__(self, client: BinanceFuturesClient, settings: Settings) -> None:
        self.client = client
        self.settings = settings

    async def snapshot(self, symbol: str) -> MarketSnapshot:
        base_task = asyncio.create_task(
            self.client.fetch_klines(symbol, self.settings.base_timeframe, self.settings.lookback_limit)
        )
        confirm_task = asyncio.create_task(
            self.client.fetch_klines(symbol, self.settings.confirm_timeframe, self.settings.lookback_limit)
        )
        base_candles, confirm_candles = await asyncio.gather(base_task, confirm_task)
        return MarketSnapshot(
            symbol=symbol,
            base_timeframe=self.settings.base_timeframe,
            confirm_timeframe=self.settings.confirm_timeframe,
            base_candles=base_candles,
            confirm_candles=confirm_candles,
        )
