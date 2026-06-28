#!/usr/bin/env tsx
import readline from "readline";
import { config } from "dotenv";
config();

import { ReservationAgent } from "../core/agent.js";
import { ClaudeLLMClient } from "../integrations/llm/claude.js";
import { restaurantRegistry } from "../config/demo.js";
import { resetConversation } from "../data/conversation-repo.js";

const RESTAURANT_ID = process.env.RESTAURANT_ID ?? "demo";
const PHONE = process.env.SIM_PHONE ?? "+52550000001";
// Always start fresh unless --no-reset is explicitly passed
const RESET = !process.argv.includes("--no-reset");

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("Falta ANTHROPIC_API_KEY en .env");
    process.exit(1);
  }

  const cfg = restaurantRegistry[RESTAURANT_ID];
  if (!cfg) {
    console.error(`Restaurante desconocido: ${RESTAURANT_ID}`);
    process.exit(1);
  }

  if (RESET) {
    resetConversation(PHONE);
    console.log("[conversación reiniciada]");
  }

  const agent = new ReservationAgent(new ClaudeLLMClient(apiKey), restaurantRegistry);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "\nTú: ",
  });

  console.log("=".repeat(60));
  console.log(`Simulación CLI — Restaurante: ${cfg.name}`);
  console.log(`Teléfono simulado: ${PHONE}`);
  console.log(`Calendario: ${cfg.calendarId}`);
  console.log("Escribe tu mensaje. Ctrl+C para salir.");
  console.log("=".repeat(60));

  const greeting = await agent.handleMessage(PHONE, "hola", RESTAURANT_ID);
  console.log(`\nBot: ${greeting}`);
  rl.prompt();

  rl.on("line", async (line) => {
    const text = line.trim();
    if (!text) { rl.prompt(); return; }

    try {
      const response = await agent.handleMessage(PHONE, text, RESTAURANT_ID);
      console.log(`\nBot: ${response}`);
    } catch (err) {
      console.error("\n[Error]", err);
    }

    rl.prompt();
  });

  rl.on("close", () => {
    console.log("\nSesión terminada.");
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
