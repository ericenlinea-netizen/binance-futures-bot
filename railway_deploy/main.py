import requests
import time
import math
import os
import sys
import tempfile
from datetime import datetime

# ================= INSTANCIA ÚNICA =================
LOCK_FILE = os.path.join(tempfile.gettempdir(), "bot_trading.lock")

def verificar_instancia_unica():
    if os.path.exists(LOCK_FILE):
        try:
            with open(LOCK_FILE) as f:
                pid_viejo = int(f.read().strip())
            # Verifica si el proceso sigue activo
            os.kill(pid_viejo, 0)
            print(f"[LOCK] Bot ya corriendo (PID {pid_viejo}). Saliendo.")
            sys.exit(1)
        except (ProcessLookupError, ValueError):
            pass  # Proceso muerto, continúa
    os.makedirs(os.path.dirname(LOCK_FILE), exist_ok=True)
    with open(LOCK_FILE, "w") as f:
        f.write(str(os.getpid()))

import atexit
def liberar_lock():
    try:
        os.remove(LOCK_FILE)
    except:
        pass

atexit.register(liberar_lock)
verificar_instancia_unica()

# ================= TELEGRAM =================
TOKEN = os.environ.get("TELEGRAM_TOKEN", "8772294732:AAGU62SChVJfmwf9RpweG-inBGAjIDlMwms")
CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "5019372975")

def enviar_alerta(msg):
    try:
        requests.post(
            f"https://api.telegram.org/bot{TOKEN}/sendMessage",
            data={"chat_id": CHAT_ID, "text": msg, "parse_mode": "HTML"},
            timeout=10
        )
    except:
        pass

# ================= CONFIG =================
# OKX usa guion: BTC-USDT, ETH-USDT, etc.
# Pares seleccionados por mejor WR histórico. DOGE eliminado (peor en backtest).
symbols = ["BTC-USDT", "ETH-USDT", "BNB-USDT", "SOL-USDT", "ADA-USDT",
           "AVAX-USDT", "LINK-USDT", "LTC-USDT", "DOT-USDT", "POL-USDT"]

# ================= MODO PAPER TRADING =================
# True  = opera con dinero ficticio (sin órdenes reales)
# False = opera con dinero real en OKX
PAPER_TRADING    = True
CAPITAL_INICIAL  = 1000.0    # USDT virtuales al iniciar
RIESGO_POR_TRADE = 0.01      # 1% del capital por operación

capital_virtual  = CAPITAL_INICIAL
capital_sl_paper = 0.0       # cuánto se lleva el SL en paper
capital_tp_paper = 0.0       # cuánto se lleva el TP en paper

estado = False
entrada = 0.0
max_precio = 0.0
symbol_activo = None
unidades_paper = 0.0         # cantidad comprada en paper

racha_perdidas = 0
ganancia_acumulada = 0.0
operaciones_totales = 0
operaciones_ganadoras = 0

# ================= OKX API =================
# Intervalos OKX: 1m, 3m, 5m, 15m, 30m, 1H, 2H, 4H, 1D

def get_klines(symbol, interval, limit=50):
    """
    Retorna (cierres, altos, bajos, volumenes) en orden cronológico (más antiguo primero).
    OKX devuelve los datos con el más reciente primero, por eso hacemos reverse().
    """
    url = (
        f"https://www.okx.com/api/v5/market/candles"
        f"?instId={symbol}&bar={interval}&limit={limit}"
    )
    resp = requests.get(url, timeout=10).json()
    if resp.get("code") != "0":
        raise Exception(f"OKX error: {resp.get('msg')}")

    raw = resp["data"]
    raw.reverse()  # más antiguo primero

    # formato: [ts, open, high, low, close, vol, volCcy, volUsd, confirm]
    cierres   = [float(c[4]) for c in raw]
    altos     = [float(c[2]) for c in raw]
    bajos     = [float(c[3]) for c in raw]
    volumenes = [float(c[5]) for c in raw]
    return cierres, altos, bajos, volumenes

