import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";
import type { ILLMClient } from "../integrations/llm/llm.interface.js";
import type { RestaurantConfig } from "../config/types.js";
import { getCalendarClient } from "../integrations/calendar/factory.js";
import {
  loadConversation,
  saveConversation,
  saveReservation,
  updateReservationExternalId,
  resetConversation,
  findReservationById,
  findReservationByNameAndDate,
  cancelReservationById,
  formatResId,
  parseResId,
  type ConversationState,
  type ReservationRecord,
} from "../data/conversation-repo.js";
import { normalizeDate, normalizeTime } from "../business/normalizer.js";
import { nextAction, buildSummary } from "./gap-filler.js";

dayjs.extend(utc);
dayjs.extend(timezone);

const CONFIRM_WORDS =
  /^\s*(sí|si|yes|confirmo|dale|va|órale|orale|claro|por\s+favor|ok|okay|bueno|listo|perfecto|sip|sep|simón|simon|sale|ándale|andale|está\s+bien|esta\s+bien|de\s+acuerdo|correcto|exacto|yep|yup|adelante|procede|hazlo|mándalo|manda)\s*$/i;
const CANCELLATION_INTENT =
  /cancelar?|cancela|anular?|anula|quiero\s+cancelar|borrar?\s+reserva|eliminar?\s+reserva|quitar\s+reserva|ya\s+no\s+(voy|puedo|quiero)/i;
const CANCEL_LOOKUP_PROMPT =
  "¿Tienes tu número de reserva? (ej. *#RES-0042*)\n" +
  "Si no lo recuerdas, dime tu nombre y la fecha (dd/mm/año) y lo busco yo. 😊";
const CANCEL_WORDS =
  /^\s*(no|nope|cancela|cancelar|no\s+quiero|mejor\s+no|para\s+atr[aá]s|regresa|volver|déjalo|dejalo)\s*$/i;

export class ReservationAgent {
  constructor(
    private llm: ILLMClient,
    private configs: Record<string, RestaurantConfig>,
  ) {}

  private calendar(config: RestaurantConfig) {
    return getCalendarClient(config);
  }

  async handleMessage(
    phone: string,
    text: string,
    restaurantId: string,
  ): Promise<string> {
    const config = this.configs[restaurantId];
    if (!config) throw new Error(`Unknown restaurant: ${restaurantId}`);

    const state = loadConversation(phone, restaurantId);

    // First-ever message → show welcome and set greeting status
    if (state.history.length === 0) {
      state.status = "greeting";
      state.history.push({ role: "user", content: text });
      const welcome = buildWelcome(config);
      state.history.push({ role: "assistant", content: welcome });
      saveConversation(state);
      return welcome;
    }

    state.history.push({ role: "user", content: text });

    let response: string;

    try {
      response = await this.process(state, text, config);
    } catch (err) {
      console.error("[Agent] Error processing message:", err);
      const isLLMError = err instanceof Error && (
        err.message.includes("credit balance") ||
        err.message.includes("API key") ||
        err.message.includes("authentication")
      );
      if (isLLMError) {
        // Don't escalate for billing/auth issues — just tell the user to retry
        response = "Estamos teniendo un problema técnico momentáneo. Por favor intenta de nuevo en unos minutos. 🙏";
        // Don't mark as escalated so the conversation can continue once fixed
      } else {
        response = escalationMessage(config, "error interno");
        state.status = "escalated";
      }
    }

    state.history.push({ role: "assistant", content: response });
    saveConversation(state);
    return response;
  }

