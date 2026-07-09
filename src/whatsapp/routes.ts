import type { FastifyInstance } from "fastify";
import { randomInt } from "crypto";
import type { ReservationAgent } from "./core/agent.js";
import { parseWebhookPayload, parseWebhookMediaSender, sendWhatsAppMessage } from "./channels/whatsapp.js";
import { type OrderItem } from "./business/order.js";
import type { RestaurantConfig } from "../shared/config/types.js";

export interface WhatsAppRoutesDeps {
  agent: ReservationAgent;
  verifyToken: string;
  restaurantRegistry: Record<string, RestaurantConfig>;
  getRestaurantConfig: (phoneNumberId: string) => Promise<RestaurantConfig | null>;
}

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

const ALLOWED_ORIGIN = "https://alexis1221345.github.io";
const MAX_DRAFTS = 500;
const MAX_ITEMS = 30;
const MAX_STR = 80;

function sanitizeStr(v: unknown): string {
  return String(v ?? "").replace(/[^\p{L}\p{N} ,.()\-+]/gu, "").slice(0, MAX_STR);
}

// Detecta mensajes del tipo "Confirmar pedido #A1B2C3" o solo "#A1B2C3"
const DRAFT_CODE_RE = /\bPED-([A-Z0-9]{8})\b/i;

/**
 * Registra las rutas del canal WhatsApp:
 *  - POST /order-draft  (carrito desde la página web)
 *  - GET  /webhook      (verificación de Meta)
 *  - POST /webhook      (mensajes entrantes de WhatsApp)
 */
export function registerWhatsAppRoutes(app: FastifyInstance, deps: WhatsAppRoutesDeps): void {
  const { agent, verifyToken, restaurantRegistry, getRestaurantConfig } = deps;

  // Limpiar drafts expirados cada 10 min
  const cleanup = setInterval(() => {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const [code, draft] of orderDrafts.entries()) {
      if (draft.createdAt < cutoff) orderDrafts.delete(code);
    }
  }, 10 * 60 * 1000);
  cleanup.unref();

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
      ? (await import("./integrations/sheets/menu-client.js")).getMenuClient(cfg.googleCredentialsPath, cfg.sheetsId)
      : null;

    let menuItems: import("./integrations/sheets/menu-client.js").MenuItem[] = [];
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
    if (q["hub.mode"] === "subscribe" && q["hub.verify_token"] === verifyToken) {
      return reply.send(q["hub.challenge"]);
    }
    return reply.status(403).send("Forbidden");
  });

  /** Incoming WhatsApp messages */
  app.post("/webhook", async (req, reply) => {
    // Meta requires 200 immediately — we process async
    reply.status(200).send("ok");

    let parsedMsg = parseWebhookPayload(req.body);
    if (!parsedMsg) {
      // For media messages we still need to know which phone_number_id received the message
      // so we can route the reply correctly. Parse it from the raw payload.
      const mediaSender = parseWebhookMediaSender(req.body);
      if (mediaSender) {
        // Best-effort extraction of phone_number_id for media routing
        let mediaPnid: string | undefined;
        try {
          const p = req.body as Record<string, unknown>;
          const entry = (p.entry as Record<string, unknown>[])?.[0];
          const change = (entry?.changes as Record<string, unknown>[])?.[0];
          const value = change?.value as Record<string, unknown> | undefined;
          const metadata = value?.metadata as Record<string, unknown> | undefined;
          const raw = metadata?.phone_number_id;
          if (typeof raw === "string" && raw.trim()) mediaPnid = raw.trim();
        } catch { /* ignore */ }

        try {
          await sendWhatsAppMessage(
            mediaSender,
            "Solo puedo procesar mensajes de texto 😊 ¿En qué te puedo ayudar?",
            mediaPnid,
          );
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
    const incomingPnid = msg.phoneNumberId ?? "";
    console.log(`[webhook] Mensaje de ${msg.from} (pnid:${incomingPnid}): "${msg.body.slice(0, 80)}"`);

    // ── Multi-tenant routing ──────────────────────────────────────
    const config = await getRestaurantConfig(incomingPnid);
    if (!config) {
      console.error(`[webhook] Sin configuración para phone_number_id="${incomingPnid}" — mensaje ignorado`);
      return;
    }
    // Sync master-sheet config into the agent's registry so it can look it up by id
    restaurantRegistry[config.id] = config;
    const restaurantId = config.id;

    try {
      const response = await agent.handleMessage(msg.from, msg.body, restaurantId);
      console.log(`[webhook] Respuesta a ${msg.from}: "${response.slice(0, 120)}${response.length > 120 ? "…" : ""}"`);
      await sendWhatsAppMessage(msg.from, response, incomingPnid || undefined);
      console.log(`[webhook] Mensaje enviado OK a ${msg.from}`);
    } catch (err) {
      console.error("[webhook] Error procesando mensaje:", err);
    }
  });
}
