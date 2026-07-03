import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";
import { db } from "../data/db.js";
import { sendWhatsAppMessage } from "../channels/whatsapp.js";
import type { RestaurantConfig } from "../config/types.js";

dayjs.extend(utc);
dayjs.extend(timezone);

// How wide the polling window is — should match the setInterval period
const POLL_WINDOW_MINUTES = 1;

interface ReservationRow {
  id: number;
  phone: string;
  nombre: string;
  fecha: string;
  hora: string;
  personas: number;
}

interface OrderRow {
  id: number;
  phone: string;
  nombre: string | null;
  pickup_time: string;
  created_at: number;
}

/**
 * Starts the proactive reminder scheduler.
 * Fires every minute and sends WhatsApp messages for upcoming reservations and orders.
 *
 * Configurable via env vars:
 *   RESERVATION_REMINDER_MINUTES  (default: 120 = 2 hours before)
 *   ORDER_REMINDER_MINUTES        (default: 5  = 5 minutes before pickup)
 */
export function startReminderScheduler(
  config: RestaurantConfig,
  restaurantId: string,
): void {
  const reservationMinutes = Math.max(
    1,
    Number(process.env.RESERVATION_REMINDER_MINUTES ?? "120"),
  );
  const orderMinutes = Math.max(
    1,
    Number(process.env.ORDER_REMINDER_MINUTES ?? "5"),
  );

  console.log(
    `⏰  Recordatorios activos — ` +
    `reservas: ${reservationMinutes} min antes | ` +
    `pedidos: ${orderMinutes} min antes`,
  );

  setInterval(async () => {
    try {
      await checkReservationReminders(config, restaurantId, reservationMinutes);
    } catch (err) {
      console.error("[reminders] Error en reservas:", err);
    }
    try {
      await checkOrderReminders(config, restaurantId, orderMinutes);
    } catch (err) {
      console.error("[reminders] Error en pedidos:", err);
    }
  }, POLL_WINDOW_MINUTES * 60 * 1000);
}

async function checkReservationReminders(
  config: RestaurantConfig,
  restaurantId: string,
  minutesBefore: number,
): Promise<void> {
  const now = dayjs().tz(config.timezone);

  // Window: alert when the reservation is between (now + minutesBefore) and (now + minutesBefore + POLL_WINDOW)
  const windowStart = now.add(minutesBefore, "minute").format("YYYY-MM-DD HH:mm");
  const windowEnd   = now.add(minutesBefore + POLL_WINDOW_MINUTES, "minute").format("YYYY-MM-DD HH:mm");

  const rows = db
    .prepare(
      `SELECT id, phone, nombre, fecha, hora, personas
       FROM reservations
       WHERE restaurant_id = ?
         AND status = 'confirmed'
         AND reminder_sent = 0
         AND (fecha || ' ' || hora) >= ?
         AND (fecha || ' ' || hora) <  ?`,
    )
    .all(restaurantId, windowStart, windowEnd) as unknown as ReservationRow[];

  for (const row of rows) {
    try {
      const msg = buildReservationReminder(config, row);
      await sendWhatsAppMessage(row.phone, msg, config.phoneNumberId);
      db.prepare("UPDATE reservations SET reminder_sent = 1 WHERE id = ?").run(row.id);
      console.log(`[reminders] Recordatorio de reserva #${row.id} enviado → ${row.phone}`);
    } catch (err) {
      console.error(`[reminders] Error enviando recordatorio de reserva #${row.id}:`, err);
    }
  }
}

async function checkOrderReminders(
  config: RestaurantConfig,
  restaurantId: string,
  minutesBefore: number,
): Promise<void> {
  const now = dayjs().tz(config.timezone);

  // Same window logic for HH:mm — only check orders from the last 24 h to avoid
  // reminding for old pending orders whose pickup time coincidentally falls in the window
  const windowStart = now.add(minutesBefore, "minute").format("HH:mm");
  const windowEnd   = now.add(minutesBefore + POLL_WINDOW_MINUTES, "minute").format("HH:mm");
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;

  const rows = db
    .prepare(
      `SELECT id, phone, nombre, pickup_time, created_at
       FROM orders
       WHERE restaurant_id = ?
         AND status = 'pending'
         AND pickup_time IS NOT NULL
         AND reminder_sent = 0
         AND pickup_time >= ?
         AND pickup_time <  ?
         AND created_at  >= ?`,
    )
    .all(restaurantId, windowStart, windowEnd, cutoff) as unknown as OrderRow[];

  for (const row of rows) {
    try {
      const msg = buildOrderReminder(config, row);
      await sendWhatsAppMessage(row.phone, msg, config.phoneNumberId);
      db.prepare("UPDATE orders SET reminder_sent = 1 WHERE id = ?").run(row.id);
      console.log(`[reminders] Recordatorio de pedido #${row.id} enviado → ${row.phone}`);
    } catch (err) {
      console.error(`[reminders] Error enviando recordatorio de pedido #${row.id}:`, err);
    }
  }
}

function buildReservationReminder(config: RestaurantConfig, row: ReservationRow): string {
  const p = row.personas;
  return (
    `⏰ ¡Hola, *${row.nombre}*! Te recordamos que tienes una reserva en *${config.name}* ` +
    `hoy a las *${row.hora}* para *${p}* ${p === 1 ? "persona" : "personas"}. 😊\n\n` +
    `¡Te esperamos con mucho gusto! Si necesitas hacer algún cambio o cancelar, ` +
    `solo responde a este mensaje y con gusto te ayudamos. ☕`
  );
}

function buildOrderReminder(config: RestaurantConfig, row: OrderRow): string {
  const name = row.nombre ? `, *${row.nombre}*` : "";
  return (
    `🛒 ¡Hola${name}! Tu pedido en *${config.name}* estará listo en unos minutos.\n\n` +
    `¡Ya puedes venir a recogerlo! 😊 Si tienes alguna duda, solo escríbenos aquí.`
  );
}
