from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

from futures_bot.models import AccountState, BacktestTrade, ModeProfile, Position, SignalSide


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
                CREATE TABLE IF NOT EXISTS runtime_state (
                    state_key TEXT PRIMARY KEY,
                    equity REAL NOT NULL,
                    available_balance REAL NOT NULL,
                    daily_pnl REAL NOT NULL,
                    total_pnl REAL NOT NULL,
                    peak_equity REAL NOT NULL,
                    mode_profile TEXT NOT NULL,
                    consecutive_losses INTEGER NOT NULL,
                    trades_today INTEGER NOT NULL,
                    last_trade_day TEXT NOT NULL,
                    circuit_breaker_active INTEGER NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS open_positions (
                    symbol TEXT PRIMARY KEY,
                    side TEXT NOT NULL,
                    quantity REAL NOT NULL,
                    entry_price REAL NOT NULL,
                    stop_loss REAL NOT NULL,
                    take_profit_1 REAL NOT NULL,
                    take_profit_2 REAL NOT NULL,
                    leverage INTEGER NOT NULL,
                    opened_at TEXT NOT NULL,
                    highest_price REAL NOT NULL,
                    lowest_price REAL NOT NULL,
                    trailing_active INTEGER NOT NULL,
                    partial_exit_done INTEGER NOT NULL,
                    closed INTEGER NOT NULL
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

    def save_runtime_state(self, state: AccountState, positions: list[Position]) -> None:
        timestamp = datetime.utcnow().isoformat()
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO runtime_state(
                    state_key, equity, available_balance, daily_pnl, total_pnl, peak_equity,
                    mode_profile, consecutive_losses, trades_today, last_trade_day,
                    circuit_breaker_active, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(state_key) DO UPDATE SET
                    equity=excluded.equity,
                    available_balance=excluded.available_balance,
                    daily_pnl=excluded.daily_pnl,
                    total_pnl=excluded.total_pnl,
                    peak_equity=excluded.peak_equity,
                    mode_profile=excluded.mode_profile,
                    consecutive_losses=excluded.consecutive_losses,
                    trades_today=excluded.trades_today,
                    last_trade_day=excluded.last_trade_day,
                    circuit_breaker_active=excluded.circuit_breaker_active,
                    updated_at=excluded.updated_at
                """,
                (
                    "paper_account",
                    state.equity,
                    state.available_balance,
                    state.daily_pnl,
                    state.total_pnl,
                    state.peak_equity,
                    state.mode_profile.value,
                    state.consecutive_losses,
                    state.trades_today,
                    state.last_trade_day,
                    int(state.circuit_breaker_active),
                    timestamp,
                ),
            )
            conn.execute("DELETE FROM open_positions")
            for position in positions:
                conn.execute(
                    """
                    INSERT INTO open_positions(
                        symbol, side, quantity, entry_price, stop_loss, take_profit_1, take_profit_2,
                        leverage, opened_at, highest_price, lowest_price, trailing_active,
                        partial_exit_done, closed
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        position.symbol,
                        position.side.value,
                        position.quantity,
                        position.entry_price,
                        position.stop_loss,
                        position.take_profit_1,
                        position.take_profit_2,
                        position.leverage,
                        position.opened_at.isoformat(),
                        position.highest_price,
                        position.lowest_price,
                        int(position.trailing_active),
                        int(position.partial_exit_done),
                        int(position.closed),
                    ),
                )

    def load_runtime_state(self) -> tuple[AccountState | None, list[Position]]:
        with self.connect() as conn:
            state_row = conn.execute(
                "SELECT * FROM runtime_state WHERE state_key = ?",
                ("paper_account",),
            ).fetchone()
            position_rows = conn.execute(
                "SELECT * FROM open_positions WHERE closed = 0"
            ).fetchall()

        account_state = None
        if state_row:
            account_state = AccountState(
                equity=state_row["equity"],
                available_balance=state_row["available_balance"],
                daily_pnl=state_row["daily_pnl"],
                total_pnl=state_row["total_pnl"],
                peak_equity=state_row["peak_equity"],
                mode_profile=ModeProfile(state_row["mode_profile"]),
                consecutive_losses=state_row["consecutive_losses"],
                trades_today=state_row["trades_today"],
                last_trade_day=state_row["last_trade_day"],
                circuit_breaker_active=bool(state_row["circuit_breaker_active"]),
            )

        positions: list[Position] = []
        for row in position_rows:
            position = Position(
                symbol=row["symbol"],
                side=SignalSide(row["side"]),
                quantity=row["quantity"],
                entry_price=row["entry_price"],
                stop_loss=row["stop_loss"],
                take_profit_1=row["take_profit_1"],
                take_profit_2=row["take_profit_2"],
                leverage=row["leverage"],
                opened_at=datetime.fromisoformat(row["opened_at"]),
                highest_price=row["highest_price"],
                lowest_price=row["lowest_price"],
                trailing_active=bool(row["trailing_active"]),
                partial_exit_done=bool(row["partial_exit_done"]),
                closed=bool(row["closed"]),
            )
            positions.append(position)
        return account_state, positions
