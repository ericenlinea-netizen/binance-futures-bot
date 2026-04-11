from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv


def _get_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _get_list(name: str, default: list[str]) -> list[str]:
    value = os.getenv(name)
    if not value:
        return default
    return [item.strip().upper() for item in value.split(",") if item.strip()]


@dataclass(slots=True)
class Settings:
    env_file: str = ".env"
    mode: str = "paper"
    api_key: str = ""
    api_secret: str = ""
    testnet: bool = True
    symbols: list[str] = field(default_factory=lambda: ["BTCUSDT", "ETHUSDT"])
    base_timeframe: str = "5m"
    confirm_timeframe: str = "15m"
    lookback_limit: int = 300
    min_signal_score: float = 70.0
    max_trades_per_day: int = 3
    risk_per_trade: float = 0.0075
    daily_drawdown_limit: float = 0.03
    total_drawdown_limit: float = 0.10
    max_positions: int = 2
    max_leverage: int = 5
    max_symbol_correlation: float = 0.80
    conservative_after_losses: int = 2
    aggressive_unlock_return: float = 0.05
    fee_rate: float = 0.0004
    slippage_bps: float = 3.0
    telegram_token: str = ""
    telegram_chat_id: str = ""
    sqlite_path: str = "trading.db"
    log_level: str = "INFO"
    poll_seconds: float = 5.0
    initial_equity: float = 250.0
    service_port: int = 8000

    @property
    def is_live(self) -> bool:
        return self.mode.lower() == "live"

    @property
    def db_path(self) -> Path:
        return Path(self.sqlite_path).resolve()

    @classmethod
    def load(cls, env_file: str = ".env") -> "Settings":
        load_dotenv(env_file)
        return cls(
            env_file=env_file,
            mode=os.getenv("BOT_MODE", "paper").lower(),
            api_key=os.getenv("BINANCE_API_KEY", ""),
            api_secret=os.getenv("BINANCE_API_SECRET", ""),
            testnet=_get_bool("BINANCE_TESTNET", True),
            symbols=_get_list("SYMBOLS", ["BTCUSDT", "ETHUSDT"]),
            base_timeframe=os.getenv("BASE_TIMEFRAME", "5m"),
            confirm_timeframe=os.getenv("CONFIRM_TIMEFRAME", "15m"),
            lookback_limit=int(os.getenv("LOOKBACK_LIMIT", "300")),
            min_signal_score=float(os.getenv("MIN_SIGNAL_SCORE", "70")),
            max_trades_per_day=int(os.getenv("MAX_TRADES_PER_DAY", "3")),
            risk_per_trade=float(os.getenv("RISK_PER_TRADE", "0.0075")),
            daily_drawdown_limit=float(os.getenv("DAILY_DRAWDOWN_LIMIT", "0.03")),
            total_drawdown_limit=float(os.getenv("TOTAL_DRAWDOWN_LIMIT", "0.10")),
            max_positions=int(os.getenv("MAX_POSITIONS", "2")),
            max_leverage=int(os.getenv("MAX_LEVERAGE", "5")),
            max_symbol_correlation=float(os.getenv("MAX_SYMBOL_CORRELATION", "0.80")),
            conservative_after_losses=int(os.getenv("CONSERVATIVE_AFTER_LOSSES", "2")),
            aggressive_unlock_return=float(os.getenv("AGGRESSIVE_UNLOCK_RETURN", "0.05")),
            fee_rate=float(os.getenv("FEE_RATE", "0.0004")),
            slippage_bps=float(os.getenv("SLIPPAGE_BPS", "3")),
            telegram_token=os.getenv("TELEGRAM_TOKEN", ""),
            telegram_chat_id=os.getenv("TELEGRAM_CHAT_ID", ""),
            sqlite_path=os.getenv("SQLITE_PATH", "trading.db"),
            log_level=os.getenv("LOG_LEVEL", "INFO"),
            poll_seconds=float(os.getenv("POLL_SECONDS", "5")),
            initial_equity=float(os.getenv("INITIAL_EQUITY", "250")),
            service_port=int(os.getenv("PORT", os.getenv("SERVICE_PORT", "8000"))),
        )
