from __future__ import annotations

import asyncio
import json
import logging
from urllib.parse import urlencode
from urllib.request import Request, urlopen

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

    def _send_sync(self, message: str) -> None:
        if not self.token or not self.chat_id:
            return
        body = urlencode({"chat_id": self.chat_id, "text": message}).encode()
        request = Request(
            url=f"https://api.telegram.org/bot{self.token}/sendMessage",
            data=body,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            method="POST",
        )
        with urlopen(request, timeout=10) as response:
            json.loads(response.read().decode())

    async def send(self, message: str) -> None:
        if not self.token or not self.chat_id:
            return
        await asyncio.to_thread(self._send_sync, message)


class Monitor:
    def __init__(self, settings: Settings) -> None:
        self.logger = logging.getLogger("futures_bot")
        self.notifier = TelegramNotifier(settings)

    async def on_signal(self, signal: TradeSignal) -> None:
        self.logger.info("Signal %s %s score=%.2f", signal.symbol, signal.side.value, signal.score)

    async def on_startup(self, mode: str, symbols: list[str], account: AccountState) -> None:
        message = (
            "SYSTEM ONLINE\n"
            f"Mode: {mode.upper()}\n"
            f"Symbols: {', '.join(symbols)}\n"
            f"Equity: ${account.equity:.2f}\n"
            f"Available: ${account.available_balance:.2f}"
        )
        self.logger.info(message)
        await self.notifier.send(message)

    async def on_trade(self, title: str, body: str) -> None:
        self.logger.info("%s | %s", title, body)
        await self.notifier.send(f"{title}\n{body}")

    async def on_trade_opened(
        self,
        symbol: str,
        side: str,
        quantity: float,
        entry: float,
        score: float,
        leverage: int,
        stop_loss: float,
        tp1: float,
        tp2: float,
        available_balance: float,
    ) -> None:
        body = (
            "NEW POSITION\n"
            f"Symbol: {symbol}\n"
            f"Side: {side}\n"
            f"Qty: {quantity:.4f}\n"
            f"Entry: {entry:.6f}\n"
            f"Score: {score:.1f}\n"
            f"Leverage: {leverage}x\n"
            f"Stop: {stop_loss:.6f}\n"
            f"TP1: {tp1:.6f}\n"
            f"TP2: {tp2:.6f}\n"
            f"Available balance: ${available_balance:.2f}"
        )
        self.logger.info(body)
        await self.notifier.send(body)

    async def on_trade_closed(
        self,
        symbol: str,
        side: str,
        reason: str,
        quantity: float,
        entry: float,
        exit_price: float,
        pnl: float,
        equity: float,
        fee_paid: float,
    ) -> None:
        body = (
            "POSITION CLOSED\n"
            f"Symbol: {symbol}\n"
            f"Side: {side}\n"
            f"Reason: {reason}\n"
            f"Qty: {quantity:.4f}\n"
            f"Entry: {entry:.6f}\n"
            f"Exit: {exit_price:.6f}\n"
            f"PnL: ${pnl:.2f}\n"
            f"Fees: ${fee_paid:.2f}\n"
            f"Equity: ${equity:.2f}"
        )
        self.logger.info(body)
        await self.notifier.send(body)

    async def on_losses(self, account: AccountState) -> None:
        if account.consecutive_losses >= 2:
            await self.notifier.send(
                "LOSS STREAK ALERT\n"
                f"Consecutive losses: {account.consecutive_losses}\n"
                f"Mode: {account.mode_profile.value}"
            )

    async def daily_summary(self, account: AccountState) -> None:
        summary = (
            "DAILY SUMMARY\n"
            f"Equity: ${account.equity:.2f}\n"
            f"Daily PnL: ${account.daily_pnl:.2f}\n"
            f"Total PnL: ${account.total_pnl:.2f}\n"
            f"Trades today: {account.trades_today}\n"
            f"Mode: {account.mode_profile.value}\n"
            f"Circuit breaker: {account.circuit_breaker_active}"
        )
        self.logger.info(summary)
        await self.notifier.send(summary)

    async def heartbeat(self, account: AccountState, open_positions: int, diagnostics: dict[str, dict] | None = None) -> None:
        details = ""
        if diagnostics:
            rows = []
            for symbol, diag in diagnostics.items():
                blockers = ",".join(diag.get("blockers", [])[:2]) or "none"
                rows.append(f"{symbol}: score={diag.get('score', 0):.1f} | blockers={blockers}")
            details = "\n" + "\n".join(rows[:4])
        message = (
            "BOT HEARTBEAT\n"
            f"Equity: ${account.equity:.2f}\n"
            f"Available: ${account.available_balance:.2f}\n"
            f"Daily PnL: ${account.daily_pnl:.2f}\n"
            f"Trades today: {account.trades_today}\n"
            f"Open positions: {open_positions}\n"
            f"Mode: {account.mode_profile.value}\n"
            f"Circuit breaker: {account.circuit_breaker_active}"
            f"{details}"
        )
        self.logger.info(message)
        await self.notifier.send(message)
