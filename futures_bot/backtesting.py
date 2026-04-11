from __future__ import annotations

import csv
from datetime import UTC, datetime
from pathlib import Path

from futures_bot.config import Settings
from futures_bot.models import BacktestTrade, Candle, MarketSnapshot, SignalSide
from futures_bot.portfolio_manager import PortfolioManager
from futures_bot.risk_engine import RiskEngine
from futures_bot.strategy_engine import StrategyEngine
from futures_bot.models import AccountState
from futures_bot.utils.indicators import annualized_sharpe, max_drawdown


def load_csv(path: str) -> list[Candle]:
    candles: list[Candle] = []
    with open(path, newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            open_time = datetime.fromisoformat(row["open_time"]).astimezone(UTC)
            close_time = datetime.fromisoformat(row.get("close_time", row["open_time"])).astimezone(UTC)
            candles.append(
                Candle(
                    open_time=open_time,
                    open=float(row["open"]),
                    high=float(row["high"]),
                    low=float(row["low"]),
                    close=float(row["close"]),
                    volume=float(row.get("volume", 0.0)),
                    close_time=close_time,
                )
            )
    return candles


def _timeframe_ratio(base_tf: str, confirm_tf: str) -> int:
    mapping = {"5m": 5, "15m": 15, "1h": 60}
    return max(1, mapping.get(confirm_tf, 15) // mapping.get(base_tf, 5))


def run_backtest(settings: Settings, data: dict[str, list[Candle]]) -> dict:
    strategy = StrategyEngine(settings.min_signal_score)
    risk = RiskEngine(settings)
    portfolio = PortfolioManager(settings)
    account = AccountState(settings.initial_equity, settings.initial_equity)
    trades: list[BacktestTrade] = []
    equity_curve = [account.equity]
    returns: list[float] = []
    ratio = _timeframe_ratio(settings.base_timeframe, settings.confirm_timeframe)

    for symbol, candles in data.items():
        for idx in range(210, len(candles)):
            window = candles[: idx + 1]
            confirm = window[::ratio]
            snapshot = MarketSnapshot(symbol, settings.base_timeframe, settings.confirm_timeframe, window, confirm)
            closes = [c.close for c in window]
            if len(closes) >= 2:
                portfolio.register_return(symbol, (closes[-1] - closes[-2]) / closes[-2])

            position = portfolio.positions.get(symbol)
            if position and not position.closed:
                reason, quantity = portfolio.evaluate_exit(symbol, closes[-1])
                if strategy.exit_on_trend_change(snapshot, position.side):
                    reason = reason or "trend_change"
                    quantity = quantity or position.quantity
                if reason and quantity > 0:
                    slippage = settings.slippage_bps / 10_000
                    exit_price = closes[-1] * (1 - slippage if position.side is SignalSide.LONG else 1 + slippage)
                    direction = 1 if position.side is SignalSide.LONG else -1
                    pnl = ((exit_price - position.entry_price) * quantity * direction)
                    fees = (position.entry_price * quantity * settings.fee_rate) + (exit_price * quantity * settings.fee_rate)
                    pnl -= fees
                    account.available_balance += (position.entry_price * quantity) / max(position.leverage, 1)
                    risk.register_realized_pnl(account, pnl)
                    if quantity >= position.quantity or reason != "partial_tp":
                        portfolio.close_position(symbol)
                    else:
                        position.quantity -= quantity
                    trades.append(
                        BacktestTrade(
                            symbol=symbol,
                            side=position.side,
                            entry_time=position.opened_at,
                            exit_time=window[-1].close_time,
                            entry_price=position.entry_price,
                            exit_price=exit_price,
                            quantity=quantity,
                            pnl=pnl,
                            pnl_pct=pnl / max(account.equity, 1.0),
                            fee_paid=fees,
                            reason=reason,
                        )
                    )
                    equity_curve.append(account.equity)
                    returns.append(pnl / max(account.equity, 1.0))
                continue

            signal = strategy.evaluate(snapshot)
            if not signal:
                continue
            if portfolio.correlation_too_high(symbol, [p.symbol for p in portfolio.open_positions()]):
                continue
            allowed, _ = risk.validate_signal(account, signal, portfolio.open_positions())
            if not allowed:
                continue
            quantity, leverage = risk.calculate_position_size(account, signal)
            if quantity <= 0:
                continue
            entry_slippage = settings.slippage_bps / 10_000
            entry_price = closes[-1] * (1 + entry_slippage if signal.side is SignalSide.LONG else 1 - entry_slippage)
            account.trades_today += 1
            account.available_balance -= (entry_price * quantity) / max(leverage, 1)
            portfolio.add_position(
                portfolio.build_position(
                    symbol=symbol,
                    side=signal.side,
                    quantity=quantity,
                    entry_price=entry_price,
                    stop_loss=signal.stop_loss,
                    tp1=signal.take_profit_1,
                    tp2=signal.take_profit_2,
                    leverage=leverage,
                )
            )

    gross_profit = sum(trade.pnl for trade in trades if trade.pnl > 0)
    gross_loss = abs(sum(trade.pnl for trade in trades if trade.pnl < 0))
    win_rate = (sum(1 for trade in trades if trade.pnl > 0) / len(trades)) if trades else 0.0
    expectancy = (sum(trade.pnl for trade in trades) / len(trades)) if trades else 0.0
    profit_factor = (gross_profit / gross_loss) if gross_loss else 0.0

    return {
        "trades": trades,
        "equity_curve": equity_curve,
        "final_equity": account.equity,
        "sharpe": annualized_sharpe(returns, periods_per_year=365 * 24 * 12),
        "max_drawdown": max_drawdown(equity_curve),
        "profit_factor": profit_factor,
        "expectancy": expectancy,
        "win_rate": win_rate,
    }


def _build_ascii_equity(equity_curve: list[float], width: int = 50) -> str:
    if not equity_curve:
        return ""
    low = min(equity_curve)
    high = max(equity_curve)
    spread = max(high - low, 1e-9)
    bars = []
    for equity in equity_curve[-width:]:
        normalized = int(((equity - low) / spread) * 8)
        bars.append(" .:-=+*#%@"[normalized])
    return "".join(bars)


def run_backtest_cli(settings: Settings, data_path: str | None) -> None:
    if not data_path:
        raise SystemExit("Provide --data with a CSV or directory of CSV files")
    source = Path(data_path)
    dataset: dict[str, list[Candle]] = {}
    if source.is_dir():
        for csv_file in source.glob("*.csv"):
            dataset[csv_file.stem.upper()] = load_csv(str(csv_file))
    else:
        dataset[source.stem.upper()] = load_csv(str(source))
    results = run_backtest(settings, dataset)
    print(f"Final equity: {results['final_equity']:.2f}")
    print(f"Sharpe: {results['sharpe']:.2f}")
    print(f"Max drawdown: {results['max_drawdown']:.2%}")
    print(f"Profit factor: {results['profit_factor']:.2f}")
    print(f"Expectancy: {results['expectancy']:.4f}")
    print(f"Win rate: {results['win_rate']:.2%}")
    print(f"Trades: {len(results['trades'])}")
    print(f"Equity curve: { _build_ascii_equity(results['equity_curve']) }")
