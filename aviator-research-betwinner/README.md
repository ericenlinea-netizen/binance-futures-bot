# Aviator Research Betwinner

Proyecto independiente para estudiar entradas experimentales a `1.5x` en Aviator usando Betwinner.

## Que hace

- Captura rondas automaticamente desde Betwinner usando un content script.
- Guarda las rondas localmente en `chrome.storage.local`.
- Calcula metricas basicas para investigacion:
  - total de rondas
  - hit rate a `1.5x`
  - promedio
  - racha baja actual
  - distribucion por rangos
- Permite exportar los datos a `JSON` y `CSV`.
- Tiene carga manual de respaldo por si alguna ronda no se detecta sola.

## Estructura

- `chrome-extension/`
  - extension Chrome standalone

## Como cargar la extension

1. Abrir `chrome://extensions`.
2. Activar `Modo de desarrollador`.
3. Pulsar `Cargar descomprimida`.
4. Seleccionar la carpeta:
   `C:\Users\peren\Downloads\aviator-signal-bot-export\aviator-research-betwinner\chrome-extension`

## Flujo recomendado

1. Abrir Betwinner y entrar a Aviator.
2. Dejar correr varias rondas.
3. Abrir la extension y verificar que el total aumente.
4. Exportar a JSON o CSV.
5. Analizar los datos fuera de la extension o en una fase posterior del proyecto.

## Notas

- Este proyecto no comparte configuracion con el repositorio anterior.
- Los datos quedan almacenados en la extension nueva, no en la extension vieja.
- Si tienes otra extension de Aviator activa, apagale temporalmente para evitar duplicados.
