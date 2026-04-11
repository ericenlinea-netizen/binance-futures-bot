from __future__ import annotations

from dataclasses import replace
from itertools import product
from pathlib import Path

from futures_bot.backtesting import load_csv, run_backtest
from futures_bot.config import Settings


def walk_forward_analysis(settings: Settings, candles_by_symbol: dict) -> list[dict]:
    results: list[dict] = []
    for symbol, candles in candles_by_symbol.items():
        split_one = int(len(candles) * 0.5)
        split_two = int(len(candles) * 0.75)
        windows = [
            (candles[:split_one], candles[split_one:split_two]),
            (candles[:split_two], candles[split_two:]),
        ]
        for train, test in windows:
            if len(train) < 220 or len(test) < 220:
                continue
            test_results = run_backtest(settings, {symbol: test})
            results.append(
                {
                    "symbol": symbol,
                    "train_size": len(train),
                    "test_size": len(test),
                    "final_equity": test_results["final_equity"],
                    "sharpe": test_results["sharpe"],
                    "max_drawdown": test_results["max_drawdown"],
                }
            )
    return results


def grid_search(settings: Settings, candles_by_symbol: dict) -> list[dict]:
    combinations = product(
        [65.0, 70.0, 75.0],
        [0.005, 0.0075, 0.01],
        [2.0, 3.0, 4.0],
    )
    rankings: list[dict] = []
    for min_score, risk_per_trade, slippage_bps in combinations:
        candidate = replace(
            settings,
            min_signal_score=min_score,
            risk_per_trade=risk_per_trade,
            slippage_bps=slippage_bps,
        )
        results = run_backtest(candidate, candles_by_symbol)
        rankings.append(
            {
                "min_score": min_score,
                "risk_per_trade": risk_per_trade,
                "slippage_bps": slippage_bps,
                "final_equity": results["final_equity"],
                "sharpe": results["sharpe"],
                "max_drawdown": results["max_drawdown"],
                "profit_factor": results["profit_factor"],
            }
        )
    rankings.sort(key=lambda item: (item["sharpe"], item["final_equity"], -item["max_drawdown"]), reverse=True)
    return rankings


def run_optimization_cli(settings: Settings, data_path: str | None) -> None:
    if not data_path:
        raise SystemExit("Provide --data with a CSV or directory of CSV files")
    source = Path(data_path)
    candles_by_symbol = {}
    if source.is_dir():
        for csv_file in source.glob("*.csv"):
            candles_by_symbol[csv_file.stem.upper()] = load_csv(str(csv_file))
    else:
        candles_by_symbol[source.stem.upper()] = load_csv(str(source))

    rankings = grid_search(settings, candles_by_symbol)
    print("Top parameter sets:")
    for row in rankings[:5]:
        print(row)

    print("\nWalk-forward:")
    for row in walk_forward_analysis(settings, candles_by_symbol):
        print(row)
