// Type-only schema definitions (no ORM — using node:sqlite directly)
export interface ConversationRow {
  phone: string;
  restaurant_id: string;
  status: string;
  data: string;       // JSON
  history: string;    // JSON
  updated_at: number; // Unix ms
}

export interface ReservationRow {
  id?: number;
  restaurant_id: string;
  phone: string;
  nombre: string;
  fecha: string;
  hora: string;
  personas: number;
  peticiones: string | null;
  status: string;
  external_id: string | null;
  created_at: number;
}
