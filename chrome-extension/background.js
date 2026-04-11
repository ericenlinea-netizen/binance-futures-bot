/**
 * Background Service Worker v2.0
 * - Receives round captures from content scripts / popup, calls the dashboard API.
 * - Uses Chrome Debugger Protocol (CDP) to intercept WebSocket frames directly.
 */

const DEDUP_WINDOW_MS = 8000; // 8s > typical Aviator polling intervals
let lastSent = { multiplier: null, time: 0 };

// Default API URL — update if your Replit dev domain changes
const DEFAULT_API_URL = "https://e316d9e0-058b-4157-9448-4a7938428c57-00-360mzzg62dlag.spock.replit.dev";

// Auto-set API URL on fresh install (only if not already configured)
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get("apiUrl", ({ apiUrl }) => {
    if (!apiUrl) {
      chrome.storage.local.set({ apiUrl: DEFAULT_API_URL });
      console.log(`[Aviator BG] ✅ API URL configurada automáticamente: ${DEFAULT_API_URL}`);
    }
  });
});

// ─── CDP WebSocket Interception ───────────────────────────────────────────────
// Track which tabs have the debugger attached
const attachedTabs = new Set();
const SUPPORTED_PLATFORMS = ["betwinner", "melbet", "stake"];

function isSupportedGameUrl(url) {
  if (!url) return false;
  const lowerUrl = url.toLowerCase();
  return SUPPORTED_PLATFORMS.some((platform) => lowerUrl.includes(platform));
}

// Attach debugger to a tab and enable Network domain for all frames
async function attachDebugger(tabId) {
  if (attachedTabs.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    // Auto-attach to child targets (cross-origin iframes) with flat session mode
    await chrome.debugger.sendCommand({ tabId }, "Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
    // Enable Network on the main frame
    await chrome.debugger.sendCommand({ tabId }, "Network.enable", {});
    attachedTabs.add(tabId);
    console.log(`[Aviator BG] 🔬 Debugger attached to tab ${tabId} (all frames)`);
  } catch (e) {
    console.log(`[Aviator BG] Debugger attach failed: ${e.message}`);
  }
}

// Enable Network on a child target session
async function enableNetworkForSession(tabId, sessionId) {
  try {
    await chrome.debugger.sendCommand({ tabId, sessionId }, "Network.enable", {});
    console.log(`[Aviator BG] 🌐 Network enabled for child session ${sessionId.slice(0, 8)}…`);
  } catch (e) {
    console.log(`[Aviator BG] Child session Network.enable failed: ${e.message}`);
  }
}

// Detach cleanly when tab closes or navigates away
chrome.tabs.onRemoved.addListener((tabId) => {
  if (attachedTabs.has(tabId)) {
    chrome.debugger.detach({ tabId }).catch(() => {});
    attachedTabs.delete(tabId);
  }
});

// Watch for supported Aviator tabs
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && isSupportedGameUrl(tab.url)) {
    attachDebugger(tabId);
  }
});

// Also attach to existing supported tabs when extension loads
chrome.tabs.query({}, (tabs) => {
  if (chrome.runtime.lastError) return;
  (tabs || [])
    .filter((t) => isSupportedGameUrl(t.url))
    .forEach((t) => t.id && attachDebugger(t.id));
});

