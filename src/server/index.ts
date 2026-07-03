import { config } from "dotenv";
config();

import Fastify from "fastify";
import { ReservationAgent } from "../core/agent.js";
import { ClaudeLLMClient } from "../integrations/llm/claude.js";
import { restaurantRegistry } from "../config/demo.js";
import { parseWebhookPayload, parseWebhookMediaSender, sendWhatsAppMessage } from "../channels/whatsapp.js";
import { startReminderScheduler } from "../core/reminders.js";
import { randomInt } from "crypto";
import { type OrderItem } from "../business/order.js";

const PORT = Number(process.env.PORT ?? 3000);
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN ?? "";
const RESTAURANT_ID = process.env.RESTAURANT_ID ?? "demo";

// ── Startup checks ────────────────────────────────────────────
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) { console.error("Falta ANTHROPIC_API_KEY en .env"); process.exit(1); }
if (!VERIFY_TOKEN) { console.error("Falta META_VERIFY_TOKEN en .env"); process.exit(1); }
if (!process.env.META_ACCESS_TOKEN) { console.error("Falta META_ACCESS_TOKEN en .env"); process.exit(1); }
if (!process.env.META_PHONE_NUMBER_ID) { console.error("Falta META_PHONE_NUMBER_ID en .env"); process.exit(1); }

// ── Order drafts (in-memory, TTL 1 hora) ─────────────────────
// Guardan pedidos de la web con un código corto hasta que el cliente
// los confirma por WhatsApp.
const orderDrafts = new Map<string, { items: OrderItem[]; createdAt: number }>();

function generateDraftCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sin caracteres ambiguos (0, O, 1, I)
  let code = "";
  for (let i = 0; i < 8; i++) code += chars[randomInt(0, chars.length)];
  return code;
}

// Limpiar drafts expirados cada 10 min
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [code, draft] of orderDrafts.entries()) {
    if (draft.createdAt < cutoff) orderDrafts.delete(code);
  }
}, 10 * 60 * 1000);

// ── Agent ─────────────────────────────────────────────────────
const agent = new ReservationAgent(
  new ClaudeLLMClient(apiKey),
  restaurantRegistry,
);

// ── Server ────────────────────────────────────────────────────
const app = Fastify({ logger: true });

const ALLOWED_ORIGIN = "https://alexis1221345.github.io";
const MAX_DRAFTS = 500;
const MAX_ITEMS = 30;
const MAX_STR = 80;

function sanitizeStr(v: unknown): string {
  return String(v ?? "").replace(/[^\p{L}\p{N} ,.()\-+]/gu, "").slice(0, MAX_STR);
}

// CORS preflight para /order-draft (la página web llama a este endpoint)
app.options("/order-draft", async (_req, reply) => {
  reply
    .header("Access-Control-Allow-Origin", ALLOWED_ORIGIN)
    .header("Access-Control-Allow-Methods", "POST")
    .header("Access-Control-Allow-Headers", "Content-Type")
    .status(204)
    .send();
});

