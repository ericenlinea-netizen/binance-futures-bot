import { logger } from "./logger";

const TELEGRAM_API = "https://api.telegram.org";

export async function sendTelegramMessage(text: string): Promise<void> {
  const token = process.env["TELEGRAM_TOKEN"];
  const chatId = process.env["TELEGRAM_CHAT_ID"];

  if (!token || !chatId) {
    logger.warn("Telegram not configured (TELEGRAM_TOKEN or TELEGRAM_CHAT_ID missing)");
    return;
  }

  try {
    const url = `${TELEGRAM_API}/bot${token}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "Markdown",
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      logger.warn({ status: res.status, body }, "Telegram API returned non-OK response");
    }
  } catch (err) {
    logger.warn({ err }, "Failed to send Telegram message");
  }
}

export function formatSignalMessage(
  multiplier: number,
  signal: "ENTER" | "WAIT",
  confidence: number,
  streak: number,
  reason: string,
): string {
  const emoji = signal === "ENTER" ? "🟢" : "🔴";
  const action = signal === "ENTER" ? "ENTRAR ✅" : "ESPERAR ⏳";

  return (
    `${emoji} *Aviator Signal Bot*\n` +
    `━━━━━━━━━━━━━━━\n` +
    `📊 Ronda registrada: *${multiplier.toFixed(2)}x*\n` +
    `🎯 Señal: *${action}*\n` +
    `📈 Confianza: *${confidence.toFixed(0)}%*\n` +
    `🔴 Racha de pérdidas: *${streak}*\n` +
    `💡 Razón: _${reason}_\n` +
    `━━━━━━━━━━━━━━━`
  );
}
