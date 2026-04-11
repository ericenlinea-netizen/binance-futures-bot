from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path

from futures_bot.models import AccountState, BacktestTrade, Position


class SQLiteStore:
    def __init__(self, path: str) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._init_db()

    @contextmanager
    def connect(self):
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()

    def _init_db(self) -> None:
        with self.connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS trades (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    symbol TEXT NOT NULL,
                    side TEXT NOT NULL,
                    quantity REAL NOT NULL,
                    entry_price REAL NOT NULL,
                    exit_price REAL,
                    pnl REAL,
                    reason TEXT,
                    created_at TEXT NOT NULL,
                    closed_at TEXT
                );
                CREATE TABLE IF NOT EXISTS signals (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    symbol TEXT NOT NULL,
                    side TEXT NOT NULL,
                    score REAL NOT NULL,
                    reasons TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS equity_snapshots (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    equity REAL NOT NULL,
                    available_balance REAL NOT NULL,
                    daily_pnl REAL NOT NULL,
                    total_pnl REAL NOT NULL,
                    mode_profile TEXT NOT NULL,
                    circuit_breaker_active INTEGER NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                """
            )

    def record_signal(self, symbol: str, side: str, score: float, reasons: list[str], timestamp: str) -> None:
        with self.connect() as conn:
            conn.execute(
                "INSERT INTO signals(symbol, side, score, reasons, created_at) VALUES (?, ?, ?, ?, ?)",
                (symbol, side, score, " | ".join(reasons), timestamp),
            )

    def record_open_trade(self, position: Position) -> None:
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO trades(symbol, side, quantity, entry_price, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    position.symbol,
                    position.side.value,
                    position.quantity,
                    position.entry_price,
                    position.opened_at.isoformat(),
                ),
            )

    def record_closed_trade(self, trade: BacktestTrade) -> None:
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO trades(symbol, side, quantity, entry_price, exit_price, pnl, reason, created_at, closed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    trade.symbol,
                    trade.side.value,
                    trade.quantity,
                    trade.entry_price,
                    trade.exit_price,
                    trade.pnl,
                    trade.reason,
                    trade.entry_time.isoformat(),
                    trade.exit_time.isoformat(),
                ),
            )

    def record_equity(self, state: AccountState) -> None:
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO equity_snapshots(
                    equity, available_balance, daily_pnl, total_pnl, mode_profile, circuit_breaker_active
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    state.equity,
                    state.available_balance,
                    state.daily_pnl,
                    state.total_pnl,
                    state.mode_profile.value,
                    int(state.circuit_breaker_active),
                ),
            )

