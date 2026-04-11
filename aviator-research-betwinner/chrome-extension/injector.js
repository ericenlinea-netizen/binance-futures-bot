(function () {
  "use strict";

  if (!location.hostname.includes("betwinner")) return;
  if (window.__aviatorResearchInjected) return;
  window.__aviatorResearchInjected = true;

  function dbg(...args) {
    if (window.__aviatorDebug) console.log("[Aviator Research]", ...args);
  }

  console.log("[Aviator Research] injector loaded on", location.hostname);

  let lastDispatch = { mult: null, time: 0 };
  let binaryLogCount = 0;
  const binaryOffsetHits = {};

  function dispatchRound(multiplier, source) {
    const normalized = Number.parseFloat(Number(multiplier).toFixed(2));
    if (!Number.isFinite(normalized) || normalized < 1 || normalized > 1000) return;

    const now = Date.now();
    if (lastDispatch.mult === normalized && now - lastDispatch.time < 2500) return;
    lastDispatch = { mult: normalized, time: now };

    document.dispatchEvent(new CustomEvent("__aviator_research_round", {
      detail: { multiplier: normalized, source },
      bubbles: true,
    }));

    console.log(`[Aviator Research] round detected via ${source}: ${normalized}x`);
  }

  function extractMultiplier(obj) {
    if (!obj || typeof obj !== "object") return null;
    const keys = [
      "crash_factor", "crashFactor", "x", "koeff", "coefficient",
      "multiplier", "factor", "result", "coeff", "k",
      "value", "rate", "odd", "odds", "win", "winMultiplier",
      "crash", "cashout", "payout",
    ];
    for (const key of keys) {
      if (!(key in obj)) continue;
      const value = Number.parseFloat(obj[key]);
      if (Number.isFinite(value) && value >= 1 && value <= 10000) return value;
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
    const value = String(action).toLowerCase();
    return (
      value.includes("finish") || value.includes("crash") || value.includes("end") ||
      value.includes("stop") || value.includes("lose") || value.includes("bust") ||
      value.includes("round_result") || value.includes("game_result") ||
      value.includes("result") || value.includes("payout") || value.includes("cashout") ||
      value === "stats" || value === "game_stats" || value === "history"
    );
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

  function tryParse(text) {
    if (typeof text !== "string") return null;
    const trimmed = text.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
    try { return JSON.parse(trimmed); } catch { return null; }
  }

  function processBinary(buf, source) {
    const bytes = new Uint8Array(buf);

    try {
      const text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
      const directMult = scanStringForMultiplier(text);
      if (directMult) {
        dispatchRound(directMult, `${source}:bin-utf8`);
        return;
      }

      const jsonStart = text.search(/[\[{]/);
      if (jsonStart >= 0) {
        const parsed = tryParse(text.slice(jsonStart));
        if (parsed) {
          const items = Array.isArray(parsed) ? parsed : [parsed];
          for (const item of items) {
            const action = item?.action ?? item?.type ?? item?.event ?? item?.cmd;
            if (isEndAction(action) || text.includes("crash") || text.includes("result")) {
              const mult = extractMultiplier(item);
              if (mult) {
                dispatchRound(mult, `${source}:bin-json`);
                return;
              }
            }
          }
        }
      }
    } catch {}

    if (binaryLogCount < 5 || window.__aviatorDebug) {
      binaryLogCount++;
      const hex = Array.from(bytes.slice(0, 80))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(" ");
      console.log(`[Aviator Research] binary msg #${binaryLogCount} (${buf.byteLength}B) hex: ${hex}`);
    }

    const view = new DataView(buf);
    const candidates = [];
    for (let offset = 0; offset <= buf.byteLength - 4; offset++) {
      const f = view.getFloat32(offset, true);
      if (Number.isFinite(f) && f >= 1.01 && f <= 500) {
        candidates.push({ off: offset, v: Number.parseFloat(f.toFixed(2)) });
        binaryOffsetHits[offset] = (binaryOffsetHits[offset] || 0) + 1;
      }
    }

    if (candidates.length > 0) {
      dbg("float32 LE candidates:", JSON.stringify(candidates.slice(0, 12)));
    }

    const hotOffset = Object.entries(binaryOffsetHits)
      .filter(([, count]) => count >= 5)
      .sort(([, a], [, b]) => b - a)[0]?.[0];

    if (hotOffset !== undefined && buf.byteLength > Number.parseInt(hotOffset, 10) + 4) {
      const f = view.getFloat32(Number.parseInt(hotOffset, 10), true);
      if (Number.isFinite(f) && f >= 1.01 && f <= 500) {
        dbg(`hot offset ${hotOffset} -> ${f.toFixed(2)}x`);
      }
    }
  }

  function processTextMessage(text, source) {
    if (!text || text.length < 3) return;

    const directMult = scanStringForMultiplier(text);
    if (directMult) {
      dispatchRound(directMult, `${source}:scan`);
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
        if (mult) {
          dispatchRound(mult, `${source}:action`);
          return;
        }
      }

      if (
        text.includes("crash") || text.includes("finish") ||
        text.includes("result") || text.includes("koeff") ||
        text.includes("crash_factor")
      ) {
        const mult = extractMultiplier(item);
        if (mult) {
          dispatchRound(mult, `${source}:fallback`);
          return;
        }
      }
    }
  }

  function processMessage(raw, source) {
    if (typeof raw === "string") {
      processTextMessage(raw, source);
    } else if (raw instanceof ArrayBuffer) {
      processBinary(raw, source);
    } else if (raw instanceof Blob) {
      raw.arrayBuffer().then((buf) => {
        try { processBinary(buf, `${source}:blob`); } catch {}
      });
    }
  }

  const OriginalWebSocket = window.WebSocket;

  class PatchedWebSocket extends OriginalWebSocket {
    constructor(url, protocols) {
      super(url, protocols);
      const wsUrl = typeof url === "string" ? url : (url?.href ?? "");
      console.log("[Aviator Research] websocket attached:", wsUrl);
      this.addEventListener("message", (event) => {
        try { processMessage(event.data, `ws-ctor:${wsUrl.split("/")[2] ?? "?"}`); } catch {}
      });
    }
  }

  Object.defineProperty(PatchedWebSocket, "CONNECTING", { value: OriginalWebSocket.CONNECTING });
  Object.defineProperty(PatchedWebSocket, "OPEN", { value: OriginalWebSocket.OPEN });
  Object.defineProperty(PatchedWebSocket, "CLOSING", { value: OriginalWebSocket.CLOSING });
  Object.defineProperty(PatchedWebSocket, "CLOSED", { value: OriginalWebSocket.CLOSED });
  window.WebSocket = PatchedWebSocket;

  try {
    const originalProto = OriginalWebSocket.prototype;
    const originalDesc = Object.getOwnPropertyDescriptor(originalProto, "onmessage");
    if (originalDesc?.set) {
      Object.defineProperty(originalProto, "onmessage", {
        configurable: true,
        get: originalDesc.get,
        set(fn) {
          const host = (() => { try { return new URL(this.url).host; } catch { return "?"; } })();
          console.log("[Aviator Research] websocket onmessage patched:", host);
          const self = this;
          return originalDesc.set.call(this, function (event) {
            try { processMessage(event.data, `ws-setter:${host}`); } catch {}
            return fn.call(self, event);
          });
        },
      });
    }
  } catch {}

  try {
    const originalAddEventListener = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, listener, ...rest) {
      if (type === "message" && this instanceof OriginalWebSocket) {
        const host = (() => { try { return new URL(this.url).host; } catch { return "?"; } })();
        const wrapped = function (event) {
          try { processMessage(event.data, `ws-ael:${host}`); } catch {}
          return listener.apply(this, arguments);
        };
        return originalAddEventListener.call(this, type, wrapped, ...rest);
      }
      return originalAddEventListener.call(this, type, listener, ...rest);
    };
  } catch {}

  const OriginalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await OriginalFetch.apply(this, args);
    try {
      const url = typeof args[0] === "string" ? args[0] : (args[0]?.url ?? "");
      if (
        url.includes("history") || url.includes("rounds") ||
        url.includes("results") || url.includes("bets") ||
        url.includes("games") || url.includes("crash") ||
        url.includes("game_result") || url.includes("spribe")
      ) {
        response.clone().text().then((text) => {
          const mult = scanStringForMultiplier(text);
          if (mult) {
            dispatchRound(mult, "fetch:scan");
            return;
          }
          const json = tryParse(text);
          if (!json) return;
          const arr = Array.isArray(json) ? json :
            json?.data ?? json?.rounds ?? json?.results ?? json?.games ?? [];
          if (Array.isArray(arr) && arr.length > 0) {
            const m = extractMultiplier(arr[0]);
            if (m) {
              dispatchRound(m, "fetch:array");
              return;
            }
          }
          const m = extractMultiplier(json);
          if (m) dispatchRound(m, "fetch:obj");
        }).catch(() => {});
      }
    } catch {}
    return response;
  };

  const OriginalXHR = window.XMLHttpRequest;
  function PatchedXHR() {
    const xhr = new OriginalXHR();
    const originalOpen = xhr.open.bind(xhr);
    xhr.open = function (method, url, ...rest) {
      xhr._url = String(url ?? "");
      return originalOpen(method, url, ...rest);
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

  window.addEventListener("message", (event) => {
    try {
      const data = event.data;
      if (typeof data === "string") {
        processTextMessage(data, "postmsg");
      } else if (data instanceof ArrayBuffer) {
        console.log(`[Aviator Research] postMessage binary (${data.byteLength}B)`);
        processBinary(data, "postmsg-bin");
      } else if (ArrayBuffer.isView(data)) {
        processBinary(data.buffer, "postmsg-typedarray");
      } else if (data && typeof data === "object") {
        const str = JSON.stringify(data);
        if (str && str.length > 3) processTextMessage(str, "postmsg-obj");
      }
    } catch {}
  });

  try {
    const OriginalWorker = window.Worker;
    window.Worker = function (scriptURL, options) {
      const worker = new OriginalWorker(scriptURL, options);
      const shortUrl = String(scriptURL).split("/").pop()?.slice(0, 50) ?? "?";
      console.log("[Aviator Research] worker created:", shortUrl);

      const originalAddEL = worker.addEventListener.bind(worker);
      worker.addEventListener = function (type, listener, ...rest) {
        if (type === "message") {
          const wrapped = function (event) {
            const data = event.data;
            if (typeof data === "string") processTextMessage(data, "worker-msg");
            else if (data instanceof ArrayBuffer) processBinary(data, "worker-bin");
            else if (ArrayBuffer.isView(data)) processBinary(data.buffer, "worker-typedarray");
            else if (data && typeof data === "object") {
              const str = JSON.stringify(data);
              if (str && str.length > 3) processTextMessage(str, "worker-obj");
            }
            return listener.apply(this, arguments);
          };
          return originalAddEL(type, wrapped, ...rest);
        }
        return originalAddEL(type, listener, ...rest);
      };

      const onMessageDesc = Object.getOwnPropertyDescriptor(worker.__proto__, "onmessage");
      if (onMessageDesc?.set) {
        Object.defineProperty(worker, "onmessage", {
          configurable: true,
          get: () => onMessageDesc.get?.call(worker),
          set(fn) {
            return onMessageDesc.set.call(worker, function (event) {
              try {
                const data = event.data;
                if (data instanceof ArrayBuffer) processBinary(data, "worker-onmsg-bin");
                else if (typeof data === "string") processTextMessage(data, "worker-onmsg");
                else if (data && typeof data === "object") {
                  const str = JSON.stringify(data);
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
    window.Worker.prototype = OriginalWorker.prototype;
  } catch (error) {
    console.log("[Aviator Research] worker patch failed:", error?.message ?? error);
  }

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
      document.querySelectorAll("iframe").forEach((frame) => {
        try { if (frame.contentDocument) docs.push(frame.contentDocument); } catch {}
      });
      for (const doc of docs) {
        let elements;
        try { elements = doc.querySelectorAll(SPRIBE_SELECTORS); } catch { continue; }
        for (const el of elements) {
          try {
            const raw = String(el.textContent ?? "")
              .trim()
              .replace(",", ".")
              .replace("×", "")
              .replace(/x$/i, "")
              .trim();
            const value = Number.parseFloat(raw);
            if (!Number.isFinite(value) || value < 1 || value > 10000) continue;
            if (value === lastFrozenMult) frozenCount++;
            else {
              lastFrozenMult = value;
              frozenCount = 1;
            }
            if (frozenCount === 3) {
              dispatchRound(value, "dom");
              frozenCount = 0;
              lastFrozenMult = null;
            }
          } catch {}
        }
      }
    } catch {}
  }, 800);

  console.log("[Aviator Research] WS+Worker+postMessage interception active");
  console.log("[Aviator Research] tip: run window.__aviatorDebug = true for verbose logs");
})();
