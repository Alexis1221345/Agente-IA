export interface IncomingWhatsAppMessage {
  from: string;   // phone number with country code, e.g. "521XXXXXXXXXX"
  body: string;
  messageId: string;
}

/**
 * Extracts the first text message from a Meta Cloud API webhook payload.
 * Returns null for non-message events (status updates, read receipts, etc.).
 */
export function parseWebhookPayload(body: unknown): IncomingWhatsAppMessage | null {
  try {
    const payload = body as Record<string, unknown>;
    if (payload.object !== "whatsapp_business_account") return null;

    const entry = (payload.entry as Record<string, unknown>[])?.[0];
    const change = (entry?.changes as Record<string, unknown>[])?.[0];
    const value = change?.value as Record<string, unknown>;
    const messages = value?.messages as Record<string, unknown>[] | undefined;

    if (!messages?.length) return null;

    const msg = messages[0];
    if (msg.type !== "text") return null;

    const text = msg.text as Record<string, unknown>;

    if (typeof msg.from !== "string" || !msg.from.trim()) return null;
    if (typeof text?.body !== "string" || !text.body.trim()) return null;
    if (typeof msg.id !== "string") return null;

    return {
      from: msg.from,
      body: text.body,
      messageId: msg.id,
    };
  } catch {
    return null;
  }
}

/**
 * Returns the sender's phone number if the webhook payload contains a non-text
 * media message (image, audio, video, sticker, document, location).
 * Returns null for text messages, status updates, read receipts, etc.
 */
export function parseWebhookMediaSender(body: unknown): string | null {
  try {
    const payload = body as Record<string, unknown>;
    if (payload.object !== "whatsapp_business_account") return null;

    const entry = (payload.entry as Record<string, unknown>[])?.[0];
    const change = (entry?.changes as Record<string, unknown>[])?.[0];
    const value = change?.value as Record<string, unknown>;
    const messages = value?.messages as Record<string, unknown>[] | undefined;

    if (!messages?.length) return null;

    const msg = messages[0];
    const MEDIA_TYPES = ["image", "audio", "video", "sticker", "document", "location"];
    if (!MEDIA_TYPES.includes(msg.type as string)) return null;

    return typeof msg.from === "string" && msg.from.trim() ? msg.from : null;
  } catch {
    return null;
  }
}

/**
 * México móvil: el webhook entrega wa_id como 521XXXXXXXXXX pero la API de envío
 * espera 52XXXXXXXXXX. Quitamos el '1' intermedio para números mexicanos móviles.
 */
function normalizePhoneForSend(phone: string): string {
  if (phone.startsWith("521") && phone.length === 13) {
    return "52" + phone.slice(3);
  }
  return phone;
}

/**
 * Sends a text message via Meta Cloud API (WhatsApp Business).
 * Requires META_PHONE_NUMBER_ID and META_ACCESS_TOKEN in environment.
 */
export async function sendWhatsAppMessage(to: string, text: string): Promise<void> {
  const phoneNumberId = process.env.META_PHONE_NUMBER_ID;
  const accessToken = process.env.META_ACCESS_TOKEN;

  if (!phoneNumberId || !accessToken) {
    throw new Error("Faltan META_PHONE_NUMBER_ID y/o META_ACCESS_TOKEN en .env");
  }

  const normalizedTo = normalizePhoneForSend(to);

  const url = `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: normalizedTo,
      type: "text",
      text: { body: text },
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Meta API error ${res.status}: ${detail}`);
  }
}