// ─── CDP Event Handler ─────────────────────────────────────────────────────────
chrome.debugger.onEvent.addListener((source, method, params) => {

  // When a child target (cross-origin iframe) is attached, enable Network on it
  if (method === "Target.attachedToTarget") {
    const sessionId = params?.sessionInfo?.sessionId ?? params?.sessionId;
    const targetUrl = params?.targetInfo?.url ?? "";
    console.log(`[Aviator BG] 🖼️ Child target attached: ${targetUrl.slice(0, 60)} sessionId=${sessionId?.slice(0, 8)}…`);
    if (sessionId && source.tabId) {
      enableNetworkForSession(source.tabId, sessionId);
    }
    return;
  }

  if (method === "Network.webSocketCreated") {
    console.log(`[Aviator BG] 🔌 WS created: ${params?.url} (session=${source.sessionId?.slice(0, 8) ?? "main"})`);
  }

  if (method === "Network.webSocketFrameReceived") {
    const payload = params?.response?.payloadData ?? "";
    const opcode = params?.response?.opcode ?? 2;

    // opcode 1 = text frame, opcode 2 = binary frame
    if (opcode === 1 && payload) {
      // Text frame — try JSON
      const mult = extractMultiplierFromText(payload);
      if (mult) handleRound(mult, "cdp-text").catch(() => {});
    } else if (opcode === 2 && payload) {
      // Binary frame — CDP gives us base64-encoded binary
      try {
        const binary = atob(payload);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

        const result = decodeSpribeFrame(bytes);
        if (result) {
          if (result.type === "crash") {
            console.log(`[Aviator BG] 🎯 CRASH x=${result.x} roundId=${result.roundId}`);
            handleRound(result.x, "spribe").catch(() => {});
          } else if (result.type === "state") {
            console.log(`[Aviator BG] 🔄 State: ${result.state} roundId=${result.roundId}`);
          }
        }
      } catch (e) {
        console.log("[Aviator BG] Binary decode error:", e.message);
      }
    }
  }

});

// ─── Multiplier extraction from text ──────────────────────────────────────────
function extractMultiplierFromText(text) {
  const patterns = [
    /"crash_factor"\s*:\s*([\d.]+)/,
    /"coefficient"\s*:\s*([\d.]+)/,
    /"x"\s*:\s*([\d.]+)/,
    /"koeff"\s*:\s*([\d.]+)/,
    /"factor"\s*:\s*([\d.]+)/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const n = parseFloat(m[1]);
      if (!isNaN(n) && n >= 1.0 && n <= 10000) return n;
    }
  }
  // Try JSON parse
  try {
    const s = text.trim();
    if (s.startsWith("{") || s.startsWith("[")) {
      const obj = JSON.parse(s);
      return extractMultiplierFromObject(obj);
    }
  } catch {}
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
    if (key in obj) {
      const n = parseFloat(obj[key]);
      if (!isNaN(n) && n >= 1.0 && n <= 10000) return n;
    }
  }
  for (const key of ["data", "result", "payload", "game", "round", "game_result"]) {
    if (obj[key] && typeof obj[key] === "object") {
      const found = extractMultiplierFromObject(obj[key]);
      if (found) return found;
    }
  }
  return null;
}

// ─── Spribe Binary Protocol Decoder ───────────────────────────────────────────
// Protocol: custom TLV — field-length(uint16-BE) + field-name(ASCII) + type(1B) + value
// Types: 0x04 = int32-BE (4B), 0x07 = float64-BE (8B)
//
// Game sends x updates ~every 200ms during flight.
// State-change frames (with newStateId / roundId but no x) mark round boundaries.
// → State machine: accumulate lastX during flight, emit crash on state-change.

// ─── State machine ────────────────────────────────────────────────────────────
let _spribeLastX = null;         // most recent in-flight x
let _spribeFlying = false;       // true once the plane is airborne
let _spribeLastRoundId = null;   // to detect new rounds
let _spribeLastEmitRoundId = null; // roundId of last emitted crash (dedup)
let _spribeXCount = 0;           // how many x frames received this round

function _parseSpribeFields(bytes) {
  const buf = bytes.buffer;
  const view = new DataView(buf);
  const len = bytes.length;
  const fields = {};

  let i = 0;
  while (i < len - 3) {
    if (bytes[i] !== 0x00) { i++; continue; }
    const nameLen = bytes[i + 1];
    if (nameLen === 0 || nameLen > 30 || i + 2 + nameLen >= len) { i++; continue; }

    let validName = true;
    for (let k = 0; k < nameLen; k++) {
      const c = bytes[i + 2 + k];
      if (c < 0x20 || c > 0x7e) { validName = false; break; }
    }
    if (!validName) { i++; continue; }

    const nameEnd = i + 2 + nameLen;
    const typeByte = bytes[nameEnd];
    const name = String.fromCharCode(...bytes.slice(i + 2, nameEnd));

    if (typeByte === 0x07 && nameEnd + 1 + 8 <= len) {
      const f = view.getFloat64(nameEnd + 1, false);
      if (isFinite(f)) fields[name] = f;
      i = nameEnd + 1 + 8;
      continue;
    }
    if (typeByte === 0x04 && nameEnd + 1 + 4 <= len) {
      fields[name] = view.getInt32(nameEnd + 1, false);
      i = nameEnd + 1 + 4;
      continue;
    }
    i++;
  }
  return fields;
}

