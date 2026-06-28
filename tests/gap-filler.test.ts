import { describe, it, expect } from "vitest";
import { nextAction } from "../src/core/gap-filler.js";
import { DEMO_RESTAURANT } from "../src/config/demo.js";
import type { ReservationData } from "../src/business/reservation.js";

const cfg = DEMO_RESTAURANT;

describe("nextAction — gap filling", () => {
  it("asks for fecha when nothing is given", () => {
    const action = nextAction({}, cfg);
    expect(action.type).toBe("ask");
    if (action.type === "ask") expect(action.field).toBe("fecha");
  });

  it("asks for hora when only fecha is present", () => {
    const action = nextAction({ fecha: "2025-07-04" }, cfg);
    expect(action.type).toBe("ask");
    if (action.type === "ask") expect(action.field).toBe("hora");
  });

  it("asks for personas when fecha + hora are present", () => {
    const action = nextAction({ fecha: "2025-07-04", hora: "20:00" }, cfg);
    expect(action.type).toBe("ask");
    if (action.type === "ask") expect(action.field).toBe("personas");
  });

  it("checks availability when fecha + hora + personas are collected", () => {
    const action = nextAction(
      { fecha: "2025-07-04", hora: "20:00", personas: 3 },
      cfg,
    );
    expect(action.type).toBe("check_availability");
  });

  it("escalates when group exceeds maxAutoGroupSize", () => {
    const action = nextAction({ personas: 15 }, cfg);
    expect(action.type).toBe("escalate");
  });

  it("goes to confirm when all required fields are present", () => {
    const data: ReservationData = {
      fecha: "2025-07-04",
      hora: "20:00",
      personas: 4,
      nombre: "Sofía",
    };
    const action = nextAction(data, cfg);
    expect(action.type).toBe("confirm");
  });

  it("confirm summary contains key info", () => {
    const data: ReservationData = {
      fecha: "2025-07-04",
      hora: "20:00",
      personas: 4,
      nombre: "Sofía",
      peticiones: "mesa junto a la ventana",
    };
    const action = nextAction(data, cfg);
    expect(action.type).toBe("confirm");
    if (action.type === "confirm") {
      expect(action.summary).toContain("Sofía");
      expect(action.summary).toContain("20:00");
      expect(action.summary).toContain("4");
      expect(action.summary).toContain("mesa junto a la ventana");
    }
  });
});
