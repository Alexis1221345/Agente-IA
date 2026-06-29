import { describe, it, expect } from "vitest";
import { buildSystemPrompt, formatSchedule } from "../src/core/prompts.js";
import { isQuestion } from "../src/core/qa-helpers.js";
import type { RestaurantConfig } from "../src/config/types.js";

const CAFETERIA: RestaurantConfig = {
  id: "test",
  name: "Café del Bosque",
  timezone: "America/Mexico_City",
  schedule: {
    monday: null,
    tuesday: { open: "07:00", close: "16:00" },
    wednesday: { open: "07:00", close: "16:00" },
    thursday: { open: "07:00", close: "16:00" },
    friday: { open: "07:00", close: "16:00" },
    saturday: { open: "07:00", close: "16:00" },
    sunday: { open: "07:00", close: "16:00" },
  },
  slotDurationMinutes: 90,
  capacityPerSlot: 20,
  bookableQuota: 0.8,
  maxAutoGroupSize: 8,
  humanPhone: "+52 55 1234 5678",
  calendarId: "test@example.com",
  cancellationPolicy: "Cancela sin costo hasta 2h antes.",
  faq: {
    "mascotas|perros|animales": "Lo sentimos, no permitimos mascotas.",
    "niños|bebés|silla": "Con gusto te preparamos una silla para bebé.",
  },
  sheetsId: undefined,
  menuWebUrl: undefined,
};

describe("buildSystemPrompt — grounding", () => {
  it("includes FAQ entries in the prompt", () => {
    const prompt = buildSystemPrompt(CAFETERIA);
    expect(prompt).toContain("mascotas");
    expect(prompt).toContain("Lo sentimos, no permitimos mascotas.");
    expect(prompt).toContain("silla para bebé");
  });

  it("includes schedule in the prompt", () => {
    const prompt = buildSystemPrompt(CAFETERIA);
    expect(prompt).toContain("07:00");
    expect(prompt).toContain("16:00");
    expect(prompt).toContain("Lunes: Cerrado");
  });

  it("mentions humanPhone ONLY in the escalation-rules section, not in general info", () => {
    const prompt = buildSystemPrompt(CAFETERIA);
    // The phone should appear exactly once — in the escalation section
    const occurrences = (prompt.match(/\+52 55 1234 5678/g) ?? []).length;
    expect(occurrences).toBe(1);
    // And it must be inside a context that describes escalation conditions
    const phoneIdx = prompt.indexOf("+52 55 1234 5678");
    const preceding = prompt.slice(Math.max(0, phoneIdx - 200), phoneIdx);
    expect(preceding.toLowerCase()).toMatch(/solo|cuándo|solo en estos/i);
  });

  it("contains the anti-invention rule", () => {
    const prompt = buildSystemPrompt(CAFETERIA);
    expect(prompt).toMatch(/no\s+lo\s+inventes|no inventes|anti.invenci[oó]n/i);
  });

  it("offers to confirm unknown data instead of inventing", () => {
    const prompt = buildSystemPrompt(CAFETERIA);
    expect(prompt).toMatch(/d[eé]jame confirmarlo|ofrece confirmarlo/i);
  });
});

describe("isQuestion — pattern detection", () => {
  it("detects explicit question marks", () => {
    expect(isQuestion("¿tienen wifi?")).toBe(true);
    expect(isQuestion("tienen estacionamiento?")).toBe(true);
  });

  it("detects question-starting words without punctuation", () => {
    expect(isQuestion("dónde están")).toBe(true);
    expect(isQuestion("cuánto cuesta un café")).toBe(true);
    expect(isQuestion("a qué hora abren")).toBe(true);
    expect(isQuestion("qué tienen de desayuno")).toBe(true);
    expect(isQuestion("tienen opciones veganas")).toBe(true);
  });

  it("does not flag reservation field answers as questions", () => {
    expect(isQuestion("el sábado")).toBe(false);
    expect(isQuestion("para 3 personas")).toBe(false);
    expect(isQuestion("a las 9")).toBe(false);
    expect(isQuestion("Juan García")).toBe(false);
    expect(isQuestion("ninguna")).toBe(false);
  });
});

describe("formatSchedule", () => {
  it("formats open days with hours", () => {
    const result = formatSchedule(CAFETERIA);
    expect(result).toContain("Martes: 07:00–16:00");
    expect(result).toContain("Lunes: Cerrado");
  });
});
