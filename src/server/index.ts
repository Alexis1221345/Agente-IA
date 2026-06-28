import { config } from "dotenv";
config();

import Fastify from "fastify";
import { ReservationAgent } from "../core/agent.js";
import { ClaudeLLMClient } from "../integrations/llm/claude.js";
import { restaurantRegistry } from "../config/demo.js";
import { parseWebhookPayload, sendWhatsAppMessage } from "../channels/whatsapp.js";

const PORT = Number(process.env.PORT ?? 3000);
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN ?? "";
const RESTAURANT_ID = process.env.RESTAURANT_ID ?? "demo";

// ── Startup checks ────────────────────────────────────────────
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) { console.error("Falta ANTHROPIC_API_KEY en .env"); process.exit(1); }
if (!VERIFY_TOKEN) { console.error("Falta META_VERIFY_TOKEN en .env"); process.exit(1); }
if (!process.env.META_ACCESS_TOKEN) { console.error("Falta META_ACCESS_TOKEN en .env"); process.exit(1); }
if (!process.env.META_PHONE_NUMBER_ID) { console.error("Falta META_PHONE_NUMBER_ID en .env"); process.exit(1); }

// ── Agent ─────────────────────────────────────────────────────
const agent = new ReservationAgent(
  new ClaudeLLMClient(apiKey),
  restaurantRegistry,
);

// ── Server ────────────────────────────────────────────────────
const app = Fastify({ logger: true });

/** Meta webhook verification handshake */
app.get("/webhook", async (req, reply) => {
  const q = req.query as Record<string, string>;
  if (q["hub.mode"] === "subscribe" && q["hub.verify_token"] === VERIFY_TOKEN) {
    return reply.send(q["hub.challenge"]);
  }
  return reply.status(403).send("Forbidden");
});

/** Incoming WhatsApp messages */
app.post("/webhook", async (req, reply) => {
  // Meta requires 200 immediately — we process async
  reply.status(200).send("ok");

  const msg = parseWebhookPayload(req.body);
  if (!msg) {
    app.log.debug("[webhook] Payload ignorado (status update o no-text)");
    return;
  }

  console.log(`[webhook] Mensaje de ${msg.from}: "${msg.body}"`);

  try {
    const response = await agent.handleMessage(msg.from, msg.body, RESTAURANT_ID);
    console.log(`[webhook] Respuesta a ${msg.from}: "${response.slice(0, 120)}${response.length > 120 ? "…" : ""}"`);
    await sendWhatsAppMessage(msg.from, response);
    console.log(`[webhook] Mensaje enviado OK a ${msg.from}`);
  } catch (err) {
    console.error("[webhook] Error procesando mensaje:", err);
  }
});

app.get("/health", async () => ({ status: "ok", restaurant: restaurantRegistry[RESTAURANT_ID]?.name }));

app.listen({ port: PORT, host: "0.0.0.0" }, (err, address) => {
  if (err) { app.log.error(err); process.exit(1); }
  const cfg = restaurantRegistry[RESTAURANT_ID];
  console.log(`\n🚀  Servidor en ${address}`);
  console.log(`🍽️   Restaurante: ${cfg?.name} (${RESTAURANT_ID})`);
  console.log(`📅  Calendario: ${cfg?.calendarId}`);
  console.log(`📲  Webhook: ${address}/webhook\n`);

  // Render free tier hiberna tras 15 min sin tráfico — ping cada 10 min para mantenerse activo
  const publicUrl = process.env.RENDER_EXTERNAL_URL;
  if (publicUrl) {
    setInterval(() => {
      fetch(`${publicUrl}/health`).catch(() => {});
    }, 10 * 60 * 1000);
    console.log(`⏰  Keep-alive activo → ${publicUrl}/health cada 10 min`);
  }
});
