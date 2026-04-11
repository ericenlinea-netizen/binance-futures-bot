from __future__ import annotations

from aiohttp import web

from futures_bot.models import AccountState
from futures_bot.portfolio_manager import PortfolioManager


class StatusServer:
    def __init__(self, account: AccountState, portfolio: PortfolioManager) -> None:
        self.account = account
        self.portfolio = portfolio
        self.runner: web.AppRunner | None = None

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
        }

    async def _health(self, _: web.Request) -> web.Response:
        return web.json_response({"status": "ok"})

    async def _status(self, _: web.Request) -> web.Response:
        return web.json_response(self._snapshot())

    async def start(self, port: int) -> None:
        app = web.Application()
        app.router.add_get("/", self._status)
        app.router.add_get("/health", self._health)
        app.router.add_get("/status", self._status)
        self.runner = web.AppRunner(app)
        await self.runner.setup()
        site = web.TCPSite(self.runner, host="0.0.0.0", port=port)
        await site.start()

    async def stop(self) -> None:
        if self.runner:
            await self.runner.cleanup()
