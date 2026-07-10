import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";
import type { ILLMClient, MessageIntent } from "../../shared/llm/llm.interface.js";
import type { RestaurantConfig } from "../../shared/config/types.js";
import { getCalendarClient } from "../integrations/calendar/factory.js";
import { getMenuClient, type MenuItem } from "../integrations/sheets/menu-client.js";
import {
  loadConversation,
  saveConversation,
  saveReservation,
  saveOrder,
  formatOrderId,
  updateReservationExternalId,
  resetConversation,
  findReservationById,
  findReservationByNameAndDate,
  cancelReservationById,
  findLastCustomerName,
  formatResId,
  parseResId,
  type ConversationState,
  type ReservationRecord,
} from "../data/conversation-repo.js";
import { normalizeDate, normalizeTime } from "../business/normalizer.js";
import { nextAction, buildSummary, formatTimeDisplay } from "./gap-filler.js";
import { buildSystemPrompt } from "./prompts.js";
import { isQuestion } from "./qa-helpers.js";
import { currentOpenStatus, nextOpenDaySchedule } from "../business/schedule.js";
import { type OrderItem, formatOrderSummary, orderTotal } from "../business/order.js";
import { getCRMClient } from "../integrations/sheets/crm-client.js";

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
  /^\s*(no|nope|cancela|cancelar|no\s+quiero|mejor\s+no|siempre\s+no|ya\s+no|nah|para\s+atr[aá]s|regresa|volver|déjalo|dejalo|no\s+gracias|no\s+la\s+confirmes|no\s+lo\s+quiero|no\s+la\s+quiero|no\s+lo\s+hagas|no\s+la\s+hagas|olv[íi]dalo|olv[íi]dala|olvida|no\s+procede|no\s+mandes?|no\s+confirmes?)\s*[.!?¡¿]*\s*$/i;

// Phrases that signal "never mind, drop this flow" — can appear at start of longer messages
const ABANDON_FLOW =
  /^\s*(siempre\s+no|mejor\s+no|ya\s+no|en\s+realidad\s+no|la\s+verdad\s+no|no\s+mejor|d[eé]jalo|olv[íi]d[ao]|nah)\b/i;

