from __future__ import annotations

from futures_bot.config import Settings
from futures_bot.models import SignalSide, TradeSignal


class DecisionEngine:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def market_bias(self, diagnostics: dict[str, dict]) -> SignalSide:
        btc = diagnostics.get("BTCUSDT")
        if not btc:
            return SignalSide.FLAT
        blockers = set(btc.get("blockers", []))
        score = float(btc.get("score", 0.0))
        side = SignalSide(btc.get("side", SignalSide.FLAT.value))
        if "no_side_alignment" in blockers or score < self.settings.market_bias_min_score:
            return SignalSide.FLAT
        return side

    def signal_quality(self, signal: TradeSignal, diagnostics: dict[str, dict]) -> float:
        diag = diagnostics.get(signal.symbol, {})
        volatility_ratio = signal.atr / max(signal.entry_price, 1e-9)
        quality = signal.score
        quality += min(signal.trend_strength * 2500, 15)
        quality += min(volatility_ratio * 2500, 15)
        if "macd_momentum" in signal.reasons:
            quality += 8
        if "volume_confirmation" in signal.reasons:
            quality += 5
        if "partial_multi_timeframe_confirmed" in signal.reasons:
            quality -= 4
        if diag.get("blockers"):
            quality -= 25
        bias = self.market_bias(diagnostics)
        if bias is not SignalSide.FLAT:
            quality += 8 if signal.side is bias else -20
        return quality

    def is_regime_allowed(self, signal: TradeSignal, diagnostics: dict[str, dict]) -> tuple[bool, str]:
        if not self.settings.enable_market_regime_filter:
            return True, "ok"
        bias = self.market_bias(diagnostics)
        if bias is SignalSide.FLAT:
            return True, "ok"
        if signal.side is not bias:
            return False, "market_regime_conflict"
        return True, "ok"

    def rank(self, signals: list[TradeSignal], diagnostics: dict[str, dict]) -> list[TradeSignal]:
        return sorted(
            signals,
            key=lambda signal: self.signal_quality(signal, diagnostics),
            reverse=True,
        )
