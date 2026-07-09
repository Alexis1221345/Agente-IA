import { describe, it, expect } from "vitest";
import { parseWebhookPayload } from "../src/whatsapp/channels/whatsapp.js";

function makePayload(overrides: Record<string, unknown> = {}) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                {
                  type: "text",
                  from: "521XXXXXXXXXX",
                  id: "wamid.abc123",
                  text: { body: "Hola, quiero una reserva" },
                },
              ],
              ...overrides,
            },
          },
        ],
      },
    ],
  };
}

describe("parseWebhookPayload", () => {
  it("devuelve el objeto correcto para un mensaje de texto válido", () => {
    const result = parseWebhookPayload(makePayload());
    expect(result).toEqual({
      from: "521XXXXXXXXXX",
      body: "Hola, quiero una reserva",
      messageId: "wamid.abc123",
    });
  });

  it("devuelve null para un webhook de status (value.statuses, sin messages)", () => {
    const payload = makePayload({ statuses: [{ id: "wamid.abc123", status: "delivered" }] });
    // Quita messages del value
    const value = (payload.entry[0].changes[0] as Record<string, unknown>).value as Record<string, unknown>;
    delete value.messages;
    expect(parseWebhookPayload(payload)).toBeNull();
  });

  it("devuelve null para un messages[0] sin campo 'from'", () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  { type: "text", id: "wamid.abc123", text: { body: "hola" } },
                ],
              },
            },
          ],
        },
      ],
    };
    expect(parseWebhookPayload(payload)).toBeNull();
  });

  it("devuelve null para un messages[0] con from vacío", () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  { type: "text", from: "  ", id: "wamid.abc123", text: { body: "hola" } },
                ],
              },
            },
          ],
        },
      ],
    };
    expect(parseWebhookPayload(payload)).toBeNull();
  });

  it("devuelve null para un messages[0] sin text.body", () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  { type: "text", from: "521XXXXXXXXXX", id: "wamid.abc123", text: {} },
                ],
              },
            },
          ],
        },
      ],
    };
    expect(parseWebhookPayload(payload)).toBeNull();
  });

  it("devuelve null para type != text (ej. image, audio)", () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  { type: "image", from: "521XXXXXXXXXX", id: "wamid.abc123" },
                ],
              },
            },
          ],
        },
      ],
    };
    expect(parseWebhookPayload(payload)).toBeNull();
  });

  it("devuelve null para object distinto de whatsapp_business_account", () => {
    const payload = { object: "instagram", entry: [] };
    expect(parseWebhookPayload(payload)).toBeNull();
  });

  it("devuelve null para payload malformado (no truena)", () => {
    expect(parseWebhookPayload(null)).toBeNull();
    expect(parseWebhookPayload({})).toBeNull();
    expect(parseWebhookPayload("string")).toBeNull();
  });
});