  private async process(
    state: ConversationState,
    text: string,
    config: RestaurantConfig,
  ): Promise<string> {
    // After confirmed/escalated, reset and re-greet
    if (state.status === "confirmed" || state.status === "escalated") {
      state.status = "greeting";
      state.data = {};
      state.history = [{ role: "user", content: text }];
      return buildWelcome(config);
    }

    // Greeting → detect intent before starting collection.
    // When the intent moves us to "collecting", fall through to field extraction
    // so the user doesn't have to repeat data they already gave (e.g. "quiero
    // reserva para el sábado a las 8").
    if (state.status === "greeting") {
      const greetingReply = handleGreeting(state, text, config);
      // Read status AFTER the call — handleGreeting may mutate it
      const statusAfterGreeting: string = state.status;
      if (statusAfterGreeting !== "collecting") {
        return greetingReply; // stayed in greeting or went to cancelling flow
      }
      // Status is now "collecting" — fall through to extract any fields from this message
      // so the user doesn't need to repeat data they already gave (e.g. date/time)
    }

    // Cancellation flow
    if (state.status === "cancelling_lookup") {
      return this.handleCancelLookup(state, text, config);
    }
    if (state.status === "cancelling_confirm") {
      return this.handleCancelConfirm(state, text, config);
    }

    // Cancellation intent mid-flow
    if (CANCELLATION_INTENT.test(text) && state.status === "collecting") {
      state.status = "cancelling_lookup";
      return CANCEL_LOOKUP_PROMPT;
    }

    // Handle confirmation step
    if (state.status === "confirming") {
      return await this.handleConfirmation(state, text, config);
    }

    // Negative / "ninguna" response to the peticiones question → treat as empty
    if (
      state.data.nombre &&
      state.data.peticiones === undefined &&
      hasMentionedPeticiones(state.history) &&
      /^\s*(ninguna?|no|nada|sin\s+nada|no\s+tengo|ningún|ningún?|no\s+gracias|no\s+hay|no\s+tengo\s+ninguna?|sin\s+petici[oó]n|sin\s+nada\s+especial|no\s+necesito(\s+nada)?|estamos\s+bien|todo\s+bien|sin\s+problema|no\s+tengo\s+nada|estoy\s+bien|sin\s+especial|no\s+especial|no\s+pasa\s+nada)\s*$/i.test(text)
    ) {
      state.data.peticiones = "";
    }

    // Extract fields from user message
    const { fields, raw } = await this.llm.extractFields(
      state.history.slice(0, -1), // exclude the current message we just pushed
      text,
      config.timezone,
    );

    // Normalize and merge extracted fields
    this.mergeFields(state, fields, raw ?? {}, config);

    // ── Fallback extractors ──────────────────────────────────────────────────
    // The LLM sometimes skips calling the tool for very short messages ("4",
    // "domingo", "8 de la tarde"). Each fallback activates only when the LLM
    // left that field empty AND the message clearly belongs to that field by
    // position in the collection sequence (fecha → hora → personas → nombre).

    // 1. FECHA — day names, relative expressions, numeric dates
    if (!state.data.fecha) {
      const directDate = normalizeDate(text.trim(), config.timezone);
      if (directDate) state.data.fecha = directDate;
    }

    // 2. HORA — explicit time markers OR bare number when fecha is already known
    //    (ordering guarantees hora is asked before personas, so a bare number here
    //    is almost certainly a time, not a head-count)
    if (!state.data.hora) {
      const hasExplicitTime =
        /\b(am|pm)\b|de\s+la\s+(noche|tarde|ma[nñ]ana|madrugada)|a\s+las?|\d{1,2}:\d{2}|\d{1,2}\s*h(rs?)?/i.test(text);
      const isBareNumberAndFechaKnown =
        !!state.data.fecha && /^\s*\d{1,2}\s*$/.test(text);
      if (hasExplicitTime || isBareNumberAndFechaKnown) {
        const directTime = normalizeTime(text.trim());
        if (directTime) state.data.hora = directTime;
      }
    }

    // 3. PERSONAS — bare number or word-number when fecha + hora are known
    //    Skip if text contains ":" (could be a time correction like "20:00")
    if (!state.data.personas && state.data.fecha && state.data.hora && !text.includes(":")) {
      const t = text.trim().toLowerCase();
      const digitMatch = t.match(/\b(\d{1,2})\b/);
      if (digitMatch) {
        const n = parseInt(digitMatch[1], 10);
        if (n >= 1 && n <= 20) state.data.personas = n;
      } else {
        const WORD_NUMS: Record<string, number> = {
          uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5,
          seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
        };
        for (const [word, num] of Object.entries(WORD_NUMS)) {
          if (new RegExp(`\\b${word}\\b`).test(t)) {
            state.data.personas = num;
            break;
          }
        }
      }
    }

    // Determine next action (pure, deterministic)
    const action = nextAction(state.data, config);

    if (action.type === "escalate") {
      state.status = "escalated";
      return escalationMessage(config, action.reason);
    }

    if (action.type === "ask") {
      return action.question;
    }

    if (action.type === "check_availability") {
      const dow = dayjs(state.data.fecha).tz(config.timezone).format("dddd").toLowerCase();
      const dowKey = englishDow(dow);
      const daySchedule = config.schedule[dowKey];

      // Spanish display name for the day of week
      const ES_DOW: Record<string, string> = {
        monday: "Lunes", tuesday: "Martes", wednesday: "Miércoles",
        thursday: "Jueves", friday: "Viernes", saturday: "Sábado", sunday: "Domingo",
      };
      const dowES = ES_DOW[dowKey] ?? capitalize(dow);

      // 1. Check if the day is closed — show open days to help the customer
      if (!daySchedule) {
        state.data.fecha = undefined;
        return (
          `Lo siento, los *${dowES}* estamos cerrados. 🚫\n\n` +
          `Nuestros días y horarios disponibles son:\n` +
          formatOpenDays(config) +
          `\n\n¿Para qué día te gustaría hacer la reserva?`
        );
      }

      // 2. Check if the requested time falls within service hours.
      //    The bot is available 24/7 but reservations must be within operating hours.
      const toMin = (hhmm: string) => {
        const [h, m] = hhmm.split(":").map(Number);
        return h * 60 + m;
      };
      const openMin = toMin(daySchedule.open);
      const lastSlotMin = toMin(daySchedule.close) - config.slotDurationMinutes;
      const reqMin = toMin(state.data.hora!);

      if (reqMin < openMin || reqMin > lastSlotMin) {
        state.data.hora = undefined;
        const lastSlotStr = minutesToHHMM(lastSlotMin);
        const suggestions = suggestSlots(openMin, lastSlotMin);
        return (
          `Ese horario está fuera de nuestro servicio los *${dowES}*. ⏰\n\n` +
          `🕐 Horario de atención: *${daySchedule.open}* a *${daySchedule.close}*\n` +
          `📌 Última reserva disponible: *${lastSlotStr}*\n\n` +
          `Algunos horarios disponibles: ${suggestions.join(", ")}\n\n` +
          `¿A qué hora te gustaría llegar?`
        );
      }

      // 3. Check real-time availability in Google Calendar
      const horaRequested = state.data.hora!;
      let calendarAvailable = true;

      try {
        const avail = await this.calendar(config).checkAvailability(
          state.data.fecha!,
          horaRequested,
          state.data.personas!,
          config,
        );
        calendarAvailable = avail.available;
      } catch (calendarErr) {
        console.error("[Agent] Calendar check failed:", calendarErr);
        // Don't escalate — continue with reservation, flag in confirmation
        calendarAvailable = true; // optimistic: assume available, calendar will catch it at creation
      }

      if (!calendarAvailable) {
        state.data.hora = undefined;
        const suggestions = suggestSlots(openMin, lastSlotMin);
        return (
          `Lo siento, las *${horaRequested}* ya no tiene lugares ` +
          `para ${state.data.personas} personas. 😔\n\n` +
          `Algunos horarios que aún podrían tener disponibilidad: ${suggestions.join(", ")}\n\n` +
          `¿Te funciona alguno de esos o prefieres otro?`
        );
      }

      return "¿A nombre de quién hacemos la reserva?";
    }

    if (action.type === "confirm") {
      // Ask for peticiones first (separate turn), then show summary
      if (state.data.peticiones === undefined && !hasMentionedPeticiones(state.history)) {
        state.status = "collecting";
        return "¿Tienes alguna petición especial? (ocasión, alergias, silla para bebé, etc.) Si no, escribe *ninguna*.";
      }
      state.status = "confirming";
      return action.summary;
    }

    return "¿En qué puedo ayudarte?";
  }

