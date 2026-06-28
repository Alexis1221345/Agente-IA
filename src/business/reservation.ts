import type { OrderData } from "./order.js";

export type ReservationStatus =
  | "greeting"            // first contact — showing welcome + options
  | "collecting"          // gathering reservation fields
  | "confirming"          // showing summary, waiting for explicit "sí"
  | "confirmed"           // written to calendar
  | "escalated"           // handed off to human
  | "cancelled"           // reservation cancelled
  | "cancelling_lookup"   // waiting for ID or name+date to find reservation
  | "cancelling_confirm"  // found reservation, waiting for cancel confirmation
  | "ordering_link"       // sent menu link, waiting for first item
  | "ordering_items"      // collecting order items
  | "ordering_confirm";   // showing order summary, waiting for confirmation

export interface ReservationData {
  fecha?: string;      // YYYY-MM-DD
  hora?: string;       // HH:MM (24h)
  personas?: number;
  nombre?: string;
  peticiones?: string; // optional special requests
  order?: OrderData;   // active order being built
}

export type ReservationField = keyof ReservationData;

export const REQUIRED_FIELDS: ReservationField[] = [
  "fecha",
  "hora",
  "personas",
  "nombre",
];

export const FIELD_ORDER: ReservationField[] = [
  "fecha",
  "hora",
  "personas",
  "nombre",
  "peticiones",
];

export function isComplete(data: ReservationData): boolean {
  return REQUIRED_FIELDS.every((f) => data[f] !== undefined);
}
