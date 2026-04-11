from __future__ import annotations

import logging

import aiohttp

from futures_bot.config import Settings
from futures_bot.models import AccountState, TradeSignal


def setup_logging(level: str) -> None:
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
    )


class TelegramNotifier:
    def __init__(self, settings: Settings) -> None:
        self.token = settings.telegram_token
        self.chat_id = settings.telegram_chat_id

    async def send(self, message: str) -> None:
        if not self.token or not self.chat_id:
            return
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as session:
            await session.post(
                f"https://api.telegram.org/bot{self.token}/sendMessage",
                data={"chat_id": self.chat_id, "text": message},
            )


class Monitor:
    def __init__(self, settings: Settings) -> None:
        self.logger = logging.getLogger("futures_bot")
        self.notifier = TelegramNotifier(settings)

    async def on_signal(self, signal: TradeSignal) -> None:
        self.logger.info("Signal %s %s score=%.2f", signal.symbol, signal.side.value, signal.score)

    async def on_trade(self, title: str, body: str) -> None:
        self.logger.info("%s | %s", title, body)
        await self.notifier.send(f"{title}\n{body}")

    async def on_losses(self, account: AccountState) -> None:
        if account.consecutive_losses >= 2:
            await self.notifier.send(
                f"Loss streak alert\nConsecutive losses: {account.consecutive_losses}\nMode: {account.mode_profile.value}"
            )

    async def daily_summary(self, account: AccountState) -> None:
        summary = (
            "Daily summary\n"
            f"Equity: {account.equity:.2f}\n"
            f"Daily PnL: {account.daily_pnl:.2f}\n"
            f"Total PnL: {account.total_pnl:.2f}\n"
            f"Mode: {account.mode_profile.value}\n"
            f"Circuit breaker: {account.circuit_breaker_active}"
        )
        self.logger.info(summary)
        await self.notifier.send(summary)