/** Recibe el carrito desde pedido.html, valida contra el menú y guarda con código corto */
app.post("/order-draft", async (req, reply) => {
  reply.header("Access-Control-Allow-Origin", ALLOWED_ORIGIN);

  if (orderDrafts.size >= MAX_DRAFTS) {
    return reply.status(503).send({ error: "too many pending orders" });
  }

  const body = req.body as { items?: unknown };
  if (!Array.isArray(body?.items) || body.items.length === 0) {
    return reply.status(400).send({ error: "empty order" });
  }
  if (body.items.length > MAX_ITEMS) {
    return reply.status(400).send({ error: "too many items" });
  }

  // Cargar menú para validar nombres y sobrescribir precios con valores del servidor
  const cfg = Object.values(restaurantRegistry)[0];
  const menuClient = cfg?.sheetsId && cfg.googleCredentialsPath
    ? (await import("../integrations/sheets/menu-client.js")).getMenuClient(cfg.googleCredentialsPath, cfg.sheetsId)
    : null;

  let menuItems: import("../integrations/sheets/menu-client.js").MenuItem[] = [];
  if (menuClient) {
    try { menuItems = await menuClient.getMenu(); } catch { /* continúa sin validación de precio */ }
  }

  const validatedItems: OrderItem[] = [];
  for (const raw of body.items as Record<string, unknown>[]) {
    const nombre = sanitizeStr(raw.nombre);
    if (!nombre) continue;

    const cantidad = Math.max(1, Math.min(99, Math.floor(Number(raw.cantidad) || 1)));

    // Precio siempre viene del menú del servidor; si no hay menú cae en el valor del cliente
    const menuEntry = menuItems.find((m) =>
      m.nombre.toLowerCase().trim() === nombre.toLowerCase().trim(),
    );
    const precio = menuEntry ? menuEntry.precio : Math.max(0, Number(raw.precio) || 0);

    const extras = Array.isArray(raw.extras)
      ? (raw.extras as unknown[]).map(sanitizeStr).filter(Boolean).slice(0, 10)
      : [];
    const sin = Array.isArray(raw.sin)
      ? (raw.sin as unknown[]).map(sanitizeStr).filter(Boolean).slice(0, 10)
      : [];
    const nota = sanitizeStr(raw.nota);

    validatedItems.push({ nombre, precio, cantidad, extras, sin, nota });
  }

  if (validatedItems.length === 0) {
    return reply.status(400).send({ error: "no valid items" });
  }

  let code: string;
  do { code = generateDraftCode(); } while (orderDrafts.has(code));
  orderDrafts.set(code, { items: validatedItems, createdAt: Date.now() });
  console.log(`[order-draft] Guardado pedido web con código ${code} (${validatedItems.length} items)`);
  return reply.send({ code });
});

/** Meta webhook verification handshake */
app.get("/webhook", async (req, reply) => {
  const q = req.query as Record<string, string>;
  if (q["hub.mode"] === "subscribe" && q["hub.verify_token"] === VERIFY_TOKEN) {
    return reply.send(q["hub.challenge"]);
  }
  return reply.status(403).send("Forbidden");
});

// Detecta mensajes del tipo "Confirmar pedido #A1B2C3" o solo "#A1B2C3"
const DRAFT_CODE_RE = /\bPED-([A-Z0-9]{8})\b/i;

/** Incoming WhatsApp messages */
app.post("/webhook", async (req, reply) => {
  // Meta requires 200 immediately — we process async
  reply.status(200).send("ok");

  let parsedMsg = parseWebhookPayload(req.body);
  if (!parsedMsg) {
    const mediaSender = parseWebhookMediaSender(req.body);
    if (mediaSender) {
      try {
        await sendWhatsAppMessage(mediaSender, "Solo puedo procesar mensajes de texto 😊 ¿En qué te puedo ayudar?");
      } catch (err) {
        console.error("[webhook] Error enviando respuesta a media:", err);
      }
    } else {
      app.log.debug("[webhook] Payload ignorado (status update o no-text)");
    }
    return;
  }

  // Resolver código de pedido web → reemplaza con PEDIDO_WEB:{json}
  const draftMatch = parsedMsg.body.match(DRAFT_CODE_RE);
  if (draftMatch) {
    const code = draftMatch[1].toUpperCase();
    const draft = orderDrafts.get(code);
    if (draft) {
      orderDrafts.delete(code);
      console.log(`[webhook] Código de pedido web ${code} resuelto (${draft.items.length} items)`);
      parsedMsg = { ...parsedMsg, body: `PEDIDO_WEB:${JSON.stringify({ items: draft.items })}` };
    }
  }

  const msg = parsedMsg;
  console.log(`[webhook] Mensaje de ${msg.from}: "${msg.body.slice(0, 80)}"`);

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

  const publicUrl = process.env.RENDER_EXTERNAL_URL;
  if (publicUrl) {
    setInterval(() => {
      fetch(`${publicUrl}/health`).catch(() => {});
    }, 10 * 60 * 1000);
    console.log(`⏰  Keep-alive activo → ${publicUrl}/health cada 10 min`);
  }

  // Start proactive reminder scheduler
  if (cfg) startReminderScheduler(cfg, RESTAURANT_ID);
});
