const STORAGE_KEYS = {
  rounds: "researchRounds",
  settings: "researchSettings",
};
const MAX_STORED_ROUNDS = 20000;

const DEFAULT_SETTINGS = {
  autoCaptureEnabled: true,
  targetMultiplier: 1.5,
};

const attachedTabs = new Set();

let spribeLastX = null;
let spribeFlying = false;
let spribeLastRoundId = null;
let spribeLastEmitRoundId = null;
let spribeXCount = 0;

function isBetwinnerUrl(url) {
  return typeof url === "string" && url.toLowerCase().includes("betwinner");
}

function normalizeMultiplier(multiplier) {
  const parsed = Number.parseFloat(multiplier);
  if (!Number.isFinite(parsed) || parsed < 1) return null;
  return Number(parsed.toFixed(2));
}

function createRoundRecord(multiplier, source = "auto") {
  return {
    id: crypto.randomUUID(),
    multiplier,
    source,
    createdAt: new Date().toISOString(),
    reachedTarget15: multiplier >= 1.5,
  };
}

async function getRounds() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.rounds);
  return Array.isArray(data[STORAGE_KEYS.rounds]) ? data[STORAGE_KEYS.rounds] : [];
}

async function getSettings() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.settings);
  return { ...DEFAULT_SETTINGS, ...(data[STORAGE_KEYS.settings] ?? {}) };
}

async function setSettings(nextSettings) {
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: nextSettings });
  return nextSettings;
}

function isDuplicate(lastRound, multiplier, source) {
  if (!lastRound) return false;
  if (lastRound.source === "manual" && source !== "manual") return false;
  const elapsed = Date.now() - new Date(lastRound.createdAt).getTime();
  return lastRound.multiplier === multiplier && elapsed < 8000;
}

async function addRound(multiplier, source = "auto") {
  const normalized = normalizeMultiplier(multiplier);
  if (normalized === null) {
    return { ok: false, error: "invalid_multiplier" };
  }

  const rounds = await getRounds();
  const latest = rounds[0];
  if (isDuplicate(latest, normalized, source)) {
    return { ok: true, duplicated: true };
  }

  const nextRounds = [createRoundRecord(normalized, source), ...rounds].slice(0, MAX_STORED_ROUNDS);
  await chrome.storage.local.set({ [STORAGE_KEYS.rounds]: nextRounds });
  console.log(`[Aviator Research] stored round ${normalized}x via ${source}`);
  return { ok: true, duplicated: false };
}

function buildStats(rounds, target = 1.5) {
  const total = rounds.length;
  const hitCount = rounds.filter((round) => round.multiplier >= target).length;
  const avg = total ? rounds.reduce((sum, round) => sum + round.multiplier, 0) / total : 0;

  let lowStreak = 0;
  for (const round of rounds) {
    if (round.multiplier < target) lowStreak++;
    else break;
  }

  const recent = [...rounds].slice(0, 50).reverse();

  const distributionRanges = [
    { label: "<1.5x", min: 0, max: 1.5 },
    { label: "1.5x-1.99x", min: 1.5, max: 2 },
    { label: "2x-4.99x", min: 2, max: 5 },
    { label: "5x-9.99x", min: 5, max: 10 },
    { label: "10x+", min: 10, max: null },
  ];

  const distribution = distributionRanges.map((range) => {
    const count = rounds.filter((round) => {
      if (range.max === null) return round.multiplier >= range.min;
      return round.multiplier >= range.min && round.multiplier < range.max;
    }).length;
    return {
      label: range.label,
      count,
      pct: total ? count / total : 0,
    };
  });

  return {
    totalRounds: total,
    targetHitRate: total ? hitCount / total : 0,
    avgMultiplier: avg,
    currentLowStreak: lowStreak,
    recent,
    distribution,
  };
}

function toCsv(rows) {
  const headers = ["id", "createdAt", "multiplier", "source", "reachedTarget15"];
  const body = rows.map((row) =>
    [row.id, row.createdAt, row.multiplier, row.source, row.reachedTarget15]
      .map((value) => `"${String(value).replaceAll("\"", "\"\"")}"`)
      .join(","),
  );
  return [headers.join(","), ...body].join("\n");
}