const FAREWELL_WORDS =
  /^\s*(gracias|muchas\s+gracias|thank(s| you)|de\s+nada|ok\s+gracias|perfecto\s+gracias|listo\s+gracias|hasta\s+luego|hasta\s+pronto|nos\s+vemos|chao|bye|adiós|adios|cu[íi]date|cuidate)\s*[.!?¡¿]*\s*$/i;

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

    // First message in this session (new or reset conversation)
    if (state.history.length === 0) {
      const pastName = findLastCustomerName(phone, restaurantId);
      if (pastName) {
        // Returning customer — skip name question, go straight to options
        state.data.guestName = pastName;
        state.data.nombre = pastName;
        state.status = "greeting";
        state.history.push({ role: "user", content: text });
        const welcome = buildReturnWelcome(config, pastName);
        state.history.push({ role: "assistant", content: welcome });
        saveConversation(state);
        return welcome;
      }
      // New customer — ask for name first
      state.status = "asking_name";
      state.history.push({ role: "user", content: text });
      const nameQuestion = `¡Hola! 😊 Bienvenid@ a *${config.name}*, es un placer atenderte.\n¿Con quién tengo el gusto?`;
      state.history.push({ role: "assistant", content: nameQuestion });
      saveConversation(state);
      return nameQuestion;
    }

    state.history.push({ role: "user", content: text });

    // Trim history to prevent unbounded growth (keeps last 40 messages)
    if (state.history.length > 40) {
      state.history = state.history.slice(-40);
    }

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

  private async getIntent(
    state: ConversationState,
    text: string,
    _config: RestaurantConfig,
  ): Promise<MessageIntent> {
    const collectedFields = [
      state.data.fecha    ? `fecha: ${state.data.fecha}`       : null,
      state.data.hora     ? `hora: ${state.data.hora}`         : null,
      state.data.personas ? `personas: ${state.data.personas}` : null,
      state.data.nombre   ? `nombre: ${state.data.nombre}`     : null,
    ].filter(Boolean).join(", ");

    try {
      return await this.llm.classifyIntent(
        state.status,
        collectedFields || "ninguno",
        state.history.slice(-6, -1),
        text,
      );
    } catch {
      return this.fallbackIntent(text);
    }
  }

  private fallbackIntent(text: string): MessageIntent {
    return {
      isReservation:     RESERVATION_INTENT.test(text),
      isOrder:           ORDER_INTENT.test(text),
      isCancelFlow:      CANCELLATION_INTENT.test(text),
      isConfirm:         CONFIRM_WORDS.test(text),
      isReject:          CANCEL_WORDS.test(text),
      isFarewell:        FAREWELL_WORDS.test(text),
      isAbandon:         ABANDON_FLOW.test(text),
      isQuestion:        isQuestion(text),
      isDoneOrdering:    DONE_WORDS.test(text),
      isCategoryNav:     CATEGORY_NAV.test(text),
      isReset:           RESET_CMD.test(text),
      isNegativeResponse: /^\s*(ninguna?|no|nada|sin\s+nada|no\s+tengo|ningún|no\s+gracias|no\s+hay|no\s+tengo\s+ninguna?|sin\s+petici[oó]n|sin\s+nada\s+especial|no\s+necesito(\s+nada)?|estamos\s+bien|todo\s+bien|sin\s+problema|no\s+tengo\s+nada|estoy\s+bien|sin\s+especial|no\s+especial|no\s+pasa\s+nada)\s*$/i.test(text),
    };
  }

  private async process(
    state: ConversationState,
    text: string,
    config: RestaurantConfig,
  ): Promise<string> {
    // ── Pedido web enviado desde pedido.html ─────────────────────────────────
    if (text.startsWith("PEDIDO_WEB:")) {
      if (!ordersOn(config)) {
        return disabledMethodMessage("pedidos", config);
      }
      return await this.handleWebOrder(state, text, config);
    }

    // ── Respuesta al "¿con quién tengo el gusto?" ────────────────────────────
    if (state.status === "asking_name") {
      const name = extractName(text);
      if (name) {
        state.data.guestName = name;
        // Pre-fill reservation nombre so they don't have to repeat it
        state.data.nombre = name;
      }
      state.status = "greeting";
      const welcome = buildWelcome(config, state.data.guestName);
      return welcome;
    }

    const intent = await this.getIntent(state, text, config);

    // ── Comando global: R / r / 0 → volver al menú principal ────────────────
    if ((intent.isReset || RESET_CMD.test(text)) && state.status !== "greeting") {
      clearData(state);
      state.status = "greeting";
      state.history = [{ role: "user", content: text }];
      return buildWelcome(config, state.data.guestName);
    }

    // After confirmed/escalated/cancelled handle appropriately
    if (state.status === "confirmed" || state.status === "escalated" || state.status === "cancelled") {
      if (state.status === "escalated") {
        // User is correcting the data that caused escalation — clear bad field and continue
        state.data.personas = undefined;
        state.status = "collecting";
        // Fall through to field extraction
      } else if (state.status === "confirmed" && (intent.isFarewell || FAREWELL_WORDS.test(text))) {
        state.status = "greeting";
        clearData(state);
        return `¡Con mucho gusto${state.data.guestName ? `, *${state.data.guestName}*` : ""}! 😊 Que lo disfrutes. Si necesitas algo más, aquí estoy.`;
      } else {
        // Returning message after completed/cancelled flow — reset data but keep history
        // so the intent routing below handles the message naturally (no welcome splash)
        state.status = "greeting";
        clearData(state);
      }
    }

    // ── Saludo mid-flujo: recordar contexto en lugar de ignorar ─────────────
    if (GREETING_WORDS.test(text) && state.status !== "greeting") {
      return buildContextReminder(state, config);
    }

    // Greeting → detect intent before starting collection.
    // When the intent moves us to "collecting", fall through to field extraction
    // so the user doesn't have to repeat data they already gave (e.g. "quiero
    // reserva para el sábado a las 8").
    if (state.status === "greeting") {
      // ORDER_INTENT needs async menu load — check first
      if (intent.isOrder || /^3$/.test(text.trim())) {
        // Método de pedidos apagado explícitamente en el Sheet maestro
        if (config.ordersEnabled === false) {
          return disabledMethodMessage("pedidos", config);
        }
        if (ordersOn(config)) {
          const openStatus = currentOpenStatus(config);
          if (!openStatus.isOpen) {
            // Closed — offer pre-order for next opening slot
            const next = nextOpenDaySchedule(config);
            if (next) {
              state.status = "ordering_preorder_time";
              state.data.order = { items: [] };
              return (
                `Ahorita estamos cerrados 😴, pero con gusto te tomo el pedido para recoger *${next.label}*.\n` +
                `Atendemos de *${next.open}* a *${next.close}*.\n\n` +
                `¿A qué hora quieres pasar? 😊`
              );
            }
            return `Lo sentimos, en este momento estamos cerrados. Por favor intenta cuando abramos. 🙏`;
          }
          state.status = "ordering_ask";
          return await this.buildOrderingAskMessage(config);
        }
        // Sin menú configurado → cae al Q&A de abajo (comportamiento original)
      }
      if (intent.isCancelFlow || /^2$/.test(text.trim())) {
        if (!reservationsOn(config)) {
          return disabledMethodMessage("reservas", config);
        }
        state.status = "cancelling_lookup";
        return CANCEL_LOOKUP_PROMPT;
      }
      if ((intent.isReservation || /^1$/.test(text.trim())) && !reservationsOn(config)) {
        return disabledMethodMessage("reservas", config);
      }
      if (intent.isReservation || /^1$/.test(text.trim())) {
        state.status = "collecting";
        // Fall through to field extraction — any data already given gets extracted
      } else if (GREETING_WORDS.test(text)) {
        // User says "hola" with no specific intent — they've been here before, show brief options
        return buildReturnGreeting(config, state.data.guestName);
      } else {
        // Unknown intent: answer as Q&A without changing status
        return await this.answerQuestion(state, text, config);
      }
    }

    // Ordering flow
    if (state.status === "ordering_preorder_time") {
      return await this.handleOrderingPreorderTime(state, text, config);
    }
    if (state.status === "ordering_web_name") {
      return this.handleWebOrderName(state, text, config);
    }
    if (state.status === "ordering_ask") {
      return await this.handleOrderingAsk(state, text, config, intent);
    }
    if (state.status === "ordering_category") {
      return await this.handleOrderingCategory(state, text, config, intent);
    }
    if (state.status === "ordering_link" || state.status === "ordering_items") {
      return await this.handleOrderingItems(state, text, config, intent);
    }
    if (state.status === "ordering_confirm") {
      return await this.handleOrderingConfirm(state, text, config, intent);
    }

    // Cancellation flow
    if (state.status === "cancelling_lookup") {
      return this.handleCancelLookup(state, text, config);
    }
    if (state.status === "cancelling_confirm") {
      return this.handleCancelConfirm(state, text, config);
    }

    // User abandons the in-progress reservation and may switch to ordering
    if (intent.isAbandon && (state.status === "collecting" || state.status === "confirming")) {
      clearData(state);
      if (ordersOn(config) && intent.isOrder) {
        state.status = "ordering_ask";
        return `Sin problema. 😊\n\n${await this.buildOrderingAskMessage(config)}`;
      }
      state.status = "greeting";
      return buildReturnGreeting(config, state.data.guestName);
    }

    // Cancellation intent mid-flow (collecting or confirming)
    if (intent.isCancelFlow && (state.status === "collecting" || state.status === "confirming")) {
      state.status = "cancelling_lookup";
      return CANCEL_LOOKUP_PROMPT;
    }

    // Handle confirmation step
    if (state.status === "confirming") {
      return await this.handleConfirmation(state, text, config, intent);
    }

    // Negative / "ninguna" response to the peticiones question → treat as empty
    if (
      state.data.nombre &&
      state.data.peticiones === undefined &&
      hasMentionedPeticiones(state.history) &&
      intent.isNegativeResponse
    ) {
      state.data.peticiones = "";
    }

    // Snapshot before extraction — used below to detect if this message adds new data
    const snapFields = {
      fecha: state.data.fecha,
      hora: state.data.hora,
      personas: state.data.personas,
      nombre: state.data.nombre,
      peticiones: state.data.peticiones,
    };

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

    // 3. PERSONAS — bare number or word-number when fecha + hora are known.
    //    Guard 1: skip if hora was set for the FIRST TIME in this same message —
    //             the digit the user wrote is the hour, not the guest count.
    //    Guard 2: skip if text contains time-period words ("de la tarde", "de la mañana", etc.)
    //             because the visible digit belongs to the time expression.
    //    Guard 3: skip if text contains ":" (time correction like "20:00").
    const horaJustSetThisTurn = !!state.data.hora && snapFields.hora === undefined;
    if (
      !state.data.personas &&
      state.data.fecha &&
      state.data.hora &&
      !text.includes(":") &&
      !horaJustSetThisTurn
    ) {
      const hasTimePeriod =
        /de\s+la\s+(ma[nñ]ana|tarde|noche|madrugada)|a\s+las?\s*\d|\b(am|pm)\b|\d{1,2}\s*h(?:rs?)?/i.test(text);
      if (!hasTimePeriod) {
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
    }

    // Determine next action (pure, deterministic)
    const action = nextAction(state.data, config);

    if (action.type === "escalate") {
      state.status = "escalated";
      return escalationMessage(config, action.reason);
    }

    if (action.type === "ask") {
      // If no new field was captured AND the message looks like a question,
      // answer it with AI and then re-ask the pending field.
      const newFieldAdded =
        state.data.fecha    !== snapFields.fecha    ||
        state.data.hora     !== snapFields.hora     ||
        state.data.personas !== snapFields.personas ||
        state.data.nombre   !== snapFields.nombre   ||
        state.data.peticiones !== snapFields.peticiones;
      if (!newFieldAdded && intent.isQuestion) {
        return await this.answerQuestion(state, text, config, action.question);
      }
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
          `Ay, los *${dowES}* no abrimos. Estos son los días que sí puedo apartarte:\n\n` +
          formatOpenDays(config) +
          `\n\n¿Para cuál de esos te acomoda?`
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
          `Ese horario se nos va un poco los *${dowES}* — atendemos de *${daySchedule.open}* a *${daySchedule.close}* y la última reserva es a las *${lastSlotStr}*.\n\n` +
          `Algunos que sí están disponibles: ${suggestions.join(", ")}\n\n` +
          `¿Te late alguno de esos?`
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
          `Mmm, a las *${formatTimeDisplay(horaRequested)}* ya está algo lleno para ${state.data.personas} personas. 😔\n\n` +
          `Otros que podrían estar libres: ${suggestions.join(", ")}\n\n` +
          `¿Alguno de esos te viene?`
        );
      }

      return "¡Listo, sí tenemos lugar! ¿A nombre de quién la dejo?";
    }

    if (action.type === "confirm") {
      // Ask for peticiones first (separate turn), then show summary
      if (state.data.peticiones === undefined && !hasMentionedPeticiones(state.history)) {
        state.status = "collecting";
        return `¿Algo que deba saber para recibirte mejor, ${state.data.nombre}? Un cumpleaños, una alergia, un lugar tranquilo… o si todo está bien, también me dices y listo.`;
      }
      state.status = "confirming";
      return action.summary;
    }

    // Fallback final: el LLM razona con todo el contexto disponible
    return await this.answerQuestion(state, text, config);
  }

  private async handleConfirmation(
    state: ConversationState,
    text: string,
    config: RestaurantConfig,
    intent: MessageIntent,
  ): Promise<string> {
    if (intent.isConfirm || CONFIRM_WORDS.test(text)) {
      // Save to DB first to get the reservation ID, then sync to Calendar and Sheets
      const resId = saveReservation(state);
      const resCode = formatResId(resId);
      this.appendReservationToSheets(config, resCode, state);

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

      const websiteLineRes = config.websiteUrl ? `\n\n🌐 Visítanos en ${config.websiteUrl}` : "";
      return (
        `¡Quedó, ${state.data.nombre}! Te esperamos el ${formatDateNice(state.data.fecha!)} a las *${formatTimeDisplay(state.data.hora!)}*, mesa para ${state.data.personas}.\n` +
        `Tu folio por si lo necesitas: *${resCode}*\n` +
        `${config.cancellationPolicy}\n\n` +
        `Cualquier cosa, escríbeme con confianza ☕` +
        websiteLineRes
      );
    }

    if (intent.isReject || intent.isAbandon || CANCEL_WORDS.test(text)) {
      clearData(state);
      if (ordersOn(config) && intent.isOrder) {
        state.status = "ordering_ask";
        return `Sin problema, olvidamos la reserva. 😊\n\n${await this.buildOrderingAskMessage(config)}`;
      }
      resetConversation(state.phone);
      state.status = "cancelled";
      return "Sin problema, quedó cancelado. Si cambias de opinión, escríbeme cuando quieras. 👋";
    }

    // If the user is asking a question, answer it and re-show the summary
    if (intent.isQuestion) {
      const reply = await this.answerQuestion(state, text, config);
      const action = nextAction(state.data, config);
      const summary = action.type === "confirm" ? action.summary : buildSummary(state.data, config);
      return `${reply}\n\n${summary}`;
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
        return cancelSummary(found) + "\n\n¿Confirmamos la cancelación?";
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
        return cancelSummary(found) + "\n\n¿Confirmamos la cancelación?";
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
      clearData(state);
      return (
        `Listo, tu reserva *${formatResId(target.id)}* ha sido cancelada. ✅\n` +
        `Si deseas hacer una nueva reserva, con gusto te ayudo. 😊`
      );
    }

    if (CANCEL_WORDS.test(text)) {
      state.status = "greeting";
      clearData(state);
      return "Sin problema, tu reserva sigue activa. ¿Hay algo más en lo que pueda ayudarte? 😊";
    }

    return `¿Confirmamos la cancelación de la reserva *${formatResId(target.id)}*?`;
  }

  private async handleOrderingPreorderTime(
    state: ConversationState,
    text: string,
    config: RestaurantConfig,
  ): Promise<string> {
    const pickupTime = normalizeTime(text.trim());

    if (!pickupTime) {
      return `No entendí el horario. ¿A qué hora quieres pasar? Por ejemplo: *9:00*, *10 de la mañana*, *2 pm* 😊`;
    }

    const next = nextOpenDaySchedule(config);
    if (next) {
      const toMin = (hhmm: string) => {
        const [h, m] = hhmm.split(":").map(Number);
        return h * 60 + m;
      };
      const pickupMin = toMin(pickupTime);
      const openMin = toMin(next.open);
      const closeMin = toMin(next.close);

      if (pickupMin < openMin || pickupMin >= closeMin) {
        return (
          `Ese horario queda fuera — atendemos *${next.label}* de *${next.open}* a *${next.close}*.\n` +
          `¿A qué hora te viene mejor? 😊`
        );
      }
    }

    if (!state.data.order) state.data.order = { items: [] };
    state.data.order.pickupTime = pickupTime;
    state.status = "ordering_ask";
    return (
      `Perfecto, anotado para las *${formatTimeDisplay(pickupTime)}* 🕐\n\n` +
      `${await this.buildOrderingAskMessage(config)}`
    );
  }

  private async handleWebOrder(
    state: ConversationState,
    text: string,
    config: RestaurantConfig,
  ): Promise<string> {
    try {
      const json = text.slice("PEDIDO_WEB:".length).trim();
      const parsed = JSON.parse(json) as { items: OrderItem[] };
      if (!parsed.items || !Array.isArray(parsed.items) || parsed.items.length === 0) {
        throw new Error("empty order");
      }
      state.data.order = { items: parsed.items };
      state.status = "ordering_web_name";
      const openStatus = currentOpenStatus(config);
      const closedNote = !openStatus.isOpen && openStatus.nextOpen
        ? `\n\n🕐 Estamos cerrados ahorita — lo tendremos listo *${openStatus.nextOpen}*.`
        : "";
      return (
        `🛒 ¡Recibí tu pedido de *${config.name}*!\n\n` +
        formatOrderSummary(parsed.items) +
        closedNote +
        `\n\n¿A nombre de quién quedamos? 😊`
      );
    } catch {
      state.status = "greeting";
      return (
        `¡Hola! Recibí un mensaje desde la página, pero tuve un pequeño problema al leerlo.\n` +
        `¿Me dices qué quieres pedir y con gusto te ayudo? 😊`
      );
    }
  }

  private handleWebOrderName(
    state: ConversationState,
    text: string,
    config: RestaurantConfig,
  ): string {
    const nombre = text.trim();
    if (!nombre || nombre.length < 2) {
      return "¿A nombre de quién queda el pedido? 😊";
    }
    const order = state.data.order ?? { items: [] };
    state.data.nombre = nombre;
    const pickupTime = order.pickupTime;
    const pickup = pickupTime
      ? formatTimeDisplay(pickupTime)
      : dayjs().tz(config.timezone).add(30, "minute").format("HH:mm");
    const pickupLabel = pickupTime
      ? `listo para las *${pickup}*`
      : `listo para las *${pickup}* aprox.`;
    state.status = "ordering_confirm";
    return (
      `¡Perfecto, *${nombre}*! Aquí tu pedido:\n\n` +
      formatOrderSummary(order.items) +
      `\n\n⏰ Tiempo estimado: ${pickupLabel}\n\n` +
      `¿Confirmamos? (sí / no)`
    );
  }

  private menuClient(config: RestaurantConfig) {
    if (!config.sheetsId || !config.googleCredentialsPath) return null;
    return getMenuClient(config.googleCredentialsPath, config.sheetsId);
  }

  private async buildOrderingAskMessage(config: RestaurantConfig): Promise<string> {
    const client = this.menuClient(config);
    if (!client) {
      return "Lo siento, el sistema de pedidos no está disponible en este momento. 🙏";
    }
    let menuItems: MenuItem[];
    try {
      menuItems = await client.getMenu();
    } catch {
      return "Tuve un problema cargando el menú. Por favor intenta de nuevo. 🙏";
    }
    const categories = uniqueCategories(menuItems);
    return buildCategoryList(categories, config.menuWebUrl);
  }

  private async handleOrderingAsk(
    state: ConversationState,
    text: string,
    config: RestaurantConfig,
    intent: MessageIntent,
  ): Promise<string> {
    const client = this.menuClient(config);
    if (!client) return "Lo siento, el sistema de pedidos no está disponible. 🙏";

    let menuItems: MenuItem[];
    try {
      menuItems = await client.getMenu();
    } catch {
      return "Tuve un problema cargando el menú. Por favor intenta de nuevo. 🙏";
    }

    const categories = uniqueCategories(menuItems);

    // User selected a category number
    const numMatch = text.trim().match(/^(\d+)$/);
    if (numMatch) {
      const idx = parseInt(numMatch[1], 10) - 1;
      if (idx >= 0 && idx < categories.length) {
        const cat = categories[idx];
        state.status = "ordering_category";
        if (!state.data.order) state.data.order = { items: [] };
        state.data.order.pendingCategory = cat;
        const catItems = menuItems.filter((i) => i.categoria === cat);
        return buildCategoryItemsList(cat, catItems);
      }
    }

    // User typed a product name — try to extract it
    const extracted = await this.llm.extractOrderItems(state.history.slice(0, -1), text);
    if (extracted.items.length > 0) {
      state.status = "ordering_items";
      return await this.handleOrderingItems(state, text, config, intent);
    }

    // No encaja en el flujo de pedido → el LLM razona y responde con contexto
    const reply = await this.answerQuestion(state, text, config);
    return `${reply}\n\n${buildCategoryList(categories, config.menuWebUrl)}`;
  }

  private async handleOrderingCategory(
    state: ConversationState,
    text: string,
    config: RestaurantConfig,
    intent: MessageIntent,
  ): Promise<string> {
    const client = this.menuClient(config);
    if (!client) return "Lo siento, el sistema de pedidos no está disponible. 🙏";

    let menuItems: MenuItem[];
    try {
      menuItems = await client.getMenu();
    } catch {
      return "Tuve un problema cargando el menú. Por favor intenta de nuevo. 🙏";
    }

    const categories = uniqueCategories(menuItems);
    const pendingCat = state.data.order?.pendingCategory ?? "";
    const catItems = menuItems.filter((i) => i.categoria === pendingCat);

    // "categorías" → back to category list
    if (intent.isCategoryNav || CATEGORY_NAV.test(text)) {
      state.status = "ordering_ask";
      return buildCategoryList(categories, config.menuWebUrl);
    }

    // User selected an item number from the category list
    const numMatch = text.trim().match(/^(\d+)$/);
    if (numMatch && catItems.length > 0) {
      const idx = parseInt(numMatch[1], 10) - 1;
      if (idx >= 0 && idx < catItems.length) {
        const chosen = catItems[idx];
        const order = state.data.order ?? { items: [] };

        // Merge with existing identical item
        const existing = order.items.find(
          (i) => i.nombre === chosen.nombre && !i.extras.length && !i.sin.length,
        );
        if (existing) {
          existing.cantidad += 1;
        } else {
          order.items.push({
            nombre: chosen.nombre,
            precio: chosen.precio,
            cantidad: 1,
            extras: [],
            sin: [],
          });
        }
        state.data.order = order;
        state.status = "ordering_items";
        return (
          `✅ *${chosen.nombre}* agregado. $${chosen.precio}\n\n` +
          `Tu pedido:\n${formatOrderSummary(order.items)}\n\n` +
          `¿Algo más? Escribe el nombre, elige otra *categoría* o escribe *listo*. 😊`
        );
      }
      return `Ese número no está en la lista.\n\n${buildCategoryItemsList(pendingCat, catItems)}`;
    }

    // User typed a product name — fall into items flow
    state.status = "ordering_items";
    return await this.handleOrderingItems(state, text, config, intent);
  }

  private async handleOrderingItems(
    state: ConversationState,
    text: string,
    config: RestaurantConfig,
    intent: MessageIntent,
  ): Promise<string> {
    const order = state.data.order ?? { items: [] };

    // "categorías" → show category list (keeps current order in memory)
    if (intent.isCategoryNav || CATEGORY_NAV.test(text)) {
      state.status = "ordering_ask";
      const msg = await this.buildOrderingAskMessage(config);
      if (order.items.length > 0) {
        return `Tu pedido hasta ahora:\n${formatOrderSummary(order.items)}\n\n${msg}`;
      }
      return msg;
    }

    if (intent.isDoneOrdering || DONE_WORDS.test(text)) {
      if (order.items.length === 0) {
        return "Todavía no has agregado nada. Dime qué quieres ordenar o visita el menú para elegir. 😊";
      }
      state.data.order = order;
      state.status = "ordering_confirm";
      return (
        `Perfecto, aquí está tu pedido:\n\n${formatOrderSummary(order.items)}\n\n` +
        `¿Lo confirmamos así?`
      );
    }

    const client = this.menuClient(config);
    if (!client) {
      return "Lo siento, el sistema de pedidos no está disponible en este momento. 🙏";
    }

    let menuItems: MenuItem[];
    try {
      menuItems = await client.getMenu();
    } catch (err) {
      console.error("[Agent] Failed to load menu from Sheets:", err);
      return "Tuve un problema cargando el menú. Por favor intenta de nuevo en un momento. 🙏";
    }

    // Extract items from customer message
    const extracted = await this.llm.extractOrderItems(state.history.slice(0, -1), text);

    // Handle removal request ("quita el espresso")
    if (extracted.removeNombre) {
      const norm = (s: string) =>
        s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
      const target = norm(extracted.removeNombre);
      const beforeLen = order.items.length;
      order.items = order.items.filter((i) => !norm(i.nombre).includes(target));

      if (order.items.length < beforeLen) {
        state.data.order = order;
        if (order.items.length === 0) {
          return "Listo, lo quité. Tu pedido está vacío. ¿Qué quieres ordenar? 😊";
        }
        return (
          `Listo, lo eliminé. Hasta ahora:\n\n${formatOrderSummary(order.items)}\n\n` +
          `¿Algo más o escribe *listo*?`
        );
      }
      return "No encontré ese artículo en tu pedido. ¿Qué quieres quitar?";
    }

    // Process new items
    const notFound: string[] = [];

    for (const raw of extracted.items) {
      const menuItem = client.findByName(raw.nombre, menuItems);
      if (!menuItem) {
        notFound.push(raw.nombre);
        continue;
      }

      // Validate modifications against what's defined in the sheet
      const normMod = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
      const validExtras = raw.extras.filter((e) =>
        menuItem.extras.some((me) => normMod(me).includes(normMod(e)) || normMod(e).includes(normMod(me))),
      );
      const validSin = raw.sin.filter((s) =>
        menuItem.sinOpciones.some((ms) => normMod(ms).includes(normMod(s)) || normMod(s).includes(normMod(ms))),
      );

      // Unknown mods become a kitchen note
      const unknownExtras = raw.extras.filter((e) => !validExtras.includes(e));
      const unknownSin   = raw.sin.filter((s) => !validSin.includes(s));
      const unknownParts = [
        ...unknownExtras.map((e) => `+ ${e}`),
        ...unknownSin.map((s)   => `sin ${s}`),
        raw.nota ?? "",
      ].filter(Boolean);
      const nota = unknownParts.length ? `petición especial: ${unknownParts.join(", ")}` : raw.nota;

      // Merge with existing identical item
      const existing = order.items.find(
        (i) =>
          i.nombre === menuItem.nombre &&
          JSON.stringify(i.extras) === JSON.stringify(validExtras) &&
          JSON.stringify(i.sin) === JSON.stringify(validSin),
      );
      if (existing) {
        existing.cantidad += raw.cantidad;
      } else {
        const newItem: OrderItem = {
          nombre:   menuItem.nombre,
          precio:   menuItem.precio,
          cantidad: raw.cantidad,
          extras:   validExtras,
          sin:      validSin,
          nota,
        };
        order.items.push(newItem);
      }
    }

    state.data.order = order;
    state.status = "ordering_items";

    const parts: string[] = [];

    if (extracted.items.length > 0 && extracted.items.length > notFound.length) {
      parts.push("✅ Anotado.");
    }
    if (notFound.length > 0) {
      const menuUrl = config.menuWebUrl ?? "el menú";
      parts.push(
        `No encontré: *${notFound.join(", ")}*. ` +
        `Verifica en ${menuUrl}`,
      );
    }

    if (extracted.isDone && order.items.length > 0) {
      state.status = "ordering_confirm";
      return (
        parts.join("\n") +
        `\n\nAquí está tu pedido:\n\n${formatOrderSummary(order.items)}\n\n` +
        `¿Lo confirmamos así?`
      );
    }

    if (order.items.length > 0) {
      parts.push(
        `\nHasta ahora:\n${formatOrderSummary(order.items)}\n\n` +
        `¿Algo más? Si terminaste, escribe *listo*.`,
      );
    } else if (extracted.items.length === 0) {
      if (intent.isQuestion) {
        const pendingOrder =
          order.items.length > 0
            ? `Tu pedido hasta ahora:\n${formatOrderSummary(order.items)}\n\n¿Algo más o escribes *listo*?`
            : "¿Qué quieres ordenar? 😊";
        return await this.answerQuestion(state, text, config, pendingOrder);
      }
      const menuUrl = config.menuWebUrl ?? "el menú";
      parts.push(
        `No pude identificar ningún producto. ` +
        `Puedes ver el menú en ${menuUrl} y decirme qué quieres. 😊`,
      );
    }

    return parts.join("\n") || "¿Qué más te gustaría? 😊";
  }

  private async handleOrderingConfirm(
    state: ConversationState,
    text: string,
    config: RestaurantConfig,
    intent: MessageIntent,
  ): Promise<string> {
    const order = state.data.order ?? { items: [] };

    if (intent.isConfirm || CONFIRM_WORDS.test(text)) {
      if (order.items.length === 0) {
        state.status = "greeting";
        return buildWelcome(config, state.data.guestName);
      }
      const pickupTime = order.pickupTime;
      const orderId = saveOrder(state);
      const orderCode = formatOrderId(orderId);
      this.appendOrderToSheets(config, orderCode, state);
      state.status = "confirmed";
      clearData(state);

      const pickupLine = pickupTime
        ? `🕐 Para recoger a las *${formatTimeDisplay(pickupTime)}*\n`
        : ``;
      const websiteLineOrder = config.websiteUrl ? `\n\n🌐 Visítanos en ${config.websiteUrl}` : "";
      return (
        `¡Listo! 🎉 Tu pedido está registrado en *${config.name}*.\n` +
        `🔖 Número de pedido: *${orderCode}*\n` +
        pickupLine +
        `En breve el equipo lo prepara. ¡Gracias! ☕` +
        websiteLineOrder
      );
    }

    if (intent.isReject || CANCEL_WORDS.test(text)) {
      state.status = "ordering_items";
      return (
        `Sin problema. Tu pedido actual:\n\n${formatOrderSummary(order.items)}\n\n` +
        `¿Qué quieres cambiar o agregar? Si terminaste escribe *listo*.`
      );
    }

    // Customer might be correcting the order — try to extract items
    const client = this.menuClient(config);
    if (client) {
      try {
        const menuItems = await client.getMenu();
        const extracted = await this.llm.extractOrderItems(state.history.slice(0, -1), text);
        if (extracted.items.length > 0 || extracted.removeNombre) {
          state.status = "ordering_items";
          return await this.handleOrderingItems(state, text, config, intent);
        }
      } catch {
        // ignore and fall through
      }
    }

    return (
      `Tu pedido:\n\n${formatOrderSummary(order.items)}\n\n` +
      `¿Lo confirmamos así?`
    );
  }

  private async answerQuestion(
    state: ConversationState,
    text: string,
    config: RestaurantConfig,
    pendingQuestion?: string,
  ): Promise<string> {
    // Load menu as additional context when available
    let menuText: string | undefined;
    if (config.sheetsId) {
      try {
        const client = this.menuClient(config);
        if (client) {
          const items = await client.getMenu();
          if (items.length > 0) {
            menuText = client.menuText(items);
          }
        }
      } catch {
        // proceed without menu context
      }
    }

    const systemPrompt = buildSystemPrompt(config, menuText, dayjs().tz(config.timezone));
    let reply = await this.llm.generateReply(systemPrompt, state.history.slice(0, -1), text);

    // Re-attach the pending field question so the conversation doesn't stall
    if (pendingQuestion) {
      reply = reply.trimEnd() + `\n\n${pendingQuestion}`;
    }

    return reply;
  }

  private crmClient(config: RestaurantConfig) {
    if (!config.sheetsId || !config.googleCredentialsPath) return null;
    return getCRMClient(config.googleCredentialsPath, config.sheetsId);
  }

  private appendOrderToSheets(
    config: RestaurantConfig,
    orderCode: string,
    state: ConversationState,
  ): void {
    const client = this.crmClient(config);
    if (!client) return;
    client
      .appendOrder({ orderCode, restaurantName: config.name, state, timezone: config.timezone, crmWebhookUrl: config.crmWebhookUrl })
      .catch((err) => console.error("[CRM] Failed to append order:", err));
  }

  private appendReservationToSheets(
    config: RestaurantConfig,
    resCode: string,
    state: ConversationState,
  ): void {
    const client = this.crmClient(config);
    if (!client) return;
    client
      .appendReservation({ resCode, restaurantName: config.name, state, timezone: config.timezone, crmWebhookUrl: config.crmWebhookUrl })
      .catch((err) => console.error("[CRM] Failed to append reservation:", err));
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
    `Para ${reason} te conviene hablar directamente con el equipo — te van a atender de maravilla.\n` +
    `Escríbeles al ${config.humanPhone} y cuéntales lo que necesitas. ¡Muchas gracias! 🙏`
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

/** Resets reservation/order data while keeping the customer's name across flows. */
function clearData(state: { data: import("../business/reservation.js").ReservationData }): void {
  state.data = { guestName: state.data.guestName };
}

/**
 * Tries to extract a person's name from a raw text message.
 * Strips common intro phrases (e.g. "me llamo", "soy") and title-cases the result.
 * Returns null if the result looks too short, too long, or like a command.
 */
function extractName(text: string): string | null {
  const clean = text
    .trim()
    .replace(/^(?:hola[,!]?\s*)?(?:soy|me\s+llamo|mi\s+nombre\s+(?:es|de)\s+)?/i, "")
    .trim();
  if (clean.length < 2 || clean.length > 50 || /^[0-9]/.test(clean)) return null;
  // Title-case each word, take first 3 words max
  return clean
    .split(/\s+/)
    .slice(0, 3)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

// ── Métodos del chatbot activos por restaurante ─────────────────────────────
// Celda vacía en el Sheet = activo; solo un FALSE explícito apaga el método.
function reservationsOn(config: RestaurantConfig): boolean {
  return config.reservationsEnabled !== false;
}

function ordersOn(config: RestaurantConfig): boolean {
  return config.ordersEnabled !== false && Boolean(config.sheetsId);
}

/** Menú de opciones según los métodos activos (los números se mantienen fijos). */
function buildOptionsMenu(config: RestaurantConfig): string {
  const lines: string[] = [];
  if (reservationsOn(config)) {
    lines.push("  1️⃣  Hacer una reserva");
    lines.push("  2️⃣  Cancelar una reserva");
  }
  if (ordersOn(config)) lines.push("  3️⃣  Hacer un pedido");
  return lines.join("\n");
}

function disabledMethodMessage(method: "reservas" | "pedidos", config: RestaurantConfig): string {
  const contact = config.humanPhone ? ` Si gustas, comunícate al *${config.humanPhone}*.` : "";
  return `Por el momento no manejamos ${method} por este medio 🙏${contact}\n\n¿Te puedo ayudar con algo más? 😊`;
}

function buildWelcome(config: RestaurantConfig, name?: string): string {
  const status = currentOpenStatus(config);
  const statusLine = status.isOpen
    ? `🟢 Abiertos hasta las ${status.todaySchedule!.close} hrs`
    : `🔴 Cerrados${status.nextOpen ? ` — abrimos ${status.nextOpen}` : ""}`;

  const greeting = name ? `¡Mucho gusto, *${name}*! ☕ Me da mucho gusto atenderte.` : `¡Bienvenid@ a *${config.name}*! ☕ Me da mucho gusto atenderte.`;
  return (
    `${greeting}\n` +
    `${statusLine}\n\n` +
    `¿Con qué te puedo ayudar hoy?\n\n` +
    `${buildOptionsMenu(config)}\n` +
    `\nO cuéntame tu duda y con gusto te respondo 😊`
  );
}

function buildReturnWelcome(config: RestaurantConfig, name: string): string {
  const status = currentOpenStatus(config);
  const statusLine = status.isOpen
    ? `🟢 Abiertos hasta las ${status.todaySchedule!.close} hrs`
    : `🔴 Cerrados${status.nextOpen ? ` — abrimos ${status.nextOpen}` : ""}`;

  return (
    `¡Bienvenido de regreso, *${name}*! 🎉 Qué gusto verte de nuevo por aquí.\n` +
    `${statusLine}\n\n` +
    `¿En qué te puedo ayudar hoy?\n\n` +
    `${buildOptionsMenu(config)}\n` +
    `\nO cuéntame tu duda y con gusto te respondo 😊`
  );
}

function buildReturnGreeting(config: RestaurantConfig, name?: string): string {
  const status = currentOpenStatus(config);
  const statusLine = status.isOpen
    ? `🟢 Abiertos hasta las ${status.todaySchedule!.close} hrs`
    : `🔴 Cerrados${status.nextOpen ? ` — abrimos ${status.nextOpen}` : ""}`;

  const hi = name ? `¡Hola de nuevo, *${name}*! 😊` : `¡Hola de nuevo! 😊`;
  return (
    `${hi} ${statusLine}\n\n` +
    `¿En qué más te puedo ayudar?\n\n` +
    `${buildOptionsMenu(config)}\n` +
    `\nO cuéntame tu duda 🙌`
  );
}

// ── Comandos globales de navegación ─────────────────────────────────────────
// Captura tanto comandos cortos como frases naturales de "volver al inicio"
const RESET_CMD =
  /^\s*(r|0|regresar?|volver?|inicio|men[uú]|reiniciar|restart|quiero\s+(regresar?|volver?|empezar\s+de\s+nuevo|comenzar\s+de\s+nuevo|ir\s+al\s+(men[uú]|inicio))|ir\s+al\s+(men[uú]|inicio)(\s+principal)?|men[uú]\s+principal|empezar\s+de\s+nuevo|comenzar\s+de\s+nuevo|otra\s+opci[oó]n|cambiar\s+de\s+opci[oó]n|no\s+quiero\s+(esto|eso|nada\s+de\s+esto))\s*[.!?¡¿]*\s*$/i;

const GREETING_WORDS =
  /^\s*(hola|buenos\s+d[íi]as|buenas\s+tardes|buenas\s+noches|buenas|hey|hi|hello|qué\s+tal|que\s+tal|buen[ao]s)\s*[!¡.]*\s*$/i;

function buildContextReminder(
  state: ConversationState,
  config: RestaurantConfig,
): string {
  const back = `\n\nEscribe *R* o *0* para volver al menú principal.`;

  switch (state.status) {
    case "collecting":
    case "confirming": {
      const d = state.data;
      const parts: string[] = ["¡Hola de nuevo! 👋 Tenemos una *reserva en proceso*:"];
      if (d.fecha)    parts.push(`📅 Fecha: ${d.fecha}`);
      if (d.hora)     parts.push(`🕐 Hora: ${d.hora}`);
      if (d.personas) parts.push(`👥 Personas: ${d.personas}`);
      if (d.nombre)   parts.push(`👤 Nombre: ${d.nombre}`);
      parts.push(`\n¿Continuamos? Escribe el dato que falta o dime si cambias algo.`);
      return parts.join("\n") + back;
    }
    case "ordering_preorder_time":
      return (
        `¡Hola de nuevo! 👋 Estábamos apartando un pedido para cuando abramos.\n` +
        `¿A qué hora quieres pasar a recoger?` +
        back
      );
    case "ordering_ask":
    case "ordering_category":
    case "ordering_items":
    case "ordering_link":
    case "ordering_confirm":
    case "ordering_web_name": {
      const items = state.data.order?.items ?? [];
      if (items.length > 0) {
        return (
          `¡Hola de nuevo! 👋 Tenemos un *pedido en proceso*:\n\n` +
          formatOrderSummary(items) +
          `\n\n¿Seguimos? Agrega más productos, escribe *listo* para confirmar,` +
          back
        );
      }
      return (
        `¡Hola de nuevo! 👋 Estábamos eligiendo productos para tu pedido.\n` +
        `¿Continuamos? Dime qué quieres ordenar.` +
        back
      );
    }
    case "cancelling_lookup":
    case "cancelling_confirm":
      return (
        `¡Hola de nuevo! 👋 Estábamos procesando una *cancelación de reserva*.\n` +
        `¿Deseas continuar? Dime tu número de reserva o nombre y fecha.` +
        back
      );
    default:
      return buildReturnGreeting(config, state.data.guestName);
  }
}

const RESERVATION_INTENT =
  /reserv|mesa|lugar|cupo|cena|comer|cenar|apartar|agendar|quiero\s+ir|visitar|quero\s+ir/i;
const ORDER_INTENT =
  /ped(ir|ido)|orden(ar)?|quiero\s+(pedir|comer|tomar|ordenar)|me\s+gustar[íi]a\s+(pedir|ordenar)|qu[eé]\s+tienen|qu[eé]\s+hay|ver\s+el\s+men[uú]/i;
const CATEGORY_NAV =
  /^\s*(categ[oó]r[íi]?as?|ver\s+categ[oó]r[íi]?as?|men[uú]|opciones|volver|regresar)\s*$/i;
const DONE_WORDS =
  /^\s*(listo|ya|eso\s+es\s+todo|nada\s+m[aá]s|es\s+todo|termin[eé]|ya\s+es\s+todo|ok\s+listo|todo|fin)\s*$/i;


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

function uniqueCategories(items: MenuItem[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    if (item.categoria && !seen.has(item.categoria)) {
      seen.add(item.categoria);
      result.push(item.categoria);
    }
  }
  return result;
}

function buildCategoryList(categories: string[], menuWebUrl?: string): string {
  const NUM_EMOJI = ["1️⃣","2️⃣","3️⃣","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣","9️⃣","🔟"];
  const list = categories
    .map((c, i) => `  ${NUM_EMOJI[i] ?? `${i + 1}.`}  ${c}`)
    .join("\n");
  const menuLink = menuWebUrl
    ? `📲 *¿Prefieres elegir desde nuestra página?*\n${menuWebUrl}\n_(Selecciona tus productos y toca "Realizar pedido por WhatsApp" — lo recibo aquí y lo confirmo contigo)_\n\n`
    : "";
  return (
    `¡Con gusto! 😊\n\n` +
    menuLink +
    `O cuéntame aquí qué quieres ordenar (elige una categoría):\n\n` +
    list +
    `\n\n_(Escribe el número de la categoría o el nombre del producto)_`
  );
}

function buildCategoryItemsList(categoria: string, items: MenuItem[]): string {
  if (items.length === 0) {
    return `No hay productos disponibles en *${categoria}* en este momento. 🙏`;
  }
  const list = items.map((item, i) => {
    const extras = item.extras.length ? ` _(extras: ${item.extras.join(", ")})_` : "";
    return `  ${i + 1}. *${item.nombre}* — $${item.precio}${extras}`;
  }).join("\n");
  return (
    `*${categoria}* 🍽️\n\n${list}\n\n` +
    `Escribe el *número* o el *nombre* del producto.\n` +
    `Para ver otras categorías escribe *categorías*. 😊`
  );
}
