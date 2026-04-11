/**
 * Injector - runs in MAIN world (same scope as the page JS)
 * Intercepts WebSocket + Fetch + XHR + DOM to capture Aviator round results.
 * v2.1 - binary Protocol Buffer scanning + debug mode
 */
(function () {
  "use strict";

  if (window.__aviatorInjected) return;
  window.__aviatorInjected = true;

  // ─── Debug mode (set window.__aviatorDebug = true in console to enable) ──────
  function dbg(...args) {
    if (window.__aviatorDebug) console.log("[Aviator Ext]", ...args);
  }

  // ─── Deduplication ──────────────────────────────────────────────────────────
  let lastDispatch = { mult: null, time: 0 };

  function dispatchRound(multiplier, source) {
    const now = Date.now();
    if (lastDispatch.mult === multiplier && now - lastDispatch.time < 2000) return;
    lastDispatch = { mult: multiplier, time: now };

    const evt = new CustomEvent("__aviator_round", {
      detail: { multiplier: parseFloat(multiplier.toFixed(2)) },
      bubbles: true,
    });
    document.dispatchEvent(evt);
    console.log(`[Aviator Ext] ✅ Round captured via ${source}: ${multiplier.toFixed(2)}x`);
  }

  // ─── Multiplier extraction from JSON objects ─────────────────────────────────
  function extractMultiplier(obj) {
    if (!obj || typeof obj !== "object") return null;
    const keys = [
      "crash_factor", "crashFactor", "x", "koeff", "coefficient",
      "multiplier", "factor", "result", "coeff", "k",
      "value", "rate", "odd", "odds", "win", "winMultiplier",
      "crash", "cashout", "payout",
    ];
    for (const key of keys) {
      if (key in obj) {
        const n = parseFloat(obj[key]);
        if (!isNaN(n) && n >= 1.0 && n <= 10000) return n;
      }
    }
    const nested = [
      "data", "result", "payload", "game", "round", "info",
      "game_result", "message", "event_data", "crash", "details",
    ];
    for (const key of nested) {
      if (obj[key] && typeof obj[key] === "object") {
        const found = extractMultiplier(obj[key]);
        if (found) return found;
      }
    }
    return null;
  }

  function isEndAction(action) {
    if (!action) return false;
    const s = String(action).toLowerCase();
    return (
      s.includes("finish") || s.includes("crash") || s.includes("end") ||
      s.includes("stop") || s.includes("lose") || s.includes("bust") ||
      s.includes("round_result") || s.includes("game_result") ||
      s.includes("result") || s.includes("payout") || s.includes("cashout") ||
      s === "stats" || s === "game_stats" || s === "history"
    );
  }

  function scanStringForMultiplier(text) {
    if (typeof text !== "string") return null;
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
    return null;
  }

  function tryParse(text) {
    if (typeof text !== "string") return null;
    const s = text.trim();
    if (!s.startsWith("{") && !s.startsWith("[")) return null;
    try { return JSON.parse(s); } catch { return null; }
  }

  // ─── Binary buffer scanner (Protocol Buffers / custom binary) ───────────────
  // Logs hex sample on first call, then scans all float32 LE values in range 1.0–500.0
  let _binaryLogCount = 0;
  const _binaryOffsetHits = {}; // offset → how many times it gave a valid float

  function processBinary(buf, source) {
    const bytes = new Uint8Array(buf);

    // Step 1: try UTF-8 — some "binary" frames are actually JSON with a header
    try {
      const text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
      const directMult = scanStringForMultiplier(text);
      if (directMult) {
        dispatchRound(directMult, source + ":bin-utf8");
        return;
      }
      // Find first { or [ and try to parse
      const jsonStart = text.search(/[\[{]/);
      if (jsonStart >= 0) {
        const parsed = tryParse(text.slice(jsonStart));
        if (parsed) {
          const items = Array.isArray(parsed) ? parsed : [parsed];
          for (const item of items) {
            const action = item?.action ?? item?.type ?? item?.event ?? item?.cmd;
            if (isEndAction(action) || text.includes("crash") || text.includes("result")) {
              const mult = extractMultiplier(item);
              if (mult) { dispatchRound(mult, source + ":bin-json"); return; }
            }
          }
        }
      }
    } catch {}

    // Step 2: hex dump first 80 bytes (first 3 binary messages only, or when debug on)
    if (_binaryLogCount < 3 || window.__aviatorDebug) {
      _binaryLogCount++;
      const hex = Array.from(bytes.slice(0, 80))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(" ");
      console.log(`[Aviator Ext] Binary msg #${_binaryLogCount} (${buf.byteLength}B) hex: ${hex}`);
    }

    // Step 3: scan all float32 LE values in multiplier range 1.01–500
    const view = new DataView(buf);
    const candidates = [];
    for (let i = 0; i <= buf.byteLength - 4; i++) {
      const f = view.getFloat32(i, true); // little-endian
      if (isFinite(f) && f >= 1.01 && f <= 500) {
        candidates.push({ off: i, v: parseFloat(f.toFixed(2)) });
        // Track which offsets consistently produce valid floats
        _binaryOffsetHits[i] = (_binaryOffsetHits[i] || 0) + 1;
      }
    }

    if (candidates.length > 0) {
      dbg("float32 LE candidates:", JSON.stringify(candidates.slice(0, 12)));
    }

    // Step 4: if a specific offset has been consistently valid (≥5 messages), use it
    const hotOffset = Object.entries(_binaryOffsetHits)
      .filter(([, count]) => count >= 5)
      .sort(([, a], [, b]) => b - a)[0]?.[0];

    if (hotOffset !== undefined && buf.byteLength > parseInt(hotOffset) + 4) {
      const f = view.getFloat32(parseInt(hotOffset), true);
      if (isFinite(f) && f >= 1.01 && f <= 500) {
        dbg(`Hot offset ${hotOffset} → ${f.toFixed(2)}x`);
        // Don't auto-dispatch from hot offset alone — need end signal
      }
    }
  }

  // ─── Text message processor ─────────────────────────────────────────────────
  function processTextMessage(text, source) {
    if (!text || text.length < 3) return;

    const directMult = scanStringForMultiplier(text);
    if (directMult) {
      dispatchRound(directMult, source + ":scan");
      return;
    }

    const parsed = tryParse(text);
    if (!parsed) return;

    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const action = item.action ?? item.type ?? item.event ??
        item.cmd ?? item.command ?? item.msg ??
        item.message?.type ?? item.name ?? item.event_name;

      if (isEndAction(action)) {
        const mult = extractMultiplier(item);
        if (mult) { dispatchRound(mult, source + ":action"); return; }
      }

      if (
        text.includes("crash") || text.includes("finish") ||
        text.includes("result") || text.includes("koeff") ||
        text.includes("crash_factor")
      ) {
        const mult = extractMultiplier(item);
        if (mult) { dispatchRound(mult, source + ":fallback"); return; }
      }
    }
  }

  // ─── Generic message router ─────────────────────────────────────────────────
  function processMessage(raw, source) {
    if (typeof raw === "string") {
      processTextMessage(raw, source);
    } else if (raw instanceof ArrayBuffer) {
      processBinary(raw, source);
    } else if (raw instanceof Blob) {
      raw.arrayBuffer().then((buf) => {
        try { processBinary(buf, source + ":blob"); } catch {}
      });
    }
  }

  // ─── WebSocket Interception — Layer 1: constructor patch ────────────────────
  const OriginalWebSocket = window.WebSocket;

  class PatchedWebSocket extends OriginalWebSocket {
    constructor(url, protocols) {
      super(url, protocols);
      const wsUrl = typeof url === "string" ? url : (url?.href ?? "");
      console.log(`[Aviator Ext] 🔌 WS(constructor) frame:[${location.hostname}] → ${wsUrl}`);
      this.addEventListener("message", (event) => {
        try { processMessage(event.data, "ws-ctor:" + (wsUrl.split("/")[2] ?? "?")); } catch {}
      });
    }
  }

  Object.defineProperty(PatchedWebSocket, "CONNECTING", { value: OriginalWebSocket.CONNECTING });
  Object.defineProperty(PatchedWebSocket, "OPEN", { value: OriginalWebSocket.OPEN });
  Object.defineProperty(PatchedWebSocket, "CLOSING", { value: OriginalWebSocket.CLOSING });
  Object.defineProperty(PatchedWebSocket, "CLOSED", { value: OriginalWebSocket.CLOSED });
  window.WebSocket = PatchedWebSocket;

  // ─── WebSocket Interception — Layer 2: prototype onmessage setter ───────────
  // Catches ws.onmessage = fn assignments (bypasses constructor patch)
  try {
    const OrigProto = OriginalWebSocket.prototype;
    const OrigDesc = Object.getOwnPropertyDescriptor(OrigProto, "onmessage");
    if (OrigDesc && OrigDesc.set) {
      Object.defineProperty(OrigProto, "onmessage", {
        configurable: true,
        get: OrigDesc.get,
        set(fn) {
          const host = (() => { try { return new URL(this.url).host; } catch { return "?"; } })();
          console.log(`[Aviator Ext] 🔌 WS(onmessage setter) frame:[${location.hostname}] → ${host}`);
          const self = this;
          return OrigDesc.set.call(this, function (event) {
            try { processMessage(event.data, "ws-setter:" + host); } catch {}
            return fn.call(self, event);
          });
        },
      });
    }
  } catch {}

  // ─── WebSocket Interception — Layer 3: EventTarget.prototype.addEventListener
  // Catches any addEventListener("message", ...) on any WebSocket instance
  try {
    const OrigAddEL = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, listener, ...rest) {
      if (type === "message" && this instanceof OriginalWebSocket) {
        const host = (() => { try { return new URL(this.url).host; } catch { return "?"; } })();
        console.log(`[Aviator Ext] 🔌 WS(addEventListener) frame:[${location.hostname}] → ${host}`);
        const wrappedListener = function (event) {
          try { processMessage(event.data, "ws-ael:" + host); } catch {}
          return listener.apply(this, arguments);
        };
        return OrigAddEL.call(this, type, wrappedListener, ...rest);
      }
      return OrigAddEL.call(this, type, listener, ...rest);
    };
  } catch {}

  // ─── Fetch Interception ─────────────────────────────────────────────────────
  const OriginalFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await OriginalFetch.apply(this, args);
    try {
      const url = typeof args[0] === "string" ? args[0] : (args[0]?.url ?? "");
      if (
        url.includes("history") || url.includes("rounds") ||
        url.includes("results") || url.includes("bets") ||
        url.includes("games") || url.includes("crash") ||
        url.includes("game_result") || url.includes("spribe")
      ) {
        const clone = res.clone();
        clone.text().then((text) => {
          const mult = scanStringForMultiplier(text);
          if (mult) { dispatchRound(mult, "fetch:scan"); return; }
          const json = tryParse(text);
          if (!json) return;
          const arr = Array.isArray(json) ? json :
            json?.data ?? json?.rounds ?? json?.results ?? json?.games ?? [];
          if (Array.isArray(arr) && arr.length > 0) {
            const m = extractMultiplier(arr[0]);
            if (m) { dispatchRound(m, "fetch:array"); return; }
          }
          const m = extractMultiplier(json);
          if (m) dispatchRound(m, "fetch:obj");
        }).catch(() => {});
      }
    } catch {}
    return res;
  };

  // ─── XHR Interception ──────────────────────────────────────────────────────
  const OriginalXHR = window.XMLHttpRequest;
  function PatchedXHR() {
    const xhr = new OriginalXHR();
    const origOpen = xhr.open.bind(xhr);
    xhr.open = function (method, url, ...rest) {
      xhr._url = String(url ?? "");
      return origOpen(method, url, ...rest);
    };
    xhr.addEventListener("load", function () {
      try {
        const url = xhr._url ?? "";
        if (
          url.includes("history") || url.includes("rounds") ||
          url.includes("result") || url.includes("crash") || url.includes("spribe")
        ) {
          const mult = scanStringForMultiplier(xhr.responseText);
          if (mult) dispatchRound(mult, "xhr");
        }
      } catch {}
    });
    return xhr;
  }
  PatchedXHR.prototype = OriginalXHR.prototype;
  window.XMLHttpRequest = PatchedXHR;

  // ─── postMessage Listener (handles binary from Web Workers too) ─────────────
  window.addEventListener("message", (event) => {
    try {
      const d = event.data;
      if (typeof d === "string") {
        processTextMessage(d, "postmsg");
      } else if (d instanceof ArrayBuffer) {
        console.log(`[Aviator Ext] 📨 postMsg binary (${d.byteLength}B) from worker`);
        processBinary(d, "postmsg-bin");
      } else if (ArrayBuffer.isView(d)) {
        console.log(`[Aviator Ext] 📨 postMsg typed array (${d.byteLength}B) from worker`);
        processBinary(d.buffer, "postmsg-typedarray");
      } else if (d && typeof d === "object") {
        // Object from worker — try JSON stringify
        const str = JSON.stringify(d);
        if (str && str.length > 3) processTextMessage(str, "postmsg-obj");
      }
    } catch {}
  });

  // ─── Worker constructor patch — intercepts messages from Web Workers ─────────
  // Spribe Aviator runs its WebSocket inside a Worker; messages are postMessage'd back
  try {
    const OrigWorker = window.Worker;
    window.Worker = function (scriptURL, options) {
      const worker = new OrigWorker(scriptURL, options);
      const shortUrl = String(scriptURL).split("/").pop()?.slice(0, 40) ?? "?";
      console.log(`[Aviator Ext] 👷 Worker created: ${shortUrl}`);
      const origAddEL = worker.addEventListener.bind(worker);
      worker.addEventListener = function (type, listener, ...rest) {
        if (type === "message") {
          const wrapped = function (event) {
            const d = event.data;
            if (typeof d === "string") {
              processTextMessage(d, "worker-msg");
            } else if (d instanceof ArrayBuffer) {
              console.log(`[Aviator Ext] 📨 Worker binary msg (${d.byteLength}B)`);
              processBinary(d, "worker-bin");
            } else if (ArrayBuffer.isView(d)) {
              processBinary(d.buffer, "worker-typedarray");
            } else if (d && typeof d === "object") {
              const str = JSON.stringify(d);
              if (str && str.length > 3) processTextMessage(str, "worker-obj");
            }
            return listener.apply(this, arguments);
          };
          return origAddEL(type, wrapped, ...rest);
        }
        return origAddEL(type, listener, ...rest);
      };
      const origOnMsg = Object.getOwnPropertyDescriptor(worker.__proto__, "onmessage");
      if (origOnMsg && origOnMsg.set) {
        Object.defineProperty(worker, "onmessage", {
          configurable: true,
          get: () => origOnMsg.get?.call(worker),
          set(fn) {
            return origOnMsg.set.call(worker, function (event) {
              try {
                const d = event.data;
                if (d instanceof ArrayBuffer) processBinary(d, "worker-onmsg-bin");
                else if (typeof d === "string") processTextMessage(d, "worker-onmsg");
                else if (d && typeof d === "object") {
                  const str = JSON.stringify(d);
                  if (str && str.length > 3) processTextMessage(str, "worker-onmsg-obj");
                }
              } catch {}
              return fn.call(this, event);
            });
          },
        });
      }
      return worker;
    };
    window.Worker.prototype = OrigWorker.prototype;
  } catch (e) {
    console.log("[Aviator Ext] Worker patch failed:", e.message);
  }

  // ─── DOM Scanner — Spribe-specific selectors ────────────────────────────────
  const SPRIBE_SELECTORS = [
    "[class*='paycoef']", "[class*='payCoef']",
    "[class*='crash-coef']", "[class*='crashCoef']",
    "[class*='bubble-coef']", "[class*='bubbleCoef']",
    "[class*='coeff']", "[class*='coefficient']",
    "[class*='multiplier']", "[class*='cashout']",
    "[class*='coef']", "[class*='result']",
    "#crash-coeff", "#multiplier", "#coefficient",
    "[class*='game-coef']", "[class*='gameCoef']",
    "[class*='win-coef']", "[class*='winCoef']",
    "[class*='payout-coef']",
  ].join(", ");

  let frozenCount = 0;
  let lastFrozenMult = null;

  setInterval(() => {
    try {
      const docs = [document];
      document.querySelectorAll("iframe").forEach((f) => {
        try { if (f.contentDocument) docs.push(f.contentDocument); } catch {}
      });
      for (const doc of docs) {
        let elements;
        try { elements = doc.querySelectorAll(SPRIBE_SELECTORS); } catch { continue; }
        for (const el of elements) {
          try {
            const raw = (el.textContent ?? "").trim()
              .replace(",", ".").replace("×", "").replace(/x$/i, "").trim();
            const n = parseFloat(raw);
            if (isNaN(n) || n < 1.0 || n > 10000) continue;
            if (n === lastFrozenMult) {
              frozenCount++;
            } else {
              lastFrozenMult = n;
              frozenCount = 1;
            }
            if (frozenCount === 3) {
              dispatchRound(n, "dom");
              frozenCount = 0;
              lastFrozenMult = null;
            }
          } catch {}
        }
      }
    } catch {}
  }, 800);

  console.log("[Aviator Ext] 🚀 Injector v2.2 loaded — WS+Worker+postMsg interception active");
  console.log("[Aviator Ext] 💡 Tip: run `window.__aviatorDebug = true` in console for verbose logs");
})();
