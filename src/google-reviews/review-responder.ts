import type { RestaurantConfig } from "../shared/config/types.js";
import type { ILLMClient } from "../shared/llm/llm.interface.js";
import {
  getGbpReviewsClient,
  starRatingToNumber,
  type GbpReview,
} from "./gbp-client.js";

// Default si el restaurante no define reviews_poll_minutes en el Sheet (1440 = 1 vez al día)
const DEFAULT_POLL_MINUTES = Number(process.env.REVIEWS_POLL_MINUTES ?? 1440);
// Cada cuánto se evalúa si a algún restaurante ya le toca su revisión
const TICK_MINUTES = 15;
const MAX_REPLIES_PER_CYCLE = 10; // por restaurante, para no saturar la API

function buildSystemPrompt(cfg: RestaurantConfig): string {
  return (
    `Eres el encargado de atención al cliente de "${cfg.name}" y respondes reseñas públicas de Google Maps.\n` +
    `Reglas:\n` +
    `- Responde en español, en 1 a 3 oraciones, cálido y profesional.\n` +
    `- Agradece siempre al cliente por su tiempo y menciona su nombre si está disponible.\n` +
    `- Si la reseña es positiva (4-5 estrellas): agradece e invítalo a volver.\n` +
    `- Si es negativa (1-3 estrellas): discúlpate con empatía, NO discutas ni des excusas, ` +
    `e invítalo a contactarnos${cfg.humanPhone ? ` al ${cfg.humanPhone}` : ""} para resolverlo.\n` +
    `- Nunca prometas reembolsos, descuentos ni compensaciones.\n` +
    `- No inventes detalles sobre la visita del cliente.\n` +
    `- No incluyas hashtags ni emojis excesivos (máximo 1).\n` +
    (cfg.reviewsTone ? `Instrucciones adicionales del restaurante: ${cfg.reviewsTone}\n` : "") +
    `Devuelve ÚNICAMENTE el texto de la respuesta, sin comillas ni prefijos.`
  );
}

function buildUserMessage(review: GbpReview): string {
  const stars = starRatingToNumber(review.starRating);
  const name = review.reviewer?.displayName?.trim() || "Cliente";
  const text = review.comment?.trim() || "(sin comentario, solo calificación)";
  return `Reseña de ${name} — ${stars} estrella(s):\n"${text}"`;
}

/**
 * Revisa las reseñas de Google de un restaurante y responde las que
 * aún no tienen respuesta del negocio.
 */
export async function respondPendingReviews(
  cfg: RestaurantConfig,
  llm: ILLMClient,
): Promise<number> {
  if (!cfg.reviewsEnabled || !cfg.gbpAccountId || !cfg.gbpLocationId) return 0;
  if (!cfg.googleCredentialsPath) {
    console.warn(`[reviews] ${cfg.name}: sin credenciales de Google — omitido`);
    return 0;
  }

  const gbp = getGbpReviewsClient(cfg.googleCredentialsPath);
  const reviews = await gbp.listReviews(cfg.gbpAccountId, cfg.gbpLocationId);
  const pending = reviews.filter((r) => !r.reviewReply).slice(0, MAX_REPLIES_PER_CYCLE);

  let replied = 0;
  for (const review of pending) {
    try {
      const reply = (await llm.generateReply(buildSystemPrompt(cfg), [], buildUserMessage(review))).trim();
      if (!reply) continue;
      await gbp.replyToReview(cfg.gbpAccountId, cfg.gbpLocationId, review.reviewId, reply);
      replied++;
      console.log(
        `[reviews] ${cfg.name}: respondida reseña de ${review.reviewer?.displayName ?? "Cliente"} ` +
        `(${starRatingToNumber(review.starRating)}★): "${reply.slice(0, 80)}${reply.length > 80 ? "…" : ""}"`,
      );
    } catch (err) {
      console.error(`[reviews] ${cfg.name}: error respondiendo reseña ${review.reviewId}:`, err);
    }
  }
  return replied;
}

/**
 * Arranca el ciclo periódico que responde reseñas de Google para todos
 * los restaurantes del Sheet maestro con reviews_enabled = TRUE.
 */
export function startReviewResponder(
  getConfigs: () => Promise<Iterable<RestaurantConfig>>,
  llm: ILLMClient,
): void {
  // Última revisión por restaurante, para respetar el intervalo individual del Sheet
  const lastRun = new Map<string, number>();

  const tick = async () => {
    try {
      const configs = await getConfigs();
      const now = Date.now();
      for (const cfg of configs) {
        if (!cfg.reviewsEnabled) continue;
        const pollMinutes = cfg.reviewsPollMinutes || DEFAULT_POLL_MINUTES;
        const last = lastRun.get(cfg.id) ?? 0;
        if (now - last < pollMinutes * 60 * 1000) continue;
        lastRun.set(cfg.id, now);
        try {
          const n = await respondPendingReviews(cfg, llm);
          if (n > 0) console.log(`[reviews] ${cfg.name}: ${n} reseña(s) respondida(s)`);
        } catch (err) {
          console.error(`[reviews] ${cfg.name}: error en ciclo de reseñas:`, err);
        }
      }
    } catch (err) {
      console.error("[reviews] Error obteniendo configuraciones:", err);
    }
  };

  // Primer chequeo 1 minuto después de arrancar; luego evalúa cada TICK_MINUTES
  // qué restaurante ya cumplió su intervalo (reviews_poll_minutes del Sheet).
  setTimeout(tick, 60 * 1000);
  setInterval(tick, TICK_MINUTES * 60 * 1000);
  console.log(`⭐  Respuesta automática a reseñas de Google activa (intervalo por restaurante, default ${DEFAULT_POLL_MINUTES} min)`);
}
