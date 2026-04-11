(function () {
  "use strict";

  const HOST_OK = location.hostname.includes("betwinner");
  if (!HOST_OK) return;

  console.log("[Aviator Research] content script active on", location.hostname);

  document.addEventListener("__aviator_research_round", (event) => {
    const multiplier = event.detail?.multiplier;
    if (!multiplier) return;
    console.log(`[Aviator Research] forwarding round ${multiplier}x from ${event.detail?.source ?? "injector"}`);
    chrome.runtime.sendMessage(
      { type: "ADD_ROUND", multiplier, source: event.detail?.source ?? "injector" },
      () => void chrome.runtime.lastError,
    );
  });

  let lastStableValue = null;
  let stableHits = 0;
  let lastSentAt = 0;

  const SELECTORS = [
    "[class*='payout']",
    "[class*='cashout']",
    "[class*='multiplier']",
    "[class*='coefficient']",
    "[class*='coef']",
    "[class*='crash']",
    "#multiplier",
    "#coefficient",
    "#crash-coeff",
  ];

  function cleanText(text) {
    return String(text ?? "")
      .replace(",", ".")
      .replace("×", "")
      .replace(/x$/i, "")
      .trim();
  }

  function readMultiplierFromDom() {
    for (const selector of SELECTORS) {
      const nodes = document.querySelectorAll(selector);
      for (const node of nodes) {
        const text = cleanText(node.textContent);
        const value = Number.parseFloat(text);
        if (Number.isFinite(value) && value >= 1 && value <= 1000) {
          return Number(value.toFixed(2));
        }
      }
    }
    return null;
  }

  function sendRound(multiplier) {
    const now = Date.now();
    if (now - lastSentAt < 4000) return;
    lastSentAt = now;

    chrome.runtime.sendMessage(
      { type: "ADD_ROUND", multiplier, source: "dom-auto" },
      () => void chrome.runtime.lastError,
    );
  }

  setInterval(() => {
    const current = readMultiplierFromDom();
    if (!current) return;

    if (current === lastStableValue) {
      stableHits++;
    } else {
      lastStableValue = current;
      stableHits = 1;
    }

    if (stableHits >= 3) {
      sendRound(current);
      stableHits = 0;
      lastStableValue = null;
    }
  }, 900);
})();
