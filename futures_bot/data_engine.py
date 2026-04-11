from __future__ import annotations

import asyncio
import hashlib
import hmac
import time
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlencode

import aiohttp

from futures_bot.config import Settings
from futures_bot.models import Candle, MarketSnapshot


class BinanceFuturesClient:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.rest_base = (
            "https://testnet.binancefuture.com" if settings.testnet else "https://fapi.binance.com"
        )
        self.session: aiohttp.ClientSession | None = None

    async def __aenter__(self) -> "BinanceFuturesClient":
        self.session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=20))
        return self

    async def __aexit__(self, *_: object) -> None:
        if self.session:
            await self.session.close()

    async def _request(
        self,
        method: str,
        path: str,
        params: dict[str, Any] | None = None,
        signed: bool = False,
    ) -> Any:
        if not self.session:
            raise RuntimeError("HTTP session not initialized")
        query = dict(params or {})
        headers = {}
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

        async with self.session.request(
            method,
            f"{self.rest_base}{path}",
            params=query,
            headers=headers,
        ) as response:
            response.raise_for_status()
            return await response.json()

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