# ================= INDICADORES =================

def ema(valores, n):
    k = 2 / (n + 1)
    resultado = [valores[0]]
    for v in valores[1:]:
        resultado.append(v * k + resultado[-1] * (1 - k))
    return resultado

def rsi(cierres, n=14):
    ganancias, perdidas = [], []
    for i in range(1, len(cierres)):
        diff = cierres[i] - cierres[i-1]
        ganancias.append(max(diff, 0))
        perdidas.append(max(-diff, 0))
    if len(ganancias) < n:
        return 50.0
    ag = sum(ganancias[-n:]) / n
    ap = sum(perdidas[-n:]) / n
    if ap == 0:
        return 100.0
    return 100 - (100 / (1 + ag / ap))

def macd_vals(cierres):
    e12  = ema(cierres, 12)
    e26  = ema(cierres, 26)
    linea = [a - b for a, b in zip(e12, e26)]
    senal = ema(linea, 9)
    hist  = [l - s for l, s in zip(linea, senal)]
    return linea[-1], senal[-1], hist[-1], hist[-2] if len(hist) >= 2 else 0

def atr(altos, bajos, cierres, n=14):
    trs = []
    for i in range(1, len(cierres)):
        tr = max(
            altos[i] - bajos[i],
            abs(altos[i] - cierres[i-1]),
            abs(bajos[i] - cierres[i-1])
        )
        trs.append(tr)
    if len(trs) < n:
        return cierres[-1] * 0.002
    return sum(trs[-n:]) / n

def bollinger(cierres, n=20, dev=2):
    ventana = cierres[-n:] if len(cierres) >= n else cierres
    media = sum(ventana) / len(ventana)
    std = math.sqrt(sum((x - media)**2 for x in ventana) / len(ventana))
    return media, media + dev * std, media - dev * std

def tendencia_ema(cierres):
    e9  = ema(cierres, 9)[-1]
    e21 = ema(cierres, 21)[-1]
    return e9 > e21

def slope_ema(cierres, n=9):
    e = ema(cierres, n)
    return e[-1] > e[-3]

def volumen_alto(volumenes, n=20):
    if len(volumenes) < n:
        return False
    return volumenes[-1] > (sum(volumenes[-n:-1]) / (n - 1)) * 1.1

def detectar_pullback(cierres):
    if len(cierres) < 7:
        return False
    # Pullback clásico: subida, retroceso, retoma
    subida    = cierres[-6] < cierres[-5] < cierres[-4]
    retroceso = cierres[-4] > cierres[-3]
    retoma    = cierres[-1] > cierres[-2]
    if subida and retroceso and retoma:
        return True
    # Alternativa: momentum sostenido sobre EMA9 sin retroceso brusco
    e9 = ema(cierres, 9)
    sobre_ema = cierres[-1] > e9[-1] and cierres[-2] > e9[-2]
    subida_suave = cierres[-1] > cierres[-3] > cierres[-5]
    return sobre_ema and subida_suave

def patron_vela_alcista(cierres, altos, bajos):
    o = cierres[-2]
    c = cierres[-1]
    h = altos[-1]
    l = bajos[-1]
    rango = h - l
    if rango == 0:
        return False
    mecha_inf = (min(o, c) - l) / rango
    cuerpo    = abs(c - o) / rango
    return c > o and mecha_inf > 0.3 and cuerpo > 0.4

# ================= SCORE =================

