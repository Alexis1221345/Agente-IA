import { google } from "googleapis";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";
import type { ICalendarClient, SlotAvailability } from "./calendar.interface.js";
import type { RestaurantConfig } from "../../../shared/config/types.js";

dayjs.extend(utc);
dayjs.extend(timezone);

export class GoogleCalendarClient implements ICalendarClient {
  private calendar: ReturnType<typeof google.calendar>;

  constructor(credentialsOrPath: string) {
    // Accepts either a JSON string or a file path
    let credentials: object;
    if (credentialsOrPath.trim().startsWith("{")) {
      credentials = JSON.parse(credentialsOrPath);
    } else {
      credentials = JSON.parse(readFileSync(resolve(credentialsOrPath), "utf8"));
    }
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/calendar"],
    });
    this.calendar = google.calendar({ version: "v3", auth });
  }

  async checkAvailability(
    date: string,
    time: string,
    personas: number,
    config: RestaurantConfig,
  ): Promise<SlotAvailability> {
    const slotStart = dayjs.tz(`${date}T${time}`, config.timezone);
    const slotEnd = slotStart.add(config.slotDurationMinutes, "minute");

    const res = await this.calendar.events.list({
      calendarId: config.calendarId,
      timeMin: slotStart.toISOString(),
      timeMax: slotEnd.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
    });

    const events = res.data.items ?? [];

    // Sum booked covers from our events (stored in extendedProperties)
    let booked = 0;
    for (const event of events) {
      const p = event.extendedProperties?.private?.["personas"];
      if (p) booked += parseInt(p, 10);
    }

    const totalBookable = Math.floor(config.capacityPerSlot * config.bookableQuota);
    const remaining = totalBookable - booked;

    return {
      available: remaining >= personas,
      remainingCapacity: Math.max(0, remaining),
    };
  }

  async createReservation(params: {
    config: RestaurantConfig;
    reservationId: string;
    nombre: string;
    phone: string;
    fecha: string;
    hora: string;
    personas: number;
    peticiones?: string;
  }): Promise<{ eventId: string }> {
    const { config, reservationId, nombre, phone, fecha, hora, personas, peticiones } = params;
    const start = dayjs.tz(`${fecha}T${hora}`, config.timezone);
    const end = start.add(config.slotDurationMinutes, "minute");

    const description = [
      `ID Reserva: ${reservationId}`,
      `Nombre: ${nombre}`,
      `Personas: ${personas}`,
      `Teléfono: ${phone}`,
      peticiones ? `Peticiones: ${peticiones}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    const res = await this.calendar.events.insert({
      calendarId: config.calendarId,
      requestBody: {
        summary: `${reservationId} — ${nombre} ×${personas}`,
        description,
        start: { dateTime: start.toISOString(), timeZone: config.timezone },
        end: { dateTime: end.toISOString(), timeZone: config.timezone },
        extendedProperties: {
          private: {
            personas: String(personas),
            phone,
            restaurantId: config.id,
          },
        },
      },
    });

    return { eventId: res.data.id! };
  }

  async cancelReservation(eventId: string, calendarId: string): Promise<void> {
    await this.calendar.events.patch({
      calendarId,
      eventId,
      requestBody: { status: "cancelled" },
    });
  }
}
