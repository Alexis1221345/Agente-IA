import { db } from "./db.js";
import type { ReservationData, ReservationStatus } from "../business/reservation.js";

export interface Message {
  role: "user" | "assistant";
  content: string;
}

export interface ConversationState {
  phone: string;
  restaurantId: string;
  status: ReservationStatus;
  data: ReservationData;
  history: Message[];
}

export interface ReservationRecord {
  id: number;
  restaurantId: string;
  phone: string;
  nombre: string;
  fecha: string;   // YYYY-MM-DD
  hora: string;    // HH:MM
  personas: number;
  peticiones: string | null;
  status: string;
}

/** Format numeric DB id as human-friendly reservation code */
export function formatResId(id: number): string {
  return `#RES-${String(id).padStart(4, "0")}`;
}

/** Parse "#RES-0042" or "RES-42" or "42" → numeric id, or null */
export function parseResId(text: string): number | null {
  const m = text.trim().match(/(?:#?RES-)?(\d+)/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return isNaN(n) ? null : n;
}

export function loadConversation(
  phone: string,
  restaurantId: string,
): ConversationState {
  const row = db
    .prepare("SELECT * FROM conversations WHERE phone = ?")
    .get(phone) as Record<string, unknown> | undefined;

  if (!row) {
    return { phone, restaurantId, status: "collecting", data: {}, history: [] };
  }

  return {
    phone: row.phone as string,
    restaurantId: row.restaurant_id as string,
    status: row.status as ReservationStatus,
    data: JSON.parse(row.data as string) as ReservationData,
    history: JSON.parse(row.history as string) as Message[],
  };
}

export function saveConversation(state: ConversationState): void {
  const now = Date.now();
  db.prepare(`
    INSERT INTO conversations (phone, restaurant_id, status, data, history, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(phone) DO UPDATE SET
      status     = excluded.status,
      data       = excluded.data,
      history    = excluded.history,
      updated_at = excluded.updated_at
  `).run(
    state.phone,
    state.restaurantId,
    state.status,
    JSON.stringify(state.data),
    JSON.stringify(state.history),
    now,
  );
}

/** Save reservation and return its generated ID */
export function saveReservation(state: ConversationState, externalId?: string): number {
  const d = state.data;
  const result = db.prepare(`
    INSERT INTO reservations
      (restaurant_id, phone, nombre, fecha, hora, personas, peticiones, status, external_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?)
  `).run(
    state.restaurantId,
    state.phone,
    d.nombre!,
    d.fecha!,
    d.hora!,
    d.personas!,
    d.peticiones ?? null,
    externalId ?? null,
    Date.now(),
  );
  return Number(result.lastInsertRowid);
}

/** Cancel reservation by ID and return its Google Calendar event ID if any */
export function cancelReservationById(id: number): string | null {
  const row = db
    .prepare("SELECT external_id FROM reservations WHERE id = ?")
    .get(id) as { external_id: string | null } | undefined;
  db.prepare("UPDATE reservations SET status = 'cancelled' WHERE id = ?").run(id);
  return row?.external_id ?? null;
}

export function findReservationById(
  id: number,
  restaurantId: string,
): ReservationRecord | null {
  const row = db
    .prepare("SELECT * FROM reservations WHERE id = ? AND restaurant_id = ? AND status = 'confirmed'")
    .get(id, restaurantId) as Record<string, unknown> | undefined;
  return row ? toRecord(row) : null;
}

export function findReservationByNameAndDate(
  nombre: string,
  fecha: string,        // YYYY-MM-DD
  restaurantId: string,
): ReservationRecord[] {
  const rows = db
    .prepare(`
      SELECT * FROM reservations
      WHERE restaurant_id = ?
        AND lower(nombre) LIKE lower(?)
        AND fecha = ?
        AND status = 'confirmed'
      ORDER BY created_at DESC
    `)
    .all(restaurantId, `%${nombre}%`, fecha) as Record<string, unknown>[];
  return rows.map(toRecord);
}

export function updateReservationExternalId(id: number, externalId: string): void {
  db.prepare("UPDATE reservations SET external_id = ? WHERE id = ?").run(externalId, id);
}

export function resetConversation(phone: string): void {
  db.prepare("DELETE FROM conversations WHERE phone = ?").run(phone);
}

function toRecord(row: Record<string, unknown>): ReservationRecord {
  return {
    id: row.id as number,
    restaurantId: row.restaurant_id as string,
    phone: row.phone as string,
    nombre: row.nombre as string,
    fecha: row.fecha as string,
    hora: row.hora as string,
    personas: row.personas as number,
    peticiones: row.peticiones as string | null,
    status: row.status as string,
  };
}
