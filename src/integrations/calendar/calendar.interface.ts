import type { RestaurantConfig } from "../../config/types.js";

export interface SlotAvailability {
  available: boolean;
  remainingCapacity: number;
}

export interface ICalendarClient {
  checkAvailability(
    date: string,        // YYYY-MM-DD
    time: string,        // HH:MM
    personas: number,
    config: RestaurantConfig,
  ): Promise<SlotAvailability>;

  createReservation(params: {
    config: RestaurantConfig;
    reservationId: string;   // e.g. "#RES-0001"
    nombre: string;
    phone: string;
    fecha: string;
    hora: string;
    personas: number;
    peticiones?: string;
  }): Promise<{ eventId: string }>;

  cancelReservation(eventId: string, calendarId: string): Promise<void>;
}
