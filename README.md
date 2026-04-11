# Binance Futures Algo System

Sistema algorítmico profesional en Python para Binance Futures USDT-M, orientado a cuentas pequeñas y crecimiento progresivo con riesgo estricto.

## Arquitectura

- `futures_bot/data_engine.py`: acceso a Binance Futures y snapshots multi-timeframe.
- `futures_bot/strategy_engine.py`: scoring multi-factor EMA 50/200, RSI, MACD, ATR y filtros de volatilidad/rango.
- `futures_bot/risk_engine.py`: riesgo por trade, drawdown diario/total, sizing dinámico y circuit breaker.
- `futures_bot/portfolio_manager.py`: máximo 2 posiciones, salidas parciales, trailing stop y control de correlación.
- `futures_bot/execution_engine.py`: market/limit, control de slippage y reintentos.
- `futures_bot/monitoring.py`: logs y Telegram.
- `futures_bot/persistence.py`: registro SQLite de señales, trades y equity.
- `futures_bot/backtesting.py`: simulación con fees/slippage, Sharpe, drawdown, profit factor, expectancy y equity curve.
- `futures_bot/optimization.py`: grid search, train/test split y walk-forward analysis.

## Características clave

- Async end-to-end para escaneo en tiempo real.
- Paper trading y live trading.
- Riesgo por trade entre `0.5%` y `1%`.
- Máximo `3` trades por día.
- Máximo `2` posiciones simultáneas.
- Stop loss dinámico por ATR.
- Take profit parcial `50% + 50%`.
- Trailing stop automático.
- Cierre por cambio de tendencia.
- Modo conservador tras racha de pérdidas.
- Modo agresivo controlado cuando el equity mejora.
- Protección contra sobreapalancamiento con máximo `5x`.

## Preparación

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e .
cp .env.example .env
```

Ajusta `.env` con tus claves y mantén `BOT_MODE=paper` hasta validar el sistema.

## Ejecutar

Paper o live:

```bash
python main.py run --env-file .env
```

Backtest con un CSV o carpeta de CSVs. Cada archivo debe tener columnas:
`open_time,open,high,low,close,volume[,close_time]`

```bash
python main.py backtest --env-file .env --data ./data
```

Optimización:

```bash
python main.py optimize --env-file .env --data ./data
```

## Recomendación operativa

- Empieza en `paper`.
- Usa Binance Futures Testnet antes de pasar a live.
- Mantén el riesgo por trade en `0.5%` a `0.75%` para cuentas de `$100-$500`.
- No aumentes apalancamiento por encima de `3x` salvo que el backtest y el walk-forward lo respalden.

## VPS

Usa el script `start_production.sh` y ejecútalo con `screen`, `tmux` o `systemd`.

## Railway

- Sube este proyecto a un repositorio Git.
- En Railway crea un nuevo proyecto desde GitHub.
- Configura las variables desde `.env.example`.
- Railway inyecta `PORT` automáticamente y el bot expone `/health` y `/status`.
- El comando de arranque ya está definido en `Procfile` y `railway.json`.
