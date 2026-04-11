from __future__ import annotations

import argparse
import asyncio

from futures_bot.backtesting import run_backtest_cli
from futures_bot.bot import TradingBot
from futures_bot.config import Settings
from futures_bot.optimization import run_optimization_cli


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Professional Binance Futures trading system")
    parser.add_argument("command", choices=["run", "backtest", "optimize"])
    parser.add_argument("--env-file", default=".env")
    parser.add_argument("--data")
    return parser


async def async_main() -> None:
    args = build_parser().parse_args()
    settings = Settings.load(args.env_file)

    if args.command == "run":
        bot = TradingBot(settings)
        await bot.run()
        return

    if args.command == "backtest":
        run_backtest_cli(settings, args.data)
        return

    if args.command == "optimize":
        run_optimization_cli(settings, args.data)
        return


if __name__ == "__main__":
    asyncio.run(async_main())