  private async handleConfirmation(
    state: ConversationState,
    text: string,
    config: RestaurantConfig,
  ): Promise<string> {
    if (CONFIRM_WORDS.test(text)) {
      // Save to DB first to get the reservation ID, then sync to Calendar
      const resId = saveReservation(state);
      const resCode = formatResId(resId);

      try {
        const { eventId } = await this.calendar(config).createReservation({
          config,
          reservationId: resCode,
          nombre: state.data.nombre!,
          phone: state.phone,
          fecha: state.data.fecha!,
          hora: state.data.hora!,
          personas: state.data.personas!,
          peticiones: state.data.peticiones,
        });
        updateReservationExternalId(resId, eventId);
      } catch (calendarErr) {
        // Reservation is confirmed in DB — calendar sync failed silently.
        // The reservation code is valid; staff can add it manually if needed.
        console.error("[Agent] Calendar createReservation failed:", calendarErr);
      }

      state.status = "confirmed";

      return (
        `¡Listo, ${state.data.nombre}! 🎉 Tu reserva en *${config.name}* está confirmada.\n` +
        `📅 ${formatDateNice(state.data.fecha!)} a las ${state.data.hora} para ${state.data.personas} personas.\n` +
        `🔖 Tu número de reserva: *${resCode}*\n` +
        `${config.cancellationPolicy}\n` +
        `¡Te esperamos! 😊`
      );
    }

    if (CANCEL_WORDS.test(text)) {
      resetConversation(state.phone);
      state.status = "cancelled";
      return "Sin problema, cancelé la reserva. Si cambias de opinión, escríbeme cuando quieras. 👋";
    }

    // Treat anything else as a field correction
    state.status = "collecting";
    const { fields, raw } = await this.llm.extractFields(
      state.history.slice(0, -1),
      text,
      config.timezone,
    );
    this.mergeFields(state, fields, raw ?? {}, config);
    const action = nextAction(state.data, config);
    if (action.type === "confirm") {
      state.status = "confirming";
      return `Actualicé los datos. ${action.summary}`;
    }
    return buildSummary(state.data, config);
  }

