/**
 * Content Script - ISOLATED world
 * 1. Relays WebSocket captures from injector.js to background
 * 2. Injects a floating panel on supported Aviator sites for 1-tap round registration
 */
(function () {
  "use strict";

  // ─── Relay WebSocket captures from MAIN world ────────────────────────────
  document.addEventListener("__aviator_round", (event) => {
    const multiplier = event.detail?.multiplier;
    if (!multiplier || isNaN(multiplier)) return;
    // Use "injector" as source so background.js can distinguish from CDP events
    const source = event.detail?.source || "injector";
    try {
      if (!chrome.runtime?.id) return; // context invalidated guard
      chrome.runtime.sendMessage(
        { type: "ROUND_CAPTURED", multiplier, source },
        () => { if (chrome.runtime.lastError) { /* ignore */ } }
      );
    } catch { /* extension reloaded — silently ignore */ }
  });

  const SUPPORTED_HOSTS = ["betwinner", "melbet", "stake"];

  // ─── Only inject the floating panel on supported Aviator pages ───────────
  if (!SUPPORTED_HOSTS.some((host) => location.hostname.includes(host))) return;

  // ─── State ────────────────────────────────────────────────────────────────
  let lastSignal = null;
  let panelVisible = true;
  let pollTimer = null;
  let autoCount = 0;  // rounds captured automatically

  // ─── Create floating panel ────────────────────────────────────────────────
  const panel = document.createElement("div");
  panel.id = "__aviator_panel";
  panel.innerHTML = `
    <div id="__av_header">
      <span id="__av_logo">✈ Aviator</span>
      <button id="__av_toggle" title="Minimizar">−</button>
    </div>
    <div id="__av_body">
      <div id="__av_mode_bar">
        <span id="__av_mode_icon">🔍</span>
        <span id="__av_mode_text">Buscando auto-captura…</span>
      </div>
      <div id="__av_auto_flash"></div>
      <div id="__av_signals">
        <div class="__av_sig_row" id="__av_sig_15">
          <span class="__av_sig_target">1.5x</span>
          <div class="__av_sig_info">
            <div class="__av_sig_label" id="__av_sig_label_15">Cargando…</div>
            <div class="__av_sig_conf" id="__av_sig_conf_15"></div>
          </div>
        </div>
        <div class="__av_sig_divider"></div>
        <div class="__av_sig_row" id="__av_sig_20">
          <span class="__av_sig_target">2.0x</span>
          <div class="__av_sig_info">
            <div class="__av_sig_label" id="__av_sig_label_20">Cargando…</div>
            <div class="__av_sig_conf" id="__av_sig_conf_20"></div>
          </div>
        </div>
      </div>
      <div id="__av_gale_alert"></div>
      <details id="__av_manual_section">
        <summary id="__av_manual_toggle">✋ Ingresar manual</summary>
        <div id="__av_manual_content">
          <div id="__av_label">Toca el multiplicador que cayó:</div>
          <div id="__av_presets"></div>
          <div id="__av_custom_row">
            <input id="__av_custom_input" type="number" step="0.01" min="1" placeholder="otro…" />
            <button id="__av_custom_btn">✓</button>
          </div>
        </div>
      </details>
      <div id="__av_last"></div>
      <div id="__av_status"></div>
    </div>
  `;
  document.documentElement.appendChild(panel);

  // ─── Styles ───────────────────────────────────────────────────────────────
  const style = document.createElement("style");
  style.textContent = `
    #__aviator_panel {
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 2147483647;
      width: 240px;
      background: #0f172a;
      border: 1px solid #1e3a5f;
      border-radius: 14px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.6);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 12px;
      color: #f1f5f9;
      user-select: none;
      overflow: hidden;
      transition: all 0.2s;
    }
    #__av_header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      background: #1e3a5f;
      cursor: move;
    }
    #__av_logo { font-weight: 700; font-size: 13px; color: #60a5fa; }
    #__av_toggle {
      background: none; border: none; color: #94a3b8;
      font-size: 18px; cursor: pointer; padding: 0; line-height: 1;
    }
    #__av_toggle:hover { color: #f1f5f9; }
    #__av_body { padding: 10px 10px 8px; }
    #__aviator_panel.minimized #__av_body { display: none; }
    #__aviator_panel.minimized { width: 140px; }

    #__av_signals {
      background: #1e293b;
      border-radius: 10px;
      margin-bottom: 8px;
      border: 1px solid #334155;
      overflow: hidden;
    }
    .__av_sig_row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 7px 10px;
    }
    .__av_sig_target {
      font-size: 11px;
      font-weight: 800;
      color: #60a5fa;
      min-width: 30px;
      font-family: monospace;
    }
    .__av_sig_info { flex: 1; }
    .__av_sig_label {
      font-size: 13px;
      font-weight: 900;
      letter-spacing: -0.3px;
    }
    .__av_sig_label.enter { color: #10b981; }
    .__av_sig_label.wait  { color: #f59e0b; }
    .__av_sig_conf { font-size: 10px; color: #64748b; margin-top: 1px; }
    .__av_sig_divider { height: 1px; background: #334155; margin: 0; }

    #__av_label {
      font-size: 10px;
      color: #64748b;
      margin-bottom: 5px;
      text-align: center;
    }

    #__av_presets {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 4px;
      margin-bottom: 5px;
    }
    .av-btn {
      padding: 6px 2px;
      border: none;
      border-radius: 7px;
      font-size: 11px;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.12s;
      font-family: monospace;
    }
    .av-btn:active { transform: scale(0.93); }
    .av-btn.loss { background: #7f1d1d; color: #fca5a5; }
    .av-btn.loss:hover { background: #991b1b; }
    .av-btn.win  { background: #14532d; color: #86efac; }
    .av-btn.win:hover { background: #166534; }

    #__av_custom_row {
      display: flex;
      gap: 4px;
      margin-bottom: 6px;
    }
    #__av_custom_input {
      flex: 1;
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 6px;
      padding: 5px 6px;
      color: #f1f5f9;
      font-size: 12px;
      outline: none;
      min-width: 0;
    }
    #__av_custom_input:focus { border-color: #3b82f6; }
    #__av_custom_btn {
      background: #2563eb;
      color: white;
      border: none;
      border-radius: 6px;
      padding: 5px 8px;
      font-size: 13px;
      cursor: pointer;
      font-weight: 700;
    }
    #__av_custom_btn:hover { background: #1d4ed8; }

    #__av_last {
      font-size: 10px;
      color: #475569;
      text-align: center;
      min-height: 14px;
    }
    #__av_status {
      font-size: 10px;
      text-align: center;
      min-height: 14px;
      margin-top: 2px;
    }
    #__av_status.ok   { color: #10b981; }
    #__av_status.err  { color: #ef4444; }
    #__av_status.wait { color: #64748b; }

    #__av_gale_alert {
      text-align: center;
      font-weight: 700;
      font-size: 11px;
      border-radius: 8px;
      padding: 0;
      margin: 0;
      transition: all 0.2s;
    }
    #__av_gale_alert:not(:empty) {
      padding: 6px 8px;
      margin-bottom: 6px;
    }
    #__av_gale_alert.gale-win   { background: #064e3b; color: #34d399; border: 1px solid #059669; }
    #__av_gale_alert.gale-alert { background: #78350f; color: #fcd34d; border: 1px solid #d97706; font-size: 12px; }
    #__av_gale_alert.gale-loss  { background: #450a0a; color: #f87171; border: 1px solid #dc2626; }

    #__av_mode_bar {
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: 10px;
      padding: 4px 8px;
      border-radius: 7px;
      margin-bottom: 6px;
      background: #1e293b;
      border: 1px solid #334155;
    }
    #__av_mode_bar.auto { background: #052e16; border-color: #059669; color: #34d399; }
    #__av_mode_bar.searching { background: #1e293b; color: #64748b; }
    #__av_mode_icon { font-size: 12px; }
    #__av_mode_text { flex: 1; font-weight: 600; }

    #__av_auto_flash {
      font-size: 11px;
      font-weight: 700;
      text-align: center;
      border-radius: 6px;
      padding: 0;
      margin: 0;
      max-height: 0;
      overflow: hidden;
      transition: max-height 0.2s, padding 0.2s, margin 0.2s, opacity 0.3s;
      opacity: 0;
    }
    #__av_auto_flash.show {
      max-height: 30px;
      padding: 5px 8px;
      margin-bottom: 6px;
      opacity: 1;
      background: #052e16;
      color: #34d399;
      border: 1px solid #059669;
    }

    #__av_manual_section {
      margin-bottom: 4px;
    }
    #__av_manual_toggle {
      font-size: 10px;
      color: #64748b;
      cursor: pointer;
      list-style: none;
      text-align: center;
      padding: 3px 0;
    }
    #__av_manual_toggle:hover { color: #94a3b8; }
    #__av_manual_toggle::marker { display: none; }
    #__av_manual_content { padding-top: 4px; }
  `;
  document.documentElement.appendChild(style);

  // ─── Preset buttons ───────────────────────────────────────────────────────
  const PRESETS = [1.0, 1.1, 1.2, 1.3, 1.5, 2.0, 3.0, 5.0, 10.0];
  const presetsEl = panel.querySelector("#__av_presets");

  PRESETS.forEach((v) => {
    const btn = document.createElement("button");
    btn.className = "av-btn " + (v < 1.5 ? "loss" : "win");
    btn.textContent = v.toFixed(v >= 10 ? 0 : v % 1 === 0 ? 1 : 2) + "x";
    btn.addEventListener("click", () => sendRound(v));
    presetsEl.appendChild(btn);
  });

  // ─── Custom input ─────────────────────────────────────────────────────────
  const customInput = panel.querySelector("#__av_custom_input");
  panel.querySelector("#__av_custom_btn").addEventListener("click", () => {
    const v = parseFloat(customInput.value);
    if (!isNaN(v) && v >= 1) { sendRound(v); customInput.value = ""; }
  });
  customInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const v = parseFloat(customInput.value);
      if (!isNaN(v) && v >= 1) { sendRound(v); customInput.value = ""; }
    }
  });

  // ─── Toggle minimize ──────────────────────────────────────────────────────
  const toggleBtn = panel.querySelector("#__av_toggle");
  toggleBtn.addEventListener("click", () => {
    panel.classList.toggle("minimized");
    panelVisible = !panel.classList.contains("minimized");
    toggleBtn.textContent = panelVisible ? "−" : "+";
  });

  // ─── Drag to reposition ───────────────────────────────────────────────────
  const header = panel.querySelector("#__av_header");
  let dragging = false, dragX = 0, dragY = 0;

  header.addEventListener("mousedown", (e) => {
    dragging = true;
    dragX = e.clientX - panel.getBoundingClientRect().left;
    dragY = e.clientY - panel.getBoundingClientRect().top;
    e.preventDefault();
  });
  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    panel.style.left = (e.clientX - dragX) + "px";
    panel.style.top = (e.clientY - dragY) + "px";
  });
  document.addEventListener("mouseup", () => { dragging = false; });

  // ─── Gale alert display ───────────────────────────────────────────────────
  const GALE_CONFIG = {
    WIN_DIRECT:      { text: "✅ GANADA DIRECTA",            cls: "gale-win"    },
    WIN_GALE:        { text: "🔄 GANADA CON GALE",           cls: "gale-win"    },
    GALE_TRIGGERED:  { text: "⚠️ GALE — APLICA DOBLE",      cls: "gale-alert"  },
    LOSS_FINAL:      { text: "❌ PÉRDIDA TOTAL",              cls: "gale-loss"   },
  };

  function showGaleAlert(galeAlert) {
    const el = panel.querySelector("#__av_gale_alert");
    if (!el) return;
    if (!galeAlert || !GALE_CONFIG[galeAlert]) { el.textContent = ""; el.className = ""; return; }
    const cfg = GALE_CONFIG[galeAlert];
    el.textContent = cfg.text;
    el.className = cfg.cls;
    if (galeAlert !== "GALE_TRIGGERED") {
      setTimeout(() => { el.textContent = ""; el.className = ""; }, 5000);
    }
  }

  // ─── Send round to background ─────────────────────────────────────────────
  function sendRound(multiplier) {
    setStatus("Enviando…", "wait");
    if (!chrome.runtime?.id) { setStatus("Recargá la página", "err"); return; }
    try {
      chrome.runtime.sendMessage(
        { type: "MANUAL_ROUND", multiplier },
        (response) => {
          if (chrome.runtime.lastError) {
            setStatus("Error de conexión", "err");
            return;
          }
          setStatus("✓ " + multiplier.toFixed(2) + "x enviado", "ok");
          panel.querySelector("#__av_last").textContent =
            "Última: " + multiplier.toFixed(2) + "x — " +
            new Date().toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
          showGaleAlert(response?.galeAlert ?? null);
          setTimeout(loadSignal, 800);
        }
      );
    } catch { setStatus("Recargá la página", "err"); }
  }

  // ─── Status helpers ───────────────────────────────────────────────────────
  function setStatus(msg, type) {
    const el = panel.querySelector("#__av_status");
    el.textContent = msg;
    el.className = type;
    if (type === "ok") setTimeout(() => { el.textContent = ""; }, 2500);
  }

  // ─── Render a single signal row ───────────────────────────────────────────
  function renderSignalRow(labelId, confId, signalValue, confidence) {
    const label = panel.querySelector("#" + labelId);
    const conf = panel.querySelector("#" + confId);
    if (!label || !conf) return;
    if (!signalValue) {
      label.textContent = "Sin señal aún";
      label.className = "__av_sig_label";
      conf.textContent = "Registra una ronda ↓";
      return;
    }
    const isEnter = signalValue === "ENTER";
    label.textContent = isEnter ? "✅ ENTRAR" : "⏳ ESPERAR";
    label.className = "__av_sig_label " + (isEnter ? "enter" : "wait");
    conf.textContent = "Confianza: " + Math.round(confidence ?? 0) + "%";
  }

  // ─── Load current signal from background ──────────────────────────────────
  function loadSignal() {
    if (!chrome.runtime?.id) return;
    try { chrome.runtime.sendMessage({ type: "GET_STATUS" }, (data) => {
      if (chrome.runtime.lastError || !data) return;
      const rounds = data.lastRounds ?? [];
      const lastOk = rounds.find((r) => r.status === "ok" && r.signal);

      renderSignalRow(
        "__av_sig_label_15", "__av_sig_conf_15",
        lastOk?.signal ?? null, lastOk?.confidence ?? 0
      );
      renderSignalRow(
        "__av_sig_label_20", "__av_sig_conf_20",
        lastOk?.signal20 ?? null, lastOk?.confidence20 ?? 0
      );
    }); } catch { /* context invalidated */ }
  }

  // ─── Auto-capture notification ────────────────────────────────────────────
  function showAutoCapture(multiplier) {
    autoCount++;
    // Update mode bar to "active"
    const modeBar = panel.querySelector("#__av_mode_bar");
    const modeIcon = panel.querySelector("#__av_mode_icon");
    const modeText = panel.querySelector("#__av_mode_text");
    if (modeBar) {
      modeBar.className = "auto";
      modeIcon.textContent = "🤖";
      modeText.textContent = `Auto-captura activa (${autoCount})`;
    }
    // Flash notification
    const flash = panel.querySelector("#__av_auto_flash");
    if (flash) {
      flash.textContent = `✅ Auto: ${multiplier.toFixed(2)}x`;
      flash.classList.add("show");
      setTimeout(() => flash.classList.remove("show"), 2500);
    }
    // Update last round text
    const lastEl = panel.querySelector("#__av_last");
    if (lastEl) {
      lastEl.textContent = "Auto: " + multiplier.toFixed(2) + "x — " +
        new Date().toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    }
  }

  // ─── Auto relay captured WS rounds ───────────────────────────────────────
  document.addEventListener("__aviator_round", (event) => {
    const mult = event.detail?.multiplier;
    if (mult) showAutoCapture(mult);
    setTimeout(loadSignal, 1000);
  });

  // ─── Poll signal every 5s ─────────────────────────────────────────────────
  loadSignal();
  pollTimer = setInterval(loadSignal, 5000);

})();