function decodeSpribeFrame(bytes) {
  // Large frames (>400B) are compressed state-dumps, not live game events
  if (bytes.length > 400) return null;

  const f = _parseSpribeFields(bytes);

  // ── In-flight update: frame has "x" ──────────────────────────────────────
  if ("x" in f) {
    const x = f.x;
    if (isFinite(x) && x >= 1.0 && x <= 1000000) {
      _spribeFlying = true;
      _spribeLastX  = parseFloat(x.toFixed(2));
      _spribeXCount++;
    }
    // Don't emit yet — wait for round-end state frame
    return null;
  }

  // ── Round-end / state-change: frame has roundId or newStateId but NO x ──
  const hasRoundId    = "roundId"    in f;
  const hasNewStateId = "newStateId" in f;

  if ((hasRoundId || hasNewStateId) && _spribeFlying && _spribeLastX !== null) {
    const crashX  = _spribeLastX;
    const roundId = hasRoundId ? f.roundId : _spribeLastRoundId;

    // Anti-duplicate: skip if same roundId already emitted
    if (roundId !== null && roundId === _spribeLastEmitRoundId) {
      _spribeFlying = false;
      _spribeLastX  = null;
      _spribeXCount = 0;
      if (hasRoundId) _spribeLastRoundId = f.roundId;
      return { type: "state", newStateId: f.newStateId, roundId: f.roundId };
    }

    // Require ≥3 in-flight x frames before emitting (avoids x=1.0 false crash)
    if (_spribeXCount < 3) {
      _spribeFlying = false;
      _spribeLastX  = null;
      _spribeXCount = 0;
      if (hasRoundId) _spribeLastRoundId = f.roundId;
      return { type: "state", newStateId: f.newStateId, roundId: f.roundId };
    }

    // Emit crash
    _spribeLastEmitRoundId = roundId;
    _spribeFlying = false;
    _spribeLastX  = null;
    _spribeXCount = 0;
    if (hasRoundId) _spribeLastRoundId = f.roundId;

    return { type: "crash", x: crashX, roundId };
  }

  // Track roundId for reference
  if (hasRoundId) _spribeLastRoundId = f.roundId;
  if (hasRoundId || hasNewStateId) {
    _spribeFlying = false;
    _spribeLastX  = null;
    _spribeXCount = 0;
    return { type: "state", newStateId: f.newStateId, roundId: f.roundId };
  }

  return null;
}

