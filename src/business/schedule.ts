import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";
import type { RestaurantConfig } from "../config/types.js";

dayjs.extend(utc);
dayjs.extend(timezone);

const DOW_KEY: Record<number, string> = {
  0: "sunday", 1: "monday", 2: "tuesday", 3: "wednesday",
  4: "thursday", 5: "friday", 6: "saturday",
};

export interface OpenStatus {
  isOpen: boolean;
  todaySchedule: { open: string; close: string } | null;
  nextOpen: string | null; // human-readable, e.g. "mañana de 7:00 a 13:00"
}

export function currentOpenStatus(config: RestaurantConfig, now?: dayjs.Dayjs): OpenStatus {
  const base = (now ?? dayjs()).tz(config.timezone);
  const dowKey = DOW_KEY[base.day()];
  const todaySchedule = config.schedule[dowKey] ?? null;

  if (!todaySchedule) {
    return { isOpen: false, todaySchedule: null, nextOpen: _nextOpenDay(config, base) };
  }

  const [oh, om] = todaySchedule.open.split(":").map(Number);
  const [ch, cm] = todaySchedule.close.split(":").map(Number);
  const nowMin = base.hour() * 60 + base.minute();
  const openMin = oh * 60 + om;
  const closeMin = ch * 60 + cm;

  if (nowMin >= openMin && nowMin < closeMin) {
    return { isOpen: true, todaySchedule, nextOpen: null };
  }

  return {
    isOpen: false,
    todaySchedule,
    nextOpen: nowMin < openMin
      ? `hoy a partir de las ${todaySchedule.open}`
      : _nextOpenDay(config, base),
  };
}

const ES_DAYS: Record<string, string> = {
  monday: "Lunes", tuesday: "Martes", wednesday: "Miércoles",
  thursday: "Jueves", friday: "Viernes", saturday: "Sábado", sunday: "Domingo",
};

function _nextOpenDay(config: RestaurantConfig, base: dayjs.Dayjs): string {
  for (let i = 1; i <= 7; i++) {
    const next = base.add(i, "day");
    const key = DOW_KEY[next.day()];
    const s = config.schedule[key];
    if (s) {
      const label = i === 1 ? "mañana" : ES_DAYS[key]?.toLowerCase() ?? key;
      return `${label} de ${s.open} a ${s.close}`;
    }
  }
  return "próximamente";
}
