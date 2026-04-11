from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import Enum


class SignalSide(str, Enum):
    LONG = "LONG"
    SHORT = "SHORT"
    FLAT = "FLAT"


class ModeProfile(str, Enum):
    NORMAL = "normal"
    CONSERVATIVE = "conservative"
    CONTROLLED_AGGRESSIVE = "controlled_aggressive"


@dataclass(slots=True)
class Candle:
    open_time: datetime
    open: float
    high: float
    low: float
    close: float
    volume: float
    close_time: datetime


@dataclass(slots=True)
class MarketSnapshot:
    symbol: str
    base_timeframe: str
    confirm_timeframe: str
    base_candles: list[Candle]
    confirm_candles: list[Candle]


@dataclass(slots=True)
class TradeSignal:
    symbol: str
    side: SignalSide
    score: float
    reasons: list[str]
    entry_price: float
    atr: float
    stop_loss: float
    take_profit_1: float
    take_profit_2: float
    trend_strength: float
    timestamp: datetime = field(default_factory=lambda: datetime.now(UTC))


@dataclass(slots=True)
class Position:
    symbol: str
    side: SignalSide
    quantity: float
    entry_price: float
    stop_loss: float
    take_profit_1: float
    take_profit_2: float
    leverage: int
    opened_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    highest_price: float = 0.0
    lowest_price: float = 0.0
    trailing_active: bool = False
    partial_exit_done: bool = False
    closed: bool = False

    def __post_init__(self) -> None:
        self.highest_price = self.entry_price
        self.lowest_price = self.entry_price


@dataclass(slots=True)
class AccountState:
    equity: float
    available_balance: float
    daily_pnl: float = 0.0
    total_pnl: float = 0.0
    peak_equity: float = 0.0
    mode_profile: ModeProfile = ModeProfile.NORMAL
    consecutive_losses: int = 0
    trades_today: int = 0
    last_trade_day: str = ""
    circuit_breaker_active: bool = False

    def __post_init__(self) -> None:
        if self.peak_equity == 0:
            self.peak_equity = self.equity


@dataclass(slots=True)
class OrderResult:
    symbol: str
    side: SignalSide
    quantity: float
    avg_price: float
    status: str
    order_id: str
    reduce_only: bool = False
    raw: dict | None = None


@dataclass(slots=True)
class BacktestTrade:
    symbol: str
    side: SignalSide
    entry_time: datetime
    exit_time: datetime
    entry_price: float
    exit_price: float
    quantity: float
    pnl: float
    pnl_pct: float
    fee_paid: float
    reason: str