  private handleCancelLookup(
    state: ConversationState,
    text: string,
    config: RestaurantConfig,
  ): string {
    // Try to find by reservation ID
    const resId = parseResId(text);
    if (resId !== null) {
      const found = findReservationById(resId, config.id);
      if (found) {
        state.data = { ...state.data, _cancelTarget: found } as typeof state.data & { _cancelTarget: ReservationRecord };
        state.status = "cancelling_confirm";
        return cancelSummary(found) + "\n\n¿Confirmas la cancelación? (sí / no)";
      }
      return `No encontré una reserva con el número *${formatResId(resId)}*.\n¿Me das tu nombre y la fecha? (dd/mm/año)`;
    }

    // Try name + date: "Juan García, 25/07/2025" or "Juan García el 25/07"
    const dateMatch = text.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/);
    const nameMatch = text.match(/^([A-Za-záéíóúñÁÉÍÓÚÑ][^\d,\n]{2,30}?)(?:\s*[,\s]\s*\d|\s+el\s+\d)/i)
      ?? text.match(/^([A-Za-záéíóúñÁÉÍÓÚÑ][^\d,\n]{2,30})/i);

    if (dateMatch && nameMatch) {
      const day = dateMatch[1].padStart(2, "0");
      const month = dateMatch[2].padStart(2, "0");
      const yearRaw = dateMatch[3];
      const year = yearRaw
        ? yearRaw.length === 2 ? `20${yearRaw}` : yearRaw
        : String(dayjs().tz(config.timezone).year());
      const fecha = `${year}-${month}-${day}`;
      const nombre = nameMatch[1].trim();

      const results = findReservationByNameAndDate(nombre, fecha, config.id);
      if (results.length === 1) {
        const found = results[0];
        (state.data as Record<string, unknown>)._cancelTarget = found;
        state.status = "cancelling_confirm";
        return cancelSummary(found) + "\n\n¿Confirmas la cancelación? (sí / no)";
      }
      if (results.length > 1) {
        // Multiple matches — ask for the ID to be precise
        const list = results.map((r) => `${formatResId(r.id)} — ${r.hora}`).join("\n");
        return `Encontré varias reservas para ese nombre y fecha:\n${list}\n\n¿Cuál es el número de reserva que quieres cancelar?`;
      }
      return `No encontré una reserva a nombre de *${nombre}* el ${day}/${month}/${year}.\n¿Quieres intentar de nuevo? (nombre y fecha dd/mm/año)`;
    }