async function downloadText(filename, content, mimeType) {
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
  try {
    await chrome.downloads.download({ url, filename, saveAs: true });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function scanStringForMultiplier(text) {
  if (typeof text !== "string") return null;
  const patterns = [
    /"crash_factor"\s*:\s*([\d.]+)/i,
    /"coefficient"\s*:\s*([\d.]+)/i,
    /"x"\s*:\s*([\d.]+)/i,
    /"koeff"\s*:\s*([\d.]+)/i,
    /"factor"\s*:\s*([\d.]+)/i,
  ];
  for (const re of patterns) {
    const match = text.match(re);
    if (!match) continue;
    const n = Number.parseFloat(match[1]);
    if (Number.isFinite(n) && n >= 1 && n <= 10000) return n;
  }
  return null;
}

function extractMultiplierFromObject(obj) {
  if (!obj || typeof obj !== "object") return null;
  const keys = [
    "crash_factor", "crashFactor", "x", "koeff", "coefficient",
    "multiplier", "factor", "result", "coeff", "k", "value", "rate",
    "crash", "cashout", "payout",
  ];
  for (const key of keys) {
    if (!(key in obj)) continue;
    const n = Number.parseFloat(obj[key]);
    if (Number.isFinite(n) && n >= 1 && n <= 10000) return n;
  }
  for (const key of ["data", "result", "payload", "game", "round", "game_result"]) {
    if (obj[key] && typeof obj[key] === "object") {
      const found = extractMultiplierFromObject(obj[key]);
      if (found) return found;
    }
  }
  return null;
}

function extractMultiplierFromText(text) {
  const direct = scanStringForMultiplier(text);
  if (direct) return direct;
  try {
    const trimmed = text.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      const obj = JSON.parse(trimmed);
      return extractMultiplierFromObject(obj);
    }
  } catch {}
  return null;
}

function parseSpribeFields(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fields = {};

  let i = 0;
  while (i < bytes.length - 3) {
    if (bytes[i] !== 0x00) { i++; continue; }
    const nameLen = bytes[i + 1];
    if (nameLen === 0 || nameLen > 30 || i + 2 + nameLen >= bytes.length) { i++; continue; }

    let validName = true;
    for (let k = 0; k < nameLen; k++) {
      const c = bytes[i + 2 + k];
      if (c < 0x20 || c > 0x7e) { validName = false; break; }
    }
    if (!validName) { i++; continue; }

    const nameEnd = i + 2 + nameLen;
    const typeByte = bytes[nameEnd];
    const name = String.fromCharCode(...bytes.slice(i + 2, nameEnd));

    if (typeByte === 0x07 && nameEnd + 1 + 8 <= bytes.length) {
      const f = view.getFloat64(nameEnd + 1, false);
      if (Number.isFinite(f)) fields[name] = f;
      i = nameEnd + 9;
      continue;
    }
    if (typeByte === 0x04 && nameEnd + 1 + 4 <= bytes.length) {
      fields[name] = view.getInt32(nameEnd + 1, false);
      i = nameEnd + 5;
      continue;
    }
    i++;
  }

  return fields;
}

function decodeSpribeFrame(bytes) {
  if (bytes.length > 400) return null;

  const fields = parseSpribeFields(bytes);

  if ("x" in fields) {
    const x = fields.x;
    if (Number.isFinite(x) && x >= 1 && x <= 1000000) {
      spribeFlying = true;
      spribeLastX = Number.parseFloat(x.toFixed(2));
      spribeXCount++;
    }
    return null;
  }

  const hasRoundId = "roundId" in fields;
  const hasNewStateId = "newStateId" in fields;

  if ((hasRoundId || hasNewStateId) && spribeFlying && spribeLastX !== null) {
    const crashX = spribeLastX;
    const roundId = hasRoundId ? fields.roundId : spribeLastRoundId;

    if (roundId !== null && roundId === spribeLastEmitRoundId) {
      spribeFlying = false;
      spribeLastX = null;
      spribeXCount = 0;
      if (hasRoundId) spribeLastRoundId = fields.roundId;
      return { type: "state", roundId: fields.roundId };
    }

    if (spribeXCount < 3) {
      spribeFlying = false;
      spribeLastX = null;
      spribeXCount = 0;
      if (hasRoundId) spribeLastRoundId = fields.roundId;
      return { type: "state", roundId: fields.roundId };
    }

    spribeLastEmitRoundId = roundId;
    spribeFlying = false;
    spribeLastX = null;
    spribeXCount = 0;
    if (hasRoundId) spribeLastRoundId = fields.roundId;
    return { type: "crash", x: crashX, roundId };
  }

  if (hasRoundId) spribeLastRoundId = fields.roundId;
  if (hasRoundId || hasNewStateId) {
    spribeFlying = false;
    spribeLastX = null;
    spribeXCount = 0;
    return { type: "state", roundId: fields.roundId };
  }

  return null;
}

async function attachDebugger(tabId) {
  if (attachedTabs.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    await chrome.debugger.sendCommand({ tabId }, "Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
    await chrome.debugger.sendCommand({ tabId }, "Network.enable", {});
    attachedTabs.add(tabId);
    console.log(`[Aviator Research] debugger attached to tab ${tabId}`);
  } catch (error) {
    console.log("[Aviator Research] debugger attach failed:", error?.message ?? error);
  }
}

async function enableNetworkForSession(tabId, sessionId) {
  try {
    await chrome.debugger.sendCommand({ tabId, sessionId }, "Network.enable", {});
    console.log(`[Aviator Research] child session network enabled ${sessionId.slice(0, 8)}...`);
  } catch (error) {
    console.log("[Aviator Research] child Network.enable failed:", error?.message ?? error);
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && isBetwinnerUrl(tab.url)) {
    attachDebugger(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (attachedTabs.has(tabId)) {
    chrome.debugger.detach({ tabId }).catch(() => {});
    attachedTabs.delete(tabId);
  }
});

chrome.tabs.query({}, (tabs) => {
  (tabs || []).filter((tab) => isBetwinnerUrl(tab.url)).forEach((tab) => {
    if (tab.id) attachDebugger(tab.id);
  });
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method === "Target.attachedToTarget") {
    const sessionId = params?.sessionInfo?.sessionId ?? params?.sessionId;
    if (sessionId && source.tabId) enableNetworkForSession(source.tabId, sessionId);
    return;
  }

  if (method === "Network.webSocketCreated") {
    console.log("[Aviator Research] websocket created:", params?.url ?? "(unknown)");
    return;
  }

  if (method !== "Network.webSocketFrameReceived") return;

  const payload = params?.response?.payloadData ?? "";
  const opcode = params?.response?.opcode ?? 2;

  if (opcode === 1 && payload) {
    const mult = extractMultiplierFromText(payload);
    if (mult) {
      addRound(mult, "cdp-text").catch(() => {});
    }
    return;
  }

  if (opcode !== 2 || !payload) return;

  try {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const decoded = decodeSpribeFrame(bytes);
    if (decoded?.type === "crash") {
      console.log(`[Aviator Research] crash detected via CDP: ${decoded.x}x`);
      addRound(decoded.x, "cdp-binary").catch(() => {});
    }
  } catch (error) {
    console.log("[Aviator Research] binary decode error:", error?.message ?? error);
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await getSettings();
  await setSettings(settings);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "ADD_ROUND") {
    addRound(message.multiplier, message.source ?? "auto")
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "GET_DATA") {
    Promise.all([getRounds(), getSettings()])
      .then(([rounds, settings]) => sendResponse({ ok: true, rounds, settings, stats: buildStats(rounds, settings.targetMultiplier) }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "SET_SETTINGS") {
    getSettings()
      .then((current) => setSettings({ ...current, ...message.payload }))
      .then((settings) => sendResponse({ ok: true, settings }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "CLEAR_DATA") {
    chrome.storage.local.set({ [STORAGE_KEYS.rounds]: [] })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "EXPORT_JSON") {
    getRounds()
      .then((rounds) => downloadText("aviator-research-betwinner.json", JSON.stringify(rounds, null, 2), "application/json"))
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "EXPORT_CSV") {
    getRounds()
      .then((rounds) => downloadText("aviator-research-betwinner.csv", toCsv([...rounds].reverse()), "text/csv"))
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  sendResponse({ ok: false, error: "unknown_message" });
  return false;
});
