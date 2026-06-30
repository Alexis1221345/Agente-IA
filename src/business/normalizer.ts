import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";
import customParseFormat from "dayjs/plugin/customParseFormat.js";
import isSameOrBefore from "dayjs/plugin/isSameOrBefore.js";

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);
dayjs.extend(isSameOrBefore);

// Common misspellings and accent-less variants included
const DAYS_ES: Record<string, number> = {
  domingo: 0, domigo: 0,
  lunes: 1,
  martes: 2,
  miércoles: 3, miercoles: 3, mircoles: 3,
  jueves: 4,
  viernes: 5, biernes: 5,
  sábado: 6, sabado: 6, savado: 6,
};

const MONTHS: Record<string, number> = {
  enero: 1,   ene: 1,
  febrero: 2, feb: 2,
  marzo: 3,   mar: 3,
  abril: 4,   abr: 4,
  mayo: 5,    may: 5,
  junio: 6,   jun: 6,
  julio: 7,   jul: 7,
  agosto: 8,  ago: 8,
  septiembre: 9, setiembre: 9, sep: 9,
  octubre: 10,   oct: 10,
  noviembre: 11, nov: 11,
  diciembre: 12, dic: 12,
};

/**
 * Resolves a natural-language date string to YYYY-MM-DD.
 * All relative expressions are anchored to `now` in the restaurant's timezone.
 * Returns null if the input cannot be resolved.
 */
export function normalizeDate(
  input: string,
  tz: string,
  now?: dayjs.Dayjs,
): string | null {
  const base = (now ?? dayjs()).tz(tz).startOf("day");
  const clean = input.trim().toLowerCase();

  if (clean === "hoy") return base.format("YYYY-MM-DD");
  if (clean === "mañana" || clean === "manana")
    return base.add(1, "day").format("YYYY-MM-DD");
  if (clean === "pasado mañana" || clean === "pasado manana")
    return base.add(2, "day").format("YYYY-MM-DD");

  // Relative keywords embedded in phrases like "para mañana", "el dia de mañana"
  if (/\bpasado\s+ma[nñ]ana\b/.test(clean))
    return base.add(2, "day").format("YYYY-MM-DD");
  if (/\bma[nñ]ana\b/.test(clean)) {
    // "de la mañana" / "por la mañana" means "morning" (time period), not "tomorrow"
    const withoutMorning = clean.replace(/\b(?:de|por)\s+la\s+ma[nñ]ana\b/g, "");
    if (/\bma[nñ]ana\b/.test(withoutMorning))
      return base.add(1, "day").format("YYYY-MM-DD");
  }
  if (/\bhoy\b/.test(clean))
    return base.format("YYYY-MM-DD");

  // Day names: bare "domingo", "el viernes", "este sábado", "el próximo martes",
  // "el sábado de la siguiente semana", "el sábado de la próxima semana"
  const dayMatch = clean.match(
    /(?:el\s+|este\s+|el\s+(?:próximo|proximo)\s+)?([a-záéíóúñü]+)(?:\s+de\s+la\s+(?:siguiente|próxima|proxima)\s+semana)?$/,
  );
  if (dayMatch) {
    const dayName = dayMatch[1];
    const target = DAYS_ES[dayName];
    if (target !== undefined) {
      const isNext =
        clean.includes("próximo") ||
        clean.includes("proximo") ||
        clean.includes("siguiente") ||
        clean.includes("próxima") ||
        clean.includes("proxima");
      let diff = target - base.day();
      if (diff <= 0 || isNext) diff += 7;
      return base.add(diff, "day").format("YYYY-MM-DD");
    }
  }

  // Spanish date: "25 de julio", "25 julio", "25 de jul 2026", "25 jul 2026"
  const spanishDate = clean.match(
    /(\d{1,2})\s+(?:de\s+)?([a-záéíóú]+?)(?:\s+(?:de\s+)?(\d{4}))?$/,
  );
  if (spanishDate) {
    const day = parseInt(spanishDate[1], 10);
    const month = MONTHS[spanishDate[2]];
    const hasYear = !!spanishDate[3];
    const year = hasYear ? parseInt(spanishDate[3], 10) : base.year();
    if (month && day >= 1 && day <= 31) {
      const d = dayjs.tz(
        `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
        tz,
      );
      if (d.isValid()) {
        if (!hasYear && d.isSameOrBefore(base)) return d.add(1, "year").format("YYYY-MM-DD");
        return d.format("YYYY-MM-DD");
      }
    }
  }

  // Numeric formats: "25/09/2025", "25-09-2025", "28/06", "28-06"
  // Parse manually to avoid customParseFormat + dayjs.tz compatibility issues.
  const numDate = clean.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?$/);
  if (numDate) {
    const dd = numDate[1].padStart(2, "0");
    const mm = numDate[2].padStart(2, "0");
    const yearRaw = numDate[3];
    const yyyy = yearRaw
      ? (yearRaw.length === 2 ? `20${yearRaw}` : yearRaw)
      : String(base.year());
    const d = dayjs.tz(`${yyyy}-${mm}-${dd}`, tz);
    if (d.isValid()) {
      if (!yearRaw && d.isSameOrBefore(base)) return d.add(1, "year").format("YYYY-MM-DD");
      return d.format("YYYY-MM-DD");
    }
  }

  // ISO format YYYY-MM-DD
  try {
    const iso = dayjs.tz(clean, tz);
    // dayjs.tz(clean, tz) only works for ISO strings — validate with strict regex
    if (/^\d{4}-\d{2}-\d{2}$/.test(clean) && iso.isValid()) return iso.format("YYYY-MM-DD");
  } catch {
    // dayjs.tz can throw on invalid strings
  }

  return null;
}

/**
 * Resolves a natural-language time string to HH:MM (24h).
 * Returns null if the input cannot be resolved.
 */
export function normalizeTime(input: string): string | null {
  const clean = input.trim().toLowerCase().replace(/\s+/g, " ");

  // "mediodía" / "mediodia" / "al mediodía"
  if (/medio\s*d[ií]a/.test(clean)) return "12:00";

  // Accept "manana" (no ñ) as alias of "mañana"
  const normalized = clean.replace(/\bmanana\b/g, "mañana");

  // "a las 8", "a las 8 pm", "8:30", "20:00", "8 de la noche", "7 de la tarde", "8h", "8hrs"
  const withPeriod = normalized.match(
    /(\d{1,2})(?::(\d{2}))?\s*(?:h(?:rs?)?)?\s*(?:de\s+la\s+)?(mañana|tarde|noche|madrugada|am|pm)?/,
  );
  if (!withPeriod || !withPeriod[1]) return null;

  let hour = parseInt(withPeriod[1], 10);
  const minute = withPeriod[2] ? parseInt(withPeriod[2], 10) : 0;
  const period = withPeriod[3];

  if (period === "pm" || period === "tarde" || period === "noche") {
    if (hour < 12) hour += 12;
  } else if (period === "am" || period === "mañana" || period === "madrugada") {
    if (hour === 12) hour = 0;
  } else if (hour < 12) {
    // No explicit period: hours 1-6 → assume PM (afternoon visits), hours 7-11 → AM (morning service)
    if (hour <= 6) hour += 12;
  }

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}
