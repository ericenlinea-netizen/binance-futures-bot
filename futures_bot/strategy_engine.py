from __future__ import annotations

from futures_bot.models import MarketSnapshot, SignalSide, TradeSignal
from futures_bot.utils.indicators import atr, ema, macd, rsi, slope


class StrategyEngine:
    def __init__(self, min_score: float = 70.0) -> None:
        self.min_score = min_score

    def diagnostics(self, snapshot: MarketSnapshot) -> dict | None:
        base = snapshot.base_candles
        confirm = snapshot.confirm_candles
        if len(base) < 210 or len(confirm) < 210:
            return None

        closes = [c.close for c in base]
        highs = [c.high for c in base]
        lows = [c.low for c in base]
        volumes = [c.volume for c in base]
        confirm_closes = [c.close for c in confirm]

        ema50 = ema(closes, 50)
        ema200 = ema(closes, 200)
        confirm_ema50 = ema(confirm_closes, 50)
        confirm_ema200 = ema(confirm_closes, 200)
        latest_rsi = rsi(closes)
        macd_line, macd_signal, macd_hist = macd(closes)
        latest_atr = atr(highs, lows, closes)

        trend_up = closes[-1] > ema50[-1] > ema200[-1]
        trend_down = closes[-1] < ema50[-1] < ema200[-1]
        confirm_up = confirm_closes[-1] > confirm_ema50[-1] > confirm_ema200[-1]
        confirm_down = confirm_closes[-1] < confirm_ema50[-1] < confirm_ema200[-1]
        volatility_ratio = latest_atr / closes[-1] if closes[-1] else 0.0
        ema_gap_ratio = abs(ema50[-1] - ema200[-1]) / closes[-1]
        price_slope = slope(closes, 8)
        avg_volume = sum(volumes[-20:]) / 20
        volume_boost = volumes[-1] / avg_volume if avg_volume else 0.0

        blockers: list[str] = []
        if volatility_ratio < 0.0012:
            blockers.append("low_volatility")
        if ema_gap_ratio < 0.0015 and abs(price_slope) < latest_atr * 0.03:
            blockers.append("range_market")

        score = 0.0
        reasons: list[str] = []

        if trend_up or trend_down:
            score += 25
            reasons.append("trend_aligned")
        if confirm_up or confirm_down:
            score += 20
            reasons.append("multi_timeframe_confirmed")
        elif (trend_up and confirm_closes[-1] > confirm_ema50[-1]) or (
            trend_down and confirm_closes[-1] < confirm_ema50[-1]
        ):
            score += 10
            reasons.append("partial_multi_timeframe_confirmed")
        if 48 <= latest_rsi <= 68 and trend_up:
            score += 15
            reasons.append("rsi_bullish")
        if 32 <= latest_rsi <= 52 and trend_down:
            score += 15
            reasons.append("rsi_bearish")
        if (macd_line > macd_signal and macd_hist > 0 and trend_up) or (
            macd_line < macd_signal and macd_hist < 0 and trend_down
        ):
            score += 20
            reasons.append("macd_momentum")
        if volatility_ratio >= 0.003:
            score += 10
            reasons.append("healthy_volatility")
        if volume_boost > 1.05:
            score += 10
            reasons.append("volume_confirmation")

        side = SignalSide.FLAT
        if trend_up and confirm_up and macd_line >= macd_signal:
            side = SignalSide.LONG
        elif trend_down and confirm_down and macd_line <= macd_signal:
            side = SignalSide.SHORT
        elif trend_up and confirm_closes[-1] > confirm_ema50[-1] and macd_hist >= -0.02:
            side = SignalSide.LONG
        elif trend_down and confirm_closes[-1] < confirm_ema50[-1] and macd_hist <= 0.02:
            side = SignalSide.SHORT
        if side is SignalSide.FLAT:
            blockers.append("no_side_alignment")
        if score < self.min_score:
            blockers.append("score_below_threshold")

        return {
            "symbol": snapshot.symbol,
            "side": side.value,
            "score": min(score, 100.0),
            "reasons": reasons,
            "blockers": blockers,
            "entry_price": closes[-1],
            "atr": latest_atr,
            "trend_strength": ema_gap_ratio,
        }

    def evaluate(self, snapshot: MarketSnapshot) -> TradeSignal | None:
        diag = self.diagnostics(snapshot)
        if not diag:
            return None
        if diag["blockers"] or diag["side"] == SignalSide.FLAT.value:
            return None

        entry = diag["entry_price"]
        latest_atr = diag["atr"]
        side = SignalSide(diag["side"])
        stop_distance = latest_atr * 1.6
        if side is SignalSide.LONG:
            stop_loss = entry - stop_distance
            take_profit_1 = entry + (latest_atr * 1.8)
            take_profit_2 = entry + (latest_atr * 3.0)
        else:
            stop_loss = entry + stop_distance
            take_profit_1 = entry - (latest_atr * 1.8)
            take_profit_2 = entry - (latest_atr * 3.0)

        return TradeSignal(
            symbol=snapshot.symbol,
            side=side,
            score=diag["score"],
            reasons=diag["reasons"],
            entry_price=entry,
            atr=latest_atr,
            stop_loss=stop_loss,
            take_profit_1=take_profit_1,
            take_profit_2=take_profit_2,
            trend_strength=diag["trend_strength"],
        )

    def exit_on_trend_change(self, snapshot: MarketSnapshot, side: SignalSide) -> bool:
        closes = [c.close for c in snapshot.base_candles]
        ema50 = ema(closes, 50)
        ema200 = ema(closes, 200)
        if side is SignalSide.LONG:
            return closes[-1] < ema50[-1] or ema50[-1] < ema200[-1]
        if side is SignalSide.SHORT:
            return closes[-1] > ema50[-1] or ema50[-1] > ema200[-1]
        return False