    return `No pude identificar la reserva.\nDime tu *número de reserva* (#RES-XXXX) o tu *nombre y fecha* (dd/mm/año). 😊`;
  }

  private async handleCancelConfirm(
    state: ConversationState,
    text: string,
    config: RestaurantConfig,
  ): Promise<string> {
    const target = (state.data as Record<string, unknown>)._cancelTarget as ReservationRecord | undefined;
    if (!target) {
      state.status = "cancelling_lookup";
      return CANCEL_LOOKUP_PROMPT;
    }

    if (CONFIRM_WORDS.test(text)) {
      const externalId = cancelReservationById(target.id, config.id, state.phone);
      // Also cancel in Google Calendar if the event ID was stored
      if (externalId) {
        try {
          await this.calendar(config).cancelReservation(externalId, config.calendarId);
        } catch (err) {
          console.error("[Agent] Failed to cancel Calendar event:", err);
          // Don't block — DB is already cancelled
        }
      }
      state.status = "greeting";
      state.data = {};
      return (
        `Listo, tu reserva *${formatResId(target.id)}* ha sido cancelada. ✅\n` +
        `Si deseas hacer una nueva reserva, con gusto te ayudo. 😊`
      );
    }

    if (CANCEL_WORDS.test(text)) {
      state.status = "greeting";
      state.data = {};
      return "Sin problema, tu reserva sigue activa. ¿Hay algo más en lo que pueda ayudarte? 😊";
    }

    return `¿Confirmas la cancelación de la reserva *${formatResId(target.id)}*? (sí / no)`;
  }

  private mergeFields(
    state: ConversationState,
    fields: Partial<import("../business/reservation.js").ReservationData>,
    raw: Record<string, string>,
    config: RestaurantConfig,
  ): void {
    if (raw.fecha) {
      const normalized = normalizeDate(raw.fecha, config.timezone);
      if (normalized) state.data.fecha = normalized;
    } else if (fields.fecha) {
      const normalized = normalizeDate(fields.fecha, config.timezone);
      if (normalized) state.data.fecha = normalized;
    }

    if (raw.hora) {
      const normalized = normalizeTime(raw.hora);
      if (normalized) state.data.hora = normalized;
    } else if (fields.hora) {
      const normalized = normalizeTime(fields.hora);
      if (normalized) state.data.hora = normalized;
    }

    if (fields.personas !== undefined) state.data.personas = fields.personas;
    // Don't overwrite nombre/peticiones once set — only update if not yet captured
    if (fields.nombre && !state.data.nombre) state.data.nombre = fields.nombre;
    if (fields.peticiones && !state.data.peticiones) state.data.peticiones = fields.peticiones;
  }
}

function hasMentionedPeticiones(
  history: import("../data/conversation-repo.js").Message[],
): boolean {
  return history.some(
    (m) =>
      m.role === "assistant" &&
      (m.content.includes("petición") || m.content.includes("alerg")),
  );
}

