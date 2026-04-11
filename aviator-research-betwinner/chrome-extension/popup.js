function $(id) {
  return document.getElementById(id);
}

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => resolve(response));
  });
}

function formatPct(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function renderDistribution(items) {
  const root = $("distribution");
  root.innerHTML = "";

  items.forEach((item) => {
    const row = document.createElement("div");
    row.innerHTML = `
      <div style="display:flex;justify-content:space-between;gap:10px;font-size:12px;">
        <span>${item.label}</span>
        <span style="color:#a1a1aa;">${item.count} · ${formatPct(item.pct)}</span>
      </div>
      <div class="bar"><span style="width:${Math.max(item.pct * 100, 2)}%"></span></div>
    `;
    root.appendChild(row);
  });
}

function renderRecent(rounds) {
  const root = $("recent-rounds");
  root.innerHTML = "";

  if (!rounds.length) {
    const empty = document.createElement("div");
    empty.className = "status";
    empty.textContent = "Sin rondas aun. Abre Aviator en Betwinner y deja correr algunas rondas.";
    root.appendChild(empty);
    return;
  }

  rounds.slice(0, 12).forEach((round) => {
    const item = document.createElement("div");
    const time = new Date(round.createdAt).toLocaleTimeString("es-CO", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    item.className = "round";
    item.innerHTML = `
      <span>${time}</span>
      <span class="${round.reachedTarget15 ? "hit" : "miss"}">${round.multiplier.toFixed(2)}x</span>
      <span style="color:#a1a1aa;">${round.source}</span>
    `;
    root.appendChild(item);
  });
}

async function refresh() {
  const response = await sendMessage({ type: "GET_DATA" });
  if (!response?.ok) {
    $("status-text").textContent = "No se pudo leer la base local de la extension.";
    return;
  }

  const { rounds, stats } = response;
  $("total-rounds").textContent = String(stats.totalRounds);
  $("hit-rate").textContent = formatPct(stats.targetHitRate);
  $("avg-mult").textContent = `${stats.avgMultiplier.toFixed(2)}x`;
  $("low-streak").textContent = String(stats.currentLowStreak);
  $("status-text").textContent = rounds.length
    ? "Datos cargados desde el almacenamiento local de esta extension."
    : "Esperando primeras rondas del estudio.";

  renderDistribution(stats.distribution);
  renderRecent(rounds);
}

$("manual-add").addEventListener("click", async () => {
  const raw = $("manual-input").value.trim();
  const multiplier = Number.parseFloat(raw);
  if (!Number.isFinite(multiplier) || multiplier < 1) return;

  await sendMessage({ type: "ADD_ROUND", multiplier, source: "manual" });
  $("manual-input").value = "";
  await refresh();
});

$("manual-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter") $("manual-add").click();
});

$("open-dashboard").addEventListener("click", async () => {
  const url = chrome.runtime.getURL("dashboard.html");
  await chrome.tabs.create({ url });
});

$("export-json").addEventListener("click", async () => {
  await sendMessage({ type: "EXPORT_JSON" });
});

$("export-csv").addEventListener("click", async () => {
  await sendMessage({ type: "EXPORT_CSV" });
});

$("clear-data").addEventListener("click", async () => {
  const confirmed = confirm("Esto borrara las rondas almacenadas en esta extension. Quieres continuar?");
  if (!confirmed) return;
  await sendMessage({ type: "CLEAR_DATA" });
  await refresh();
});

document.addEventListener("DOMContentLoaded", refresh);
