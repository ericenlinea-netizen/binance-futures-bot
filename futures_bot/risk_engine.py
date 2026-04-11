from __future__ import annotations

from datetime import UTC, datetime

from futures_bot.config import Settings
from futures_bot.models import AccountState, ModeProfile, Position, TradeSignal


class RiskEngine:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def reset_daily_if_needed(self, account: AccountState) -> None:
        today = datetime.now(UTC).date().isoformat()
        if account.last_trade_day != today:
            account.daily_pnl = 0.0
            account.trades_today = 0
            account.last_trade_day = today

    def current_risk_fraction(self, account: AccountState) -> float:
        risk = self.settings.risk_per_trade
        if account.mode_profile is ModeProfile.CONSERVATIVE:
            return max(0.005, risk * 0.5)
        if account.mode_profile is ModeProfile.CONTROLLED_AGGRESSIVE:
            return min(0.01, risk * 1.25)
        return risk

    def update_mode(self, account: AccountState) -> None:
        drawup = (account.equity - self.settings.initial_equity) / self.settings.initial_equity
        if account.consecutive_losses >= self.settings.conservative_after_losses:
            account.mode_profile = ModeProfile.CONSERVATIVE
        elif drawup >= self.settings.aggressive_unlock_return:
            account.mode_profile = ModeProfile.CONTROLLED_AGGRESSIVE
        else:
            account.mode_profile = ModeProfile.NORMAL

    def validate_signal(self, account: AccountState, signal: TradeSignal, open_positions: list[Position]) -> tuple[bool, str]:
        self.reset_daily_if_needed(account)
        self.update_mode(account)
        if account.circuit_breaker_active:
            return False, "circuit_breaker_active"
        if account.trades_today >= self.settings.max_trades_per_day:
            return False, "daily_trade_limit"
        if len(open_positions) >= self.settings.max_positions:
            return False, "max_positions_reached"
        if signal.entry_price <= 0 or signal.atr <= 0:
            return False, "invalid_market_data"
        if signal.symbol in {position.symbol for position in open_positions}:
            return False, "symbol_already_open"
        return True, "ok"

    def calculate_position_size(self, account: AccountState, signal: TradeSignal) -> tuple[float, int]:
        risk_amount = account.equity * self.current_risk_fraction(account)
        stop_distance = abs(signal.entry_price - signal.stop_loss)
        if stop_distance <= 0:
            return 0.0, 1
        raw_quantity = risk_amount / stop_distance
        leverage = min(self.settings.max_leverage, max(1, int((raw_quantity * signal.entry_price) / account.equity) + 1))
        notional = raw_quantity * signal.entry_price
        if notional > account.available_balance * leverage:
            raw_quantity = (account.available_balance * leverage) / signal.entry_price
        return max(raw_quantity, 0.0), leverage

    def register_realized_pnl(self, account: AccountState, pnl: float) -> None:
        self.reset_daily_if_needed(account)
        account.daily_pnl += pnl
        account.total_pnl += pnl
        account.equity += pnl
        account.available_balance += pnl
        account.peak_equity = max(account.peak_equity, account.equity)
        if pnl < 0:
            account.consecutive_losses += 1
        else:
            account.consecutive_losses = 0
        daily_drawdown = abs(min(account.daily_pnl, 0.0)) / max(account.equity, 1.0)
        total_drawdown = (account.peak_equity - account.equity) / max(account.peak_equity, 1.0)
        if daily_drawdown >= self.settings.daily_drawdown_limit or total_drawdown >= self.settings.total_drawdown_limit:
            account.circuit_breaker_active = True
        self.update_mode(account)
