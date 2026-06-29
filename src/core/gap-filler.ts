import type { ReservationData, ReservationField } from "../business/reservation.js";
import type { RestaurantConfig } from "../config/types.js";

export type NextAction =
  | { type: "ask"; field: ReservationField; question: string }
  | { type: "check_availability" }
  | { type: "confirm"; summary: string }
  | { type: "escalate"; reason: string };

/**
 * Pure function — given current state, returns what to do next.
 * No LLM calls here. No side effects.
 */
export function nextAction(
  data: ReservationData,
  config: RestaurantConfig,
): NextAction {
  // Escalate immediately if group is too large
  if (data.personas !== undefined && data.personas > config.maxAutoGroupSize) {
    return {
      type: "escalate",
      reason: `grupo de ${data.personas} personas`,
    };
  }

  if (!data.fecha) {
    return {
      type: "ask",
      field: "fecha",
      question: "¡Con gusto! ¿Para qué día lo quieres?",
    };
  }

  if (!data.hora) {
    return {
      type: "ask",
      field: "hora",
      question: "¡Va! ¿Y como a qué hora se te antoja llegar?",
    };
  }

  if (data.personas === undefined) {
    return {
      type: "ask",
      field: "personas",
      question: "Perfecto. ¿Para cuántas personas preparo el lugar?",
    };
  }

  // All three scheduling fields collected → check availability before asking name
  if (!data.nombre) {
    // We'll check availability in the agent (needs async), so signal that
    return { type: "check_availability" };
  }

  // Name collected, peticiones is optional — go straight to confirm
  return {
    type: "confirm",
    summary: buildSummary(data, config),
  };
}

export function buildSummary(data: ReservationData, config: RestaurantConfig): string {
  const lines = [
    `Listo, te lo anoto así:`,
    ``,
    `📅 ${formatDate(data.fecha!)} a las ${data.hora}`,
    `👥 ${data.personas} personas — *${data.nombre}*`,
  ];
  if (data.peticiones) lines.push(`✨ ${data.peticiones}`);
  lines.push("", "¿Te la dejo así o ajustamos algo?");
  return lines.join("\n");
}

function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  const months = [
    "", "enero", "febrero", "marzo", "abril", "mayo", "junio",
    "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
  ];
  return `${parseInt(d)} de ${months[parseInt(m)]} de ${y}`;
}
