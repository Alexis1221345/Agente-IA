import type { RestaurantConfig } from "../config/types.js";

export function buildSystemPrompt(config: RestaurantConfig, menuText?: string): string {
  const capabilities = [
    "hacer reservas",
    "cancelar reservas",
    ...(config.sheetsId ? ["tomar pedidos del menú"] : []),
  ].join(", ");

  const menuSection = menuText
    ? `\n\nMENÚ DISPONIBLE (úsalo para validar pedidos y responder preguntas):\n${menuText}`
    : "";

  return `Eres el asistente de ${config.name}, una cafetería en México.
Tu trabajo es ayudar a los clientes con: ${capabilities}.
Responde siempre en español mexicano, con un tono cálido y breve.
Haz una sola pregunta a la vez. No repitas información que el cliente ya dio.
Si te preguntan algo fuera de tu alcance, responde brevemente y regresa al tema.

Estás disponible las 24 horas, los 7 días de la semana.
Las reservas deben ser para horarios dentro del servicio.

Horarios de servicio: ${formatSchedule(config)}
Política de cancelación: ${config.cancellationPolicy}
Teléfono para grupos grandes o dudas: ${config.humanPhone}${menuSection}`;
}

function formatSchedule(config: RestaurantConfig): string {
  const days: Record<string, string> = {
    monday: "Lunes", tuesday: "Martes", wednesday: "Miércoles",
    thursday: "Jueves", friday: "Viernes", saturday: "Sábado", sunday: "Domingo",
  };
  return Object.entries(config.schedule)
    .map(([day, s]) =>
      s ? `${days[day]}: ${s.open}–${s.close}` : `${days[day]}: Cerrado`,
    )
    .join(", ");
}
