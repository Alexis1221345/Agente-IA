import { config } from "dotenv";
import type { RestaurantConfig, DaySchedule } from "./types.js";

// Load .env as early as possible — runs when this module is first imported,
// before any call to loadRestaurantFromEnv().
config();

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;

function parseSchedule(): Record<string, DaySchedule | null> {
  const schedule: Record<string, DaySchedule | null> = {};
  for (const day of DAYS) {
    const raw = process.env[`SCHEDULE_${day.toUpperCase()}`]?.trim();
    if (!raw || raw.toLowerCase() === "closed") {
      schedule[day] = null;
      continue;
    }
    const match = raw.match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
    if (!match) {
      console.warn(`[config] SCHEDULE_${day.toUpperCase()} format invalid ("${raw}") — marking as closed`);
      schedule[day] = null;
    } else {
      schedule[day] = { open: match[1], close: match[2] };
    }
  }
  return schedule;
}

function parseFaq(raw?: string): Record<string, string> {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    console.warn("[config] RESTAURANT_FAQ is invalid JSON — ignoring");
    return {};
  }
}

export function loadRestaurantFromEnv(): RestaurantConfig {
  // Google credentials: inline JSON takes priority over file path
  const credJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON?.trim();
  const credPath = process.env.GOOGLE_CREDENTIALS_PATH?.trim();

  return {
    id: process.env.RESTAURANT_ID ?? "demo",
    name: process.env.RESTAURANT_NAME ?? "Restaurante",
    timezone: process.env.RESTAURANT_TIMEZONE ?? "America/Mexico_City",
    schedule: parseSchedule(),
    slotDurationMinutes: Number(process.env.RESTAURANT_SLOT_DURATION ?? "90"),
    capacityPerSlot: Number(process.env.RESTAURANT_CAPACITY_PER_SLOT ?? "30"),
    bookableQuota: Number(process.env.RESTAURANT_BOOKABLE_QUOTA ?? "0.8"),
    maxAutoGroupSize: Number(process.env.RESTAURANT_MAX_AUTO_GROUP ?? "8"),
    humanPhone: process.env.RESTAURANT_HUMAN_PHONE ?? "",
    calendarId: process.env.GOOGLE_CALENDAR_ID ?? "",
    // GoogleCalendarClient already accepts either an inline JSON string or a file path
    googleCredentialsPath: credJson || credPath,
    cancellationPolicy: process.env.RESTAURANT_CANCELLATION_POLICY ?? "",
    faq: parseFaq(process.env.RESTAURANT_FAQ),
  };
}