def score_completo(cierres, altos, bajos, volumenes):
    s = 0
    detalles = []

    # Tendencia EMA 9/21 (2 pts)
    if tendencia_ema(cierres):
        s += 2; detalles.append("EMA✅")
    else:
        detalles.append("EMA❌")

    # Slope EMA acelerando (1 pt)
    if slope_ema(cierres):
        s += 1; detalles.append("Slope✅")

    # Pullback sobre EMA (2 pts)
    if detectar_pullback(cierres):
        s += 2; detalles.append("PB✅")
    else:
        detalles.append("PB❌")

    # RSI zona óptima 40-72 (2 pts), penaliza si >75
    r = rsi(cierres)
    if 40 <= r <= 72:
        s += 2; detalles.append(f"RSI{r:.0f}✅")
    elif r > 75:
        s -= 1; detalles.append(f"RSI{r:.0f}⚠️")
    else:
        detalles.append(f"RSI{r:.0f}❌")

    # MACD linea > señal (1 pt) + histograma creciendo (1 pt)
    l_macd, senal_macd, hist_now, hist_prev = macd_vals(cierres)
    if l_macd > senal_macd:
        s += 1; detalles.append("MACD✅")
    if hist_now > 0 and hist_now > hist_prev:
        s += 1; detalles.append("Hist✅")

    # Volumen confirmando (2 pts)
    if volumen_alto(volumenes):
        s += 2; detalles.append("Vol✅")
    else:
        detalles.append("Vol❌")

    # Bollinger: cruce sobre banda media (1 pt)
    bb_med, _, _ = bollinger(cierres)
    if cierres[-1] > bb_med and cierres[-2] <= bb_med:
        s += 1; detalles.append("BB✅")

    # Patrón de vela alcista (1 pt)
    if patron_vela_alcista(cierres, altos, bajos):
        s += 1; detalles.append("Vela✅")

    # Momentum positivo 0.05-1% en últimas 5 velas (1 pt)
    cambio5 = (cierres[-1] - cierres[-5]) / cierres[-5]
    if 0.0005 < cambio5 < 0.01:
        s += 1; detalles.append("Mom✅")

    return s, detalles, r

# ================= MULTI-TIMEFRAME =================

def confirmar_multitf(symbol):
    c1m, a1m, b1m, v1m = get_klines(symbol, "1m", 50)
    c5m, _, _, _       = get_klines(symbol, "5m", 50)
    c15m, _, _, _      = get_klines(symbol, "15m", 30)

    # 1m es muy ruidoso: basta con 5m Y 15m alcistas (2 de 3)
    tf_ok = tendencia_ema(c5m) and tendencia_ema(c15m)
    rsi_ok = rsi(c1m) < 78 and rsi(c5m) < 75

    return tf_ok and rsi_ok, c1m, a1m, b1m, v1m

# ================= INICIO =================
modo_str = "📝 PAPER TRADING (sin dinero real)" if PAPER_TRADING else "💸 REAL TRADING"
enviar_alerta(
    "📊 <b>BOT CUANTITATIVO v2 ACTIVO</b>\n"
    f"⏰ {datetime.now().strftime('%H:%M:%S')}\n"
    f"📡 Exchange: OKX — {modo_str}\n"
    + (f"💰 Capital virtual: ${capital_virtual:.2f} USDT\n" if PAPER_TRADING else "")
    + f"🔍 Pares: {', '.join(symbols)}"
)

# ================= LOOP PRINCIPAL =================
ultimo_reporte = 0