// ─── Message handler ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.type === "ROUND_CAPTURED") {
    handleRound(msg.multiplier, msg.source ?? "auto")
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.type === "MANUAL_ROUND") {
    handleRound(msg.multiplier, "manual")
      .then((result) => sendResponse({ ok: true, signal: result?.signal, galeAlert: result?.galeAlert ?? null, signal20: result?.signal20 ?? null }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (msg.type === "GET_STATUS") {
    chrome.storage.local.get(["apiUrl", "lastRounds", "totalCaptures"], (data) => {
      sendResponse(data ?? {});
    });
    return true;
  }

  if (msg.type === "SET_API_URL") {
    chrome.storage.local.set({ apiUrl: msg.url }, () => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === "CLEAR_HISTORY") {
    chrome.storage.local.set({ lastRounds: [], totalCaptures: 0 }, () => sendResponse({ ok: true }));
    return true;
  }

  sendResponse({ ok: false, error: "unknown message type" });
  return false;
});

// ─── Core round handler ───────────────────────────────────────────────────────
// Accepted sources (CDP is authoritative; injector/WS/XHR sources are noisy)
const ACCEPTED_SOURCES = new Set([
  "spribe", "cdp-binary", "cdp-text", "manual", "auto"
]);

async function handleRound(multiplier, source) {
  if (!multiplier || isNaN(multiplier)) return null;

  // Ignore injector-based sources now that CDP handles capture reliably
  if (!ACCEPTED_SOURCES.has(source)) {
    console.log(`[Aviator BG] ⏭️ Skipping round from injector source: ${source}`);
    return null;
  }

  const now = Date.now();
  if (
    lastSent.multiplier === multiplier &&
    now - lastSent.time < DEDUP_WINDOW_MS &&
    source !== "manual"
  ) return null;

  lastSent = { multiplier, time: now };

  const { apiUrl } = await chrome.storage.local.get("apiUrl");
  const base = (apiUrl ?? "").trim();

  if (!base) {
    await updateLocalHistory(multiplier, "error", "URL no configurada");
    return null;
  }

  const endpoint = base.replace(/\/+$/, "") + "/api/rounds";

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ multiplier, source }),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${txt.slice(0, 100)}`);
    }

    const data = await res.json();
    const signal = data?.signal ?? null;
    const galeAlert = data?.galeAlert ?? null;
    const signal20 = signal?.signal20 ?? null;

    console.log(
      `[Aviator BG] ✅ ${multiplier}x → 1.5x:${signal?.signal}(${signal?.confidence?.toFixed(0)}%) 2x:${signal20?.signal}(${signal20?.confidence?.toFixed(0)}%) gale=${galeAlert} [${source}]`,
    );

    await updateLocalHistory(multiplier, "ok", null, signal, galeAlert, signal20);
    showNotification(multiplier, signal, galeAlert);
    return { signal, galeAlert, signal20 };

  } catch (err) {
    console.error("[Aviator BG] ❌ Send failed:", err.message);
    await updateLocalHistory(multiplier, "error", err.message);
    return null;
  }
}

// ─── History storage ──────────────────────────────────────────────────────────
async function updateLocalHistory(multiplier, status, errorMsg, signal, galeAlert, signal20) {
  const { lastRounds = [], totalCaptures = 0 } = await chrome.storage.local.get([
    "lastRounds",
    "totalCaptures",
  ]);

  const entry = {
    multiplier,
    status,
    signal: signal?.signal ?? null,
    confidence: signal?.confidence ?? null,
    signal20: signal20?.signal ?? null,
    confidence20: signal20?.confidence ?? null,
    galeAlert: galeAlert ?? null,
    time: new Date().toISOString(),
    error: errorMsg ?? null,
  };

  const updated = [entry, ...lastRounds].slice(0, 30);
  const newTotal = status === "ok" ? totalCaptures + 1 : totalCaptures;
  await chrome.storage.local.set({ lastRounds: updated, totalCaptures: newTotal });
}

// ─── Notifications ────────────────────────────────────────────────────────────
function showNotification(multiplier, signal, galeAlert) {
  const GALE_LABELS = {
    WIN_DIRECT: "✅ GANADA DIRECTA",
    WIN_GALE: "🔄 GANADA CON GALE",
    GALE_TRIGGERED: "⚠️ GALE — Aplica doble apuesta",
    LOSS_FINAL: "❌ PÉRDIDA TOTAL",
  };
  const galeMsg = galeAlert ? GALE_LABELS[galeAlert] : null;
  const isEnter = signal?.signal === "ENTER";
  const nextMsg = signal
    ? `${isEnter ? "✅ ENTRAR" : "⏳ ESPERAR"} | ${signal.confidence?.toFixed(0)}%`
    : "";
  try {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: `Aviator: ${multiplier.toFixed(2)}x ${galeMsg ? "— " + galeMsg : ""}`,
      message: nextMsg,
      priority: galeAlert === "GALE_TRIGGERED" ? 2 : isEnter ? 2 : 0,
    });
  } catch { /* notifications optional */ }
}
