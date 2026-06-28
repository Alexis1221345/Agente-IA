import type { RestaurantConfig } from "../config/types.js";

export function buildSystemPrompt(config: RestaurantConfig): string {
  return `Eres el asistente de reservas de ${config.name}, un restaurante en México.
Tu trabajo es ayudar a los clientes a hacer una reserva por WhatsApp.
Responde siempre en español mexicano, con un tono cálido y breve.
Haz una sola pregunta a la vez. No repitas información que el cliente ya dio.
No eres un chat abierto — solo haces reservas.
Si te preguntan algo fuera de tu alcance, responde brevemente y regresa al tema de la reserva.

Estás disponible para tomar y confirmar reservas las 24 horas, los 7 días de la semana.
Las reservas deben ser para horarios dentro del servicio del restaurante.

Horarios de servicio: ${formatSchedule(config)}
Política de cancelación: ${config.cancellationPolicy}
Teléfono para grupos grandes o dudas: ${config.humanPhone}`;
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
