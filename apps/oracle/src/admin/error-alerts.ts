import { env } from "../env.js";
import { countErrorEventsSince } from "../store.js";

type AlertResult = {
  sent: boolean;
  reason: string;
  observedCount?: number;
};

let lastAlertAtMs = 0;

const parseBoolean = (value: string | undefined) => String(value ?? "").trim().toLowerCase() === "true";
const parsePositiveInt = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

const sendWebhookAlert = async (text: string) => {
  const url = String(env.ERROR_ALERT_WEBHOOK_URL ?? "").trim();
  if (!url) return false;
  await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(env.ERROR_ALERT_WEBHOOK_API_KEY
        ? { "x-api-key": String(env.ERROR_ALERT_WEBHOOK_API_KEY).trim() }
        : {}),
    },
    body: JSON.stringify({
      event: "error-alert",
      message: text,
      at: new Date().toISOString(),
    }),
  });
  return true;
};

const sendTelegramAlert = async (text: string) => {
  const token = String(env.ERROR_ALERT_TELEGRAM_BOT_TOKEN ?? "").trim();
  const chatId = String(env.ERROR_ALERT_TELEGRAM_CHAT_ID ?? "").trim();
  if (!token || !chatId) return false;

  const endpoint = `https://api.telegram.org/bot${token}/sendMessage`;
  await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });
  return true;
};

export const getErrorAlertPublicConfig = () => ({
  enabled: parseBoolean(env.ERROR_ALERTS_ENABLED),
  windowMinutes: parsePositiveInt(env.ERROR_ALERT_WINDOW_MINUTES, 5),
  threshold: parsePositiveInt(env.ERROR_ALERT_THRESHOLD, 20),
  minSeverity: String(env.ERROR_ALERT_MIN_SEVERITY ?? "error").toLowerCase(),
  cooldownMinutes: parsePositiveInt(env.ERROR_ALERT_COOLDOWN_MINUTES, 15),
  channelConfigured: {
    webhook: Boolean(String(env.ERROR_ALERT_WEBHOOK_URL ?? "").trim()),
    telegram: Boolean(
      String(env.ERROR_ALERT_TELEGRAM_BOT_TOKEN ?? "").trim() &&
        String(env.ERROR_ALERT_TELEGRAM_CHAT_ID ?? "").trim(),
    ),
  },
});

export const maybeTriggerErrorAlert = async (): Promise<AlertResult> => {
  const config = getErrorAlertPublicConfig();
  if (!config.enabled) return { sent: false, reason: "disabled" };

  const nowMs = Date.now();
  const cooldownMs = config.cooldownMinutes * 60 * 1000;
  if (lastAlertAtMs > 0 && nowMs - lastAlertAtMs < cooldownMs) {
    return { sent: false, reason: "cooldown" };
  }

  const sinceIso = new Date(nowMs - config.windowMinutes * 60 * 1000).toISOString();
  const observedCount = await countErrorEventsSince(sinceIso, config.minSeverity);
  if (observedCount < config.threshold) {
    return { sent: false, reason: "below-threshold", observedCount };
  }

  const alertText = [
    "Valcore Error Alarm",
    `Window: last ${config.windowMinutes}m`,
    `Threshold: ${config.threshold}`,
    `Min severity: ${config.minSeverity}`,
    `Observed: ${observedCount}`,
    `Time: ${new Date(nowMs).toISOString()}`,
  ].join("\n");

  let sentToAny = false;
  const failures: string[] = [];

  try {
    const sent = await sendWebhookAlert(alertText);
    if (sent) sentToAny = true;
  } catch (error) {
    failures.push(error instanceof Error ? error.message : "webhook-failed");
  }

  try {
    const sent = await sendTelegramAlert(alertText);
    if (sent) sentToAny = true;
  } catch (error) {
    failures.push(error instanceof Error ? error.message : "telegram-failed");
  }

  if (!sentToAny) {
    return {
      sent: false,
      reason: failures.length ? `send-failed:${failures.join("; ")}` : "no-channel",
      observedCount,
    };
  }

  lastAlertAtMs = nowMs;
  return { sent: true, reason: "sent", observedCount };
};
