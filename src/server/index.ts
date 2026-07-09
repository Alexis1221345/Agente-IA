import { config } from "dotenv";
config();

import Fastify from "fastify";
import { ReservationAgent } from "../whatsapp/core/agent.js";
import { registerWhatsAppRoutes } from "../whatsapp/routes.js";
import { startReminderScheduler } from "../whatsapp/core/reminders.js";
import { startReviewResponder } from "../google-reviews/review-responder.js";
import { ClaudeLLMClient } from "../shared/llm/claude.js";
import { restaurantRegistry } from "../shared/config/demo.js";
import { getMasterConfigClient } from "../shared/sheets/master-config-client.js";
import type { RestaurantConfig } from "../shared/config/types.js";

const PORT = Number(process.env.PORT ?? 3000);
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN ?? "";
const RESTAURANT_ID = process.env.RESTAURANT_ID ?? "demo";
const MASTER_SHEET_ID = process.env.MASTER_SHEET_ID;

// ── Startup checks ────────────────────────────────────────────
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) { console.error("Falta ANTHROPIC_API_KEY en .env"); process.exit(1); }
if (!VERIFY_TOKEN) { console.error("Falta META_VERIFY_TOKEN en .env"); process.exit(1); }
if (!process.env.META_ACCESS_TOKEN) { console.error("Falta META_ACCESS_TOKEN en .env"); process.exit(1); }
if (!process.env.META_PHONE_NUMBER_ID) { console.error("Falta META_PHONE_NUMBER_ID en .env"); process.exit(1); }

// ── Multi-tenant master config ─────────────────────────────────
const credJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON?.trim();
const masterClient = MASTER_SHEET_ID && credJson
  ? getMasterConfigClient(credJson, MASTER_SHEET_ID)
  : null;

/**
 * Returns the RestaurantConfig for a given Meta phone_number_id.
 * If a master Sheet is configured, queries it first.
 * Falls back to the env-based restaurantRegistry.
 */
async function getRestaurantConfig(phoneNumberId: string): Promise<RestaurantConfig | null> {
  if (masterClient) {
    try {
      const cfg = await masterClient.getByPhoneNumberId(phoneNumberId);
      if (cfg) return cfg;
    } catch (err) {
      console.error("[server] Error leyendo Sheet maestro — usando fallback de env:", err);
    }
  }
  // Fallback: look up by env RESTAURANT_ID or by any registered restaurant
  return restaurantRegistry[RESTAURANT_ID] ?? null;
}

// ── Agent ─────────────────────────────────────────────────────
const agent = new ReservationAgent(
  new ClaudeLLMClient(apiKey),
  restaurantRegistry,
);

// ── Server ────────────────────────────────────────────────────
const app = Fastify({ logger: true });

// Módulo WhatsApp: webhook de Meta + pedidos desde la web
registerWhatsAppRoutes(app, {
  agent,
  verifyToken: VERIFY_TOKEN,
  restaurantRegistry,
  getRestaurantConfig,
});

app.get("/health", async () => ({ status: "ok", restaurant: restaurantRegistry[RESTAURANT_ID]?.name }));

let address: string;
try {
  address = await app.listen({ port: PORT, host: "0.0.0.0" });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

{
  const cfg = restaurantRegistry[RESTAURANT_ID];
  console.log(`\n🚀  Servidor en ${address}`);
  console.log(`🍽️   Restaurante (fallback): ${cfg?.name} (${RESTAURANT_ID})`);
  console.log(`📅  Calendario: ${cfg?.calendarId}`);
  console.log(`📲  Webhook: ${address}/webhook\n`);

  // ── Multi-tenant startup info ─────────────────────────────────
  if (masterClient) {
    try {
      const configs = await masterClient.getConfigs();
      console.log(`🏪  Sheet maestro: ${configs.size} restaurante(s) cargado(s)`);
      for (const [pnid, rc] of configs) {
        console.log(`    • ${rc.name} (${rc.id}) → pnid:${pnid}`);
      }
    } catch (err) {
      console.error("[server] No se pudo leer el Sheet maestro al arrancar:", err);
    }
  } else {
    console.log("ℹ️   Sin Sheet maestro — usando configuración de .env");
  }

  const publicUrl = process.env.RENDER_EXTERNAL_URL;
  if (publicUrl) {
    setInterval(() => {
      fetch(`${publicUrl}/health`).catch(() => {});
    }, 10 * 60 * 1000);
    console.log(`⏰  Keep-alive activo → ${publicUrl}/health cada 10 min`);
  }

  // Start proactive reminder scheduler (uses fallback env config)
  if (cfg) startReminderScheduler(cfg, RESTAURANT_ID);

  // Módulo Google Reviews: respuesta automática a reseñas
  // (restaurantes con reviews_enabled=TRUE en el Sheet maestro)
  if (masterClient) {
    startReviewResponder(
      async () => (await masterClient.getConfigs()).values(),
      new ClaudeLLMClient(apiKey),
    );
  }
}
