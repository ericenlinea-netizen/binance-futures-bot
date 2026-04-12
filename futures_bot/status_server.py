from __future__ import annotations

import asyncio
import json

from futures_bot.models import AccountState
from futures_bot.portfolio_manager import PortfolioManager


class StatusServer:
    def __init__(self, account: AccountState, portfolio: PortfolioManager, diagnostics: dict[str, dict]) -> None:
        self.account = account
        self.portfolio = portfolio
        self.diagnostics = diagnostics
        self.server: asyncio.base_events.Server | None = None

    def _snapshot(self) -> dict:
        positions = [
            {
                "symbol": position.symbol,
                "side": position.side.value,
                "quantity": position.quantity,
                "entry_price": position.entry_price,
                "stop_loss": position.stop_loss,
                "take_profit_1": position.take_profit_1,
                "take_profit_2": position.take_profit_2,
                "leverage": position.leverage,
                "opened_at": position.opened_at.isoformat(),
            }
            for position in self.portfolio.open_positions()
        ]
        return {
            "status": "ok",
            "equity": self.account.equity,
            "available_balance": self.account.available_balance,
            "daily_pnl": self.account.daily_pnl,
            "total_pnl": self.account.total_pnl,
            "mode_profile": self.account.mode_profile.value,
            "circuit_breaker_active": self.account.circuit_breaker_active,
            "trades_today": self.account.trades_today,
            "open_positions": positions,
            "last_diagnostics": self.diagnostics,
        }

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            request_line = await reader.readline()
            path = "/"
            if request_line:
                parts = request_line.decode(errors="ignore").split(" ")
                if len(parts) >= 2:
                    path = parts[1]
            while True:
                line = await reader.readline()
                if not line or line in {b"\r\n", b"\n"}:
                    break

            if path == "/health":
                body = json.dumps({"status": "ok"}).encode()
            else:
                body = json.dumps(self._snapshot()).encode()

            writer.write(
                b"HTTP/1.1 200 OK\r\n"
                b"Content-Type: application/json\r\n"
                + f"Content-Length: {len(body)}\r\n".encode()
                + b"Connection: close\r\n\r\n"
                + body
            )
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()

    async def start(self, port: int) -> None:
        self.server = await asyncio.start_server(self._handle, host="0.0.0.0", port=port)

    async def stop(self) -> None:
        if self.server:
            self.server.close()
            await self.server.wait_closed()
