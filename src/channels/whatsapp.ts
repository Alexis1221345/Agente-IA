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
 * Sends a text message via Meta Cloud API (WhatsApp Business).
 * Requires META_PHONE_NUMBER_ID and META_ACCESS_TOKEN in environment.
 */
export async function sendWhatsAppMessage(to: string, text: string): Promise<void> {
  const phoneNumberId = process.env.META_PHONE_NUMBER_ID;
  const accessToken = process.env.META_ACCESS_TOKEN;

  if (!phoneNumberId || !accessToken) {
    throw new Error("Faltan META_PHONE_NUMBER_ID y/o META_ACCESS_TOKEN en .env");
  }

  // Enviamos el número TAL CUAL llega del webhook de Meta, sin modificarlo.
  // (Meta ya entrega el número en el formato que su propia API espera.)

  const url = `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Meta API error ${res.status}: ${detail}`);
  }
}