while True:
    try:
        # ===== REPORTE DE ESTADO CADA 10 MIN =====
        ahora = time.time()
        if ahora - ultimo_reporte >= 600:
            try:
                btc5r, _, _, _ = get_klines("BTC-USDT", "5m", 50)
                btc15r, _, _, _ = get_klines("BTC-USDT", "15m", 30)
                btc_trend = tendencia_ema(btc5r) and tendencia_ema(btc15r)
                btc_rsi_r = rsi(btc5r)
                mercado = "ALCISTA" if btc_trend else "BAJISTA"
                emoji_m = "📈" if btc_trend else "📉"
                wr = (operaciones_ganadoras / operaciones_totales * 100) if operaciones_totales else 0
                rentab = ((capital_virtual - CAPITAL_INICIAL) / CAPITAL_INICIAL * 100) if PAPER_TRADING else 0
                paper_reporte = f"\n💰 Capital: ${capital_virtual:.2f} ({'+' if rentab>=0 else ''}{rentab:.1f}%)" if PAPER_TRADING else ""
                enviar_alerta(
                    f"{emoji_m} <b>ESTADO DEL BOT</b> — {datetime.now().strftime('%H:%M')}\n"
                    f"Mercado: {mercado}\n"
                    f"RSI BTC 5m: {btc_rsi_r:.0f}\n"
                    f"Operaciones: {operaciones_totales}  WR: {wr:.1f}%\n"
                    f"Racha perdidas: {racha_perdidas}\n"
                    f"{'En posicion: ' + symbol_activo if estado else 'Sin posicion abierta'}"
                    + paper_reporte
                )
            except:
                pass
            ultimo_reporte = ahora

        # ===== GESTIÓN DE POSICIÓN ABIERTA =====
        if estado:
            cierres, altos, bajos, _ = get_klines(symbol_activo, "1m", 20)
            precio = cierres[-1]
            ganancia = precio - entrada
            ganancia_pct = (ganancia / entrada) * 100

            if precio > max_precio:
                max_precio = precio

            atr_val = atr(altos, bajos, cierres)

            sl_estructura = min(cierres[-5:])
            sl_atr        = entrada - (1.5 * atr_val)
            sl_maximo     = entrada - (0.002 * entrada)
            sl = max(sl_estructura, sl_atr, sl_maximo)

            riesgo = entrada - sl
            tp1 = entrada + (riesgo * 1.5)
            tp2 = entrada + (riesgo * 2.5)

            trailing_factor = 0.4 if ganancia_pct > 0.3 else 0.5
            trailing = (max_precio - entrada) * trailing_factor

            rsi_act = rsi(cierres)

            def cerrar(razon, emoji):
                global estado, racha_perdidas, operaciones_totales
                global operaciones_ganadoras, ganancia_acumulada
                global capital_virtual, unidades_paper

                operaciones_totales += 1
                ganando = ganancia > 0
                if ganando:
                    operaciones_ganadoras += 1
                    ganancia_acumulada += ganancia
                    racha_perdidas = 0
                else:
                    racha_perdidas += 1

                wr = (operaciones_ganadoras / operaciones_totales * 100) if operaciones_totales else 0
                signo = "+" if ganando else ""

                # Paper trading: actualizar capital virtual
                paper_info = ""
                if PAPER_TRADING and unidades_paper > 0:
                    pnl_usdt  = (precio - entrada) * unidades_paper
                    capital_virtual += pnl_usdt
                    signo_p   = "+" if pnl_usdt >= 0 else ""
                    paper_info = (
                        f"\n💼 PnL USDT: {signo_p}${pnl_usdt:.2f}\n"
                        f"🏦 Capital virtual: ${capital_virtual:.2f}"
                    )
                    unidades_paper = 0.0

                prefijo = "📝 PAPER — " if PAPER_TRADING else ""
                enviar_alerta(
                    f"{emoji} <b>{prefijo}{razon} — {symbol_activo}</b>\n"
                    f"💵 Precio: {precio:.4f}\n"
                    f"📈 PnL: {signo}{ganancia:.4f} ({signo}{ganancia_pct:.3f}%)\n"
                    f"📊 RSI: {rsi_act:.1f}\n"
                    f"🏆 WinRate: {wr:.1f}% ({operaciones_ganadoras}/{operaciones_totales})"
                    + paper_info
                )
                estado = False

            if precio <= sl:
                cerrar("SL", "🛑")
            elif precio >= tp2:
                cerrar("TP2 🎯", "💰")
            elif precio >= tp1 and rsi_act > 78:
                cerrar("TP1+RSI", "💰")
            elif max_precio - precio >= trailing and ganancia > 0:
                cerrar("TRAILING", "💰")

            time.sleep(5)
            continue

        # ===== PROTECCIONES =====
        if ganancia_acumulada >= 5:
            enviar_alerta("🛑 <b>PROTECCIÓN DE GANANCIA</b>\nPausa 2 min")
            time.sleep(120)
            ganancia_acumulada = 0
            continue

        if racha_perdidas >= 2:
            enviar_alerta(f"⛔ <b>PAUSA POR RACHA</b>\n{racha_perdidas} pérdidas seguidas")
            time.sleep(90)
            racha_perdidas = 0
            continue

        # ===== FILTRO BTC: 5m Y 15m alcistas (1m demasiado ruidoso) =====
        btc_5m, _, _, _  = get_klines("BTC-USDT", "5m",  50)
        btc_15m, _, _, _ = get_klines("BTC-USDT", "15m", 30)

        btc_ok = tendencia_ema(btc_5m) and tendencia_ema(btc_15m)
        if not btc_ok or rsi(btc_5m) > 82:
            time.sleep(5)
            continue

        # ===== SCAN =====
        mejor = None
        mejor_score = 0
        mejor_detalles = []
        mejor_rsi = 0.0

        for symbol in symbols:
            if symbol == "BTC-USDT":
                continue
            try:
                ok, c1m, a1m, b1m, v1m = confirmar_multitf(symbol)
                if not ok:
                    continue

                precio = c1m[-1]
                atr_v = atr(a1m, b1m, c1m)

                if atr_v < precio * 0.0003:
                    continue

                if precio >= max(c1m[-3:]) * 0.9997:
                    continue

                s, det, r = score_completo(c1m, a1m, b1m, v1m)

                if s > mejor_score:
                    mejor_score = s
                    mejor = (symbol, precio, c1m, a1m, b1m, v1m)
                    mejor_detalles = det
                    mejor_rsi = r

            except:
                continue

        # ===== ENTRADA =====
        if mejor and mejor_score >= 9:
            sym, prec, c1m, a1m, b1m, v1m = mejor
            atr_v = atr(a1m, b1m, c1m)

            sl_est  = min(c1m[-5:])
            sl_atr  = prec - (1.5 * atr_v)
            sl_max  = prec - (0.002 * prec)
            sl = max(sl_est, sl_atr, sl_max)

            riesgo = prec - sl
            riesgo_pct = riesgo / prec
            # Mínimo 0.08% y máximo 0.3% de riesgo — evita micro-SLs en DOGE/POL/ADA
            if riesgo <= 0 or riesgo_pct < 0.0008 or riesgo_pct > 0.003:
                time.sleep(5)
                continue

            tp1 = prec + riesgo * 1.5
            tp2 = prec + riesgo * 2.5
            rr  = (tp2 - prec) / riesgo

            symbol_activo = sym
            entrada       = prec
            max_precio    = prec
            estado        = True

            # Paper trading: calcular unidades y capital invertido
            paper_entry_info = ""
            if PAPER_TRADING:
                monto_riesgo   = capital_virtual * RIESGO_POR_TRADE
                unidades_paper = monto_riesgo / (prec - sl) if (prec - sl) > 0 else 0
                invertido      = unidades_paper * prec
                paper_entry_info = (
                    f"\n📝 PAPER — Unidades: {unidades_paper:.4f}\n"
                    f"💰 Invertido virtual: ${invertido:.2f} / Capital: ${capital_virtual:.2f}"
                )

            prefijo_entry = "📝 PAPER — " if PAPER_TRADING else ""
            enviar_alerta(
                f"🚀 <b>{prefijo_entry}ENTRY — {sym}</b>\n"
                f"💵 Precio: {prec:.4f}\n"
                f"🎯 Score: {mejor_score}/14\n"
                f"📉 SL: {sl:.4f}\n"
                f"🎯 TP1: {tp1:.4f}  TP2: {tp2:.4f}\n"
                f"📊 R:R = 1:{rr:.1f}  RSI: {mejor_rsi:.1f}\n"
                f"🔍 {' | '.join(mejor_detalles)}"
                + paper_entry_info
            )

        time.sleep(5)

    except Exception as e:
        print(f"[{datetime.now().strftime('%H:%M:%S')}] Error: {e}")
        time.sleep(5)
