from __future__ import annotations

from collections import defaultdict
from datetime import UTC, datetime

from futures_bot.config import Settings
from futures_bot.models import Position, SignalSide


class PortfolioManager:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.positions: dict[str, Position] = {}
        self.symbol_returns: dict[str, list[float]] = defaultdict(list)

    def open_positions(self) -> list[Position]:
        return [position for position in self.positions.values() if not position.closed]

    def register_return(self, symbol: str, pct_move: float) -> None:
        history = self.symbol_returns[symbol]
        history.append(pct_move)
        del history[:-200]

    def correlation_too_high(self, symbol: str, peer_symbols: list[str]) -> bool:
        if not self.symbol_returns[symbol]:
            return False
        baseline = self.symbol_returns[symbol][-50:]
        for peer in peer_symbols:
            peer_values = self.symbol_returns[peer][-50:]
            if len(peer_values) != len(baseline) or len(peer_values) < 10:
                continue
            mean_a = sum(baseline) / len(baseline)
            mean_b = sum(peer_values) / len(peer_values)
            covariance = sum((a - mean_a) * (b - mean_b) for a, b in zip(baseline, peer_values))
            variance_a = sum((a - mean_a) ** 2 for a in baseline)
            variance_b = sum((b - mean_b) ** 2 for b in peer_values)
            if variance_a == 0 or variance_b == 0:
                continue
            correlation = covariance / ((variance_a * variance_b) ** 0.5)
            if abs(correlation) >= self.settings.max_symbol_correlation:
                return True
        return False

    def add_position(self, position: Position) -> None:
        self.positions[position.symbol] = position

    def close_position(self, symbol: str) -> Position | None:
        position = self.positions.get(symbol)
        if not position:
            return None
        position.closed = True
        return position

    def update_mark(self, symbol: str, last_price: float) -> None:
        position = self.positions.get(symbol)
        if not position or position.closed:
            return
        position.highest_price = max(position.highest_price, last_price)
        position.lowest_price = min(position.lowest_price, last_price)

    def evaluate_exit(self, symbol: str, last_price: float) -> tuple[str | None, float]:
        position = self.positions.get(symbol)
        if not position or position.closed:
            return None, 0.0
        self.update_mark(symbol, last_price)
        if position.side is SignalSide.LONG:
            if last_price <= position.stop_loss:
                return "stop_loss", position.quantity
            if not position.partial_exit_done and last_price >= position.take_profit_1:
                position.partial_exit_done = True
                position.trailing_active = True
                return "partial_tp", position.quantity * 0.5
            if last_price >= position.take_profit_2:
                remaining = position.quantity
                return "take_profit_2", remaining
            if position.trailing_active:
                trailing_stop = position.highest_price - ((position.highest_price - position.entry_price) * 0.35)
                if last_price <= trailing_stop:
                    remaining = position.quantity
                    return "trailing_stop", remaining
        else:
            if last_price >= position.stop_loss:
                return "stop_loss", position.quantity
            if not position.partial_exit_done and last_price <= position.take_profit_1:
                position.partial_exit_done = True
                position.trailing_active = True
                return "partial_tp", position.quantity * 0.5
            if last_price <= position.take_profit_2:
                remaining = position.quantity
                return "take_profit_2", remaining
            if position.trailing_active:
                trailing_stop = position.lowest_price + ((position.entry_price - position.lowest_price) * 0.35)
                if last_price >= trailing_stop:
                    remaining = position.quantity
                    return "trailing_stop", remaining
        return None, 0.0

    def build_position(
        self,
        symbol: str,
        side: SignalSide,
        quantity: float,
        entry_price: float,
        stop_loss: float,
        tp1: float,
        tp2: float,
        leverage: int,
    ) -> Position:
        return Position(
            symbol=symbol,
            side=side,
            quantity=quantity,
            entry_price=entry_price,
            stop_loss=stop_loss,
            take_profit_1=tp1,
            take_profit_2=tp2,
            leverage=leverage,
            opened_at=datetime.now(UTC),
        )
