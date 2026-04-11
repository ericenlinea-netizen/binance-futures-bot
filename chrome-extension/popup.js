"use strict";

const $ = (id) => document.getElementById(id);

let currentSignal = null;

// ─── Initialization ─────────────────────────────────────────────────────────
async function init() {
  await loadStatus();
  await loadApiUrl();
  setupListeners();
  // Refresh every 5 seconds
  setInterval(loadStatus, 5000);
}

// ─── Load status from background ────────────────────────────────────────────
async function loadStatus() {
  const data = await sendMessage({ type: "GET_STATUS" });
  if (!data) return;

  const { lastRounds = [], totalCaptures = 0, apiUrl = "" } = data;

  // Update stats
  const today = lastRounds.filter((r) => {
    const d = new Date(r.time);
    const now = new Date();
    return d.toDateString() === now.toDateString();
  });

  $("stat-total").textContent = today.length;
  $("stat-ok").textContent = today.filter((r) => r.status === "ok").length;

  // Streak from recent rounds
  let streak = 0;
  for (const r of lastRounds) {
    if (r.multiplier < 1.5) streak++;
    else break;
  }
  $("stat-streak").textContent = streak || "0";

  // Status dot
  const dot = $("status-dot");
  if (apiUrl && lastRounds.length > 0 && lastRounds[0].status === "ok") {
    dot.classList.add("active");
  }

  // Current signal from last round
  const lastOk = lastRounds.find((r) => r.status === "ok" && r.signal);
  if (lastOk) {
    updateSignalCard(lastOk.signal, lastOk.confidence, streak);
  }

  // History
  renderHistory(lastRounds);
}

function updateSignalCard(signal, confidence, streak) {
  const card = $("signal-card");
  const label = $("signal-label");
  const conf = $("signal-conf");
  const reason = $("signal-reason");
  const streakEl = $("signal-streak");

  const isEnter = signal === "ENTER";
  const cls = isEnter ? "enter" : "wait";

  card.className = `signal-card ${cls}`;
  label.className = `signal-label ${cls}`;
  label.textContent = isEnter ? "✅ ENTRAR" : "⏳ ESPERAR";
  conf.className = `signal-meta conf ${cls}`;
  conf.textContent = confidence != null ? `${Math.round(confidence)}%` : "—";
  streakEl.textContent = streak > 0 ? `${streak} pérdidas seguidas` : "";
  reason.textContent = isEnter
    ? "Alta confianza — puede ser buen momento"
    : "Esperar mejor señal";
}

function renderHistory(rounds) {
  const list = $("history-list");
  if (rounds.length === 0) {
    list.innerHTML = '<li class="empty">Sin capturas aún — abre Aviator en Stake, Melbet o Betwinner</li>';
    return;
  }

  list.innerHTML = rounds
    .slice(0, 8)
    .map((r) => {
      const isWin = r.multiplier >= 1.5;
      const multClass = isWin ? "win" : "loss";
      const time = new Date(r.time).toLocaleTimeString("es", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });

      let sigPill = "";
      if (r.status === "error") {
        sigPill = `<span class="sig-pill error">Error</span>`;
      } else if (r.signal === "ENTER") {
        sigPill = `<span class="sig-pill enter">ENTRAR ${r.confidence != null ? Math.round(r.confidence) + "%" : ""}</span>`;
      } else if (r.signal === "WAIT") {
        sigPill = `<span class="sig-pill wait">ESPERAR</span>`;
      } else {
        sigPill = `<span class="sig-pill none">—</span>`;
      }

      return `
        <li class="history-item">
          <span class="mult-badge ${multClass}">${r.multiplier.toFixed(2)}x</span>
          ${sigPill}
          <span class="hist-time">${time}</span>
        </li>
      `;
    })
    .join("");
}

// ─── Load API URL ────────────────────────────────────────────────────────────
async function loadApiUrl() {
  const { apiUrl = "" } = await chrome.storage.local.get("apiUrl");
  $("api-url").value = apiUrl;
}

// ─── Event Listeners ─────────────────────────────────────────────────────────
function setupListeners() {
  // Save API URL
  $("btn-save").addEventListener("click", async () => {
    const url = $("api-url").value.trim();
    if (!url) {
      showAlert("Ingresa la URL del dashboard.", "error");
      return;
    }
    await sendMessage({ type: "SET_API_URL", url });
    showAlert("URL guardada correctamente.", "success");
    setTimeout(() => { $("api-url").blur(); }, 300);
  });

  // Manual capture
  $("btn-manual").addEventListener("click", async () => {
    const val = parseFloat($("manual-mult").value);
    if (isNaN(val) || val < 1) {
      showAlert("Ingresa un multiplicador válido (≥ 1.0)", "error");
      return;
    }
    await sendMessage({ type: "MANUAL_ROUND", multiplier: val });
    $("manual-mult").value = "";
    showAlert(`Ronda ${val.toFixed(2)}x enviada.`, "success");
    setTimeout(loadStatus, 1000);
  });

  // Manual: submit with Enter
  $("manual-mult").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("btn-manual").click();
  });

  // Clear history
  $("btn-clear").addEventListener("click", async () => {
    await sendMessage({ type: "CLEAR_HISTORY" });
    await loadStatus();
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) {
        resolve(null);
      } else {
        resolve(response);
      }
    });
  });
}

function showAlert(text, type) {
  const box = $("alert-box");
  box.className = `alert alert-${type}`;
  box.textContent = text;
  box.style.display = "block";
  setTimeout(() => { box.style.display = "none"; }, 3000);
}

// ─── Start ───────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", init);
