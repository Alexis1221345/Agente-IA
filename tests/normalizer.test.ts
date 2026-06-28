import { describe, it, expect } from "vitest";
import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";
import { normalizeDate, normalizeTime } from "../src/business/normalizer.js";

dayjs.extend(utc);
dayjs.extend(timezone);

const TZ = "America/Mexico_City";

// Anchor "now" to a known Wednesday: 2025-06-25
const NOW = dayjs.tz("2025-06-25", TZ);

describe("normalizeDate", () => {
  it("resolves 'hoy'", () => {
    expect(normalizeDate("hoy", TZ, NOW)).toBe("2025-06-25");
  });

  it("resolves 'mañana'", () => {
    expect(normalizeDate("mañana", TZ, NOW)).toBe("2025-06-26");
  });

  it("resolves 'manana' (sin ñ)", () => {
    expect(normalizeDate("manana", TZ, NOW)).toBe("2025-06-26");
  });

  it("resolves 'pasado mañana'", () => {
    expect(normalizeDate("pasado mañana", TZ, NOW)).toBe("2025-06-27");
  });

  it("resolves 'pasado manana' (sin ñ)", () => {
    expect(normalizeDate("pasado manana", TZ, NOW)).toBe("2025-06-27");
  });

  it("resolves 'el viernes' (next Friday from Wednesday)", () => {
    expect(normalizeDate("el viernes", TZ, NOW)).toBe("2025-06-27");
  });

  it("resolves bare 'viernes' (without 'el')", () => {
    expect(normalizeDate("viernes", TZ, NOW)).toBe("2025-06-27");
  });

  it("resolves 'el sábado'", () => {
    expect(normalizeDate("el sábado", TZ, NOW)).toBe("2025-06-28");
  });

  it("resolves bare 'sabado' (sin acento)", () => {
    expect(normalizeDate("sabado", TZ, NOW)).toBe("2025-06-28");
  });

  it("resolves bare 'domingo' (Sunday from Wednesday)", () => {
    // Wednesday June 25 → next Sunday June 29
    expect(normalizeDate("domingo", TZ, NOW)).toBe("2025-06-29");
  });

  it("resolves 'el próximo lunes' (skips to next week)", () => {
    expect(normalizeDate("el próximo lunes", TZ, NOW)).toBe("2025-06-30");
  });

  it("resolves 'miercoles' (sin acento, from Wednesday → next week)", () => {
    expect(normalizeDate("miercoles", TZ, NOW)).toBe("2025-07-02");
  });

  it("resolves '25 de julio'", () => {
    expect(normalizeDate("25 de julio", TZ, NOW)).toBe("2025-07-25");
  });

  it("resolves '25 jul' (abbreviated month)", () => {
    expect(normalizeDate("25 jul", TZ, NOW)).toBe("2025-07-25");
  });

  it("resolves '25 ene' (abbreviated month, past → next year)", () => {
    expect(normalizeDate("25 ene", TZ, NOW)).toBe("2026-01-25");
  });

  it("resolves '25 de junio de 2026'", () => {
    expect(normalizeDate("25 de junio de 2026", TZ, NOW)).toBe("2026-06-25");
  });

  it("resolves '25 julio 2026' (no 'de')", () => {
    expect(normalizeDate("25 julio 2026", TZ, NOW)).toBe("2026-07-25");
  });

  it("resolves ISO format", () => {
    expect(normalizeDate("2025-09-15", TZ, NOW)).toBe("2025-09-15");
  });

  it("resolves DD/MM/YYYY slash format", () => {
    expect(normalizeDate("25/09/2025", TZ, NOW)).toBe("2025-09-25");
  });

  it("resolves DD-MM-YYYY dash format", () => {
    expect(normalizeDate("25-09-2025", TZ, NOW)).toBe("2025-09-25");
  });

  it("resolves DD/MM short without year (future)", () => {
    expect(normalizeDate("28/06", TZ, NOW)).toBe("2025-06-28");
  });

  it("resolves DD-MM short without year (future)", () => {
    expect(normalizeDate("28-06", TZ, NOW)).toBe("2025-06-28");
  });

  it("returns null for garbage", () => {
    expect(normalizeDate("blablabla", TZ, NOW)).toBeNull();
  });

  it("returns null for a pure number", () => {
    expect(normalizeDate("3", TZ, NOW)).toBeNull();
  });
});

describe("normalizeTime", () => {
  it("resolves '8 pm'", () => {
    expect(normalizeTime("8 pm")).toBe("20:00");
  });

  it("resolves 'a las 8' (assumes PM in restaurant context)", () => {
    expect(normalizeTime("a las 8")).toBe("20:00");
  });

  it("resolves '8:30 pm'", () => {
    expect(normalizeTime("8:30 pm")).toBe("20:30");
  });

  it("resolves '20:00'", () => {
    expect(normalizeTime("20:00")).toBe("20:00");
  });

  it("resolves '1 pm'", () => {
    expect(normalizeTime("1 pm")).toBe("13:00");
  });

  it("resolves 'a las 9 de la noche'", () => {
    expect(normalizeTime("a las 9 de la noche")).toBe("21:00");
  });

  it("resolves '7 de la tarde'", () => {
    expect(normalizeTime("7 de la tarde")).toBe("19:00");
  });

  it("resolves '3 de la tarde'", () => {
    expect(normalizeTime("3 de la tarde")).toBe("15:00");
  });

  it("resolves '12 pm' (noon)", () => {
    expect(normalizeTime("12 pm")).toBe("12:00");
  });

  it("resolves 'a las 8 de la manana' (sin ñ) as AM", () => {
    expect(normalizeTime("a las 8 de la manana")).toBe("08:00");
  });

  it("resolves 'mediodía'", () => {
    expect(normalizeTime("mediodía")).toBe("12:00");
  });

  it("resolves 'mediodia' (sin acento)", () => {
    expect(normalizeTime("mediodia")).toBe("12:00");
  });

  it("resolves '13h'", () => {
    expect(normalizeTime("13h")).toBe("13:00");
  });

  it("resolves '8hrs'", () => {
    expect(normalizeTime("8hrs")).toBe("20:00");
  });

  it("returns null for garbage", () => {
    expect(normalizeTime("xyzzy")).toBeNull();
  });
});