function escalationMessage(config: RestaurantConfig, reason: string): string {
  return (
    `Para este tipo de solicitud (${reason}) prefiero conectarte con nuestro equipo directamente.\n` +
    `Por favor contáctalos en ${config.humanPhone}. ¡Muchas gracias! 🙏`
  );
}

function formatDateNice(iso: string): string {
  const [y, m, d] = iso.split("-");
  const months = [
    "", "enero", "febrero", "marzo", "abril", "mayo", "junio",
    "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
  ];
  return `${parseInt(d)} de ${months[parseInt(m)]} de ${y}`;
}

function englishDow(spanishDow: string): string {
  const map: Record<string, string> = {
    lunes: "monday", martes: "tuesday", miércoles: "wednesday",
    jueves: "thursday", viernes: "friday", sábado: "saturday", domingo: "sunday",
  };
  return map[spanishDow] ?? spanishDow;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function buildWelcome(config: RestaurantConfig): string {
  return (
    `¡Bienvenido a *${config.name}*! 😊\n\n` +
    `¿En qué puedo ayudarte?\n` +
    `  1️⃣  Hacer una reserva\n` +
    `  2️⃣  Cancelar una reserva\n\n` +
    `Escribe *reserva*, *cancelar*, o cuéntame qué necesitas.`
  );
}

const RESERVATION_INTENT =
  /reserv|mesa|lugar|cupo|cena|comer|cenar|apartar|agendar|quiero\s+ir|visitar|quero\s+ir/i;

function handleGreeting(
  state: ConversationState,
  text: string,
  config: RestaurantConfig,
): string {
  if (CANCELLATION_INTENT.test(text) || /^2$/.test(text.trim())) {
    state.status = "cancelling_lookup";
    return CANCEL_LOOKUP_PROMPT;
  }

  if (RESERVATION_INTENT.test(text) || /^1$/.test(text.trim())) {
    state.status = "collecting";
    return "¡Con gusto! ¿Para qué fecha quieres la reserva? 😊";
  }

  // Unrecognized intent — stay in greeting
  return (
    `Por el momento puedo ayudarte con:\n` +
    `  1️⃣  Hacer una reserva\n` +
    `  2️⃣  Cancelar una reserva\n\n` +
    `¿Cuál necesitas? 😊`
  );
}

function cancelSummary(r: ReservationRecord): string {
  return (
    `Encontré esta reserva:\n` +
    `🔖 *${formatResId(r.id)}* — ${r.nombre}\n` +
    `📅 ${formatDateNiceMx(r.fecha)} a las ${r.hora}\n` +
    `👥 ${r.personas} personas`
  );
}

function formatDateNiceMx(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function minutesToHHMM(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60).toString().padStart(2, "0");
  const m = (totalMinutes % 60).toString().padStart(2, "0");
  return `${h}:${m}`;
}

/**
 * Returns 3 evenly-spaced slot suggestions within the valid booking window.
 */
function suggestSlots(openMin: number, lastSlotMin: number): string[] {
  const range = lastSlotMin - openMin;
  if (range <= 0) return [minutesToHHMM(openMin)];
  const step = Math.floor(range / 2);
  return [
    minutesToHHMM(openMin),
    minutesToHHMM(openMin + step),
    minutesToHHMM(lastSlotMin),
  ];
}

/**
 * Builds a human-readable list of open days and their hours.
 */
function formatOpenDays(config: RestaurantConfig): string {
  const hhmm = (t: string) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
  const DAYS_ES: Record<string, string> = {
    monday: "Lunes", tuesday: "Martes", wednesday: "Miércoles",
    thursday: "Jueves", friday: "Viernes", saturday: "Sábado", sunday: "Domingo",
  };
  return Object.entries(config.schedule)
    .filter(([, s]) => s !== null)
    .map(([day, s]) => {
      const lastSlot = minutesToHHMM(hhmm(s!.close) - config.slotDurationMinutes);
      return `  • *${DAYS_ES[day]}*: ${s!.open} – ${s!.close} (última reserva ${lastSlot})`;
    })
    .join("\n");
}
