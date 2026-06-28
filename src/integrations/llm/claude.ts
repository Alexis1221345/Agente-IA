import Anthropic from "@anthropic-ai/sdk";
import type { ILLMClient, ExtractedFields } from "./llm.interface.js";
import type { Message } from "../../data/conversation-repo.js";
import type { ReservationData } from "../../business/reservation.js";

const EXTRACT_TOOL: Anthropic.Tool = {
  name: "extract_reservation_fields",
  description:
    "Extract reservation fields present in the customer's message. Only include fields that are clearly stated — do NOT infer or guess. Leave out fields not mentioned.",
  input_schema: {
    type: "object" as const,
    properties: {
      fecha: {
        type: "string",
        description:
          "Date as stated by customer. A bare day name by itself IS a valid date — extract it. " +
          "Examples: 'hoy', 'mañana', 'domingo', 'lunes', 'el viernes', 'este sábado', " +
          "'el próximo martes', '25 de junio', '25/06', '2025-06-25'. " +
          "Do not normalize — return the raw expression exactly as the customer wrote it.",
      },
      hora: {
        type: "string",
        description:
          "Time as stated by customer (e.g. 'a las 8', '8 pm', '8 de la noche', '20:00', '8'). " +
          "A bare number like '8' or '20' in response to a time question IS a valid time. " +
          "Return the raw expression.",
      },
      personas: {
        type: "number",
        description:
          "Number of people as an integer. " +
          "Convert word numbers: 'dos'→2, 'tres'→3, 'cuatro'→4, 'cinco'→5, " +
          "'seis'→6, 'siete'→7, 'ocho'→8. " +
          "Examples: 'somos 4', 'para 4 personas', 'cuatro personas' → 4.",
      },
      nombre: {
        type: "string",
        description:
          "Customer's name for the reservation. Extract only the name, not titles. " +
          "Examples: 'a nombre de Juan García' → 'Juan García', 'me llamo María' → 'María', " +
          "'soy Carlos' → 'Carlos'.",
      },
      peticiones: {
        type: "string",
        description:
          "Positive special requests only: dietary needs, occasion, seating preference, etc. " +
          "NEVER extract negative or empty responses — if the customer says 'no', 'nada', " +
          "'ninguna', 'no tengo', 'sin nada', 'estamos bien', do NOT include this field.",
      },
    },
    required: [],
  },
};

export class ClaudeLLMClient implements ILLMClient {
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model = "claude-haiku-4-5-20251001") {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async extractFields(
    history: Message[],
    userMessage: string,
    _timezone: string,
  ): Promise<ExtractedFields> {
    const messages: Anthropic.MessageParam[] = [
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: userMessage },
    ];

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 256,
      system:
        "You are a field extractor for a restaurant reservation system. Use the provided tool to extract ONLY fields explicitly stated by the customer. Never invent data.",
      tools: [EXTRACT_TOOL],
      tool_choice: { type: "auto" },
      messages,
    });

    const toolUse = response.content.find((b) => b.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      return { fields: {} };
    }

    const input = toolUse.input as Record<string, unknown>;
    const fields: Partial<ReservationData> = {};
    const raw: Record<string, string> = {};

    if (typeof input.fecha === "string") {
      raw.fecha = input.fecha;
      fields.fecha = input.fecha; // normalized by agent later
    }
    if (typeof input.hora === "string") {
      raw.hora = input.hora;
      fields.hora = input.hora; // normalized by agent later
    }
    if (typeof input.personas === "number") {
      fields.personas = Math.round(input.personas);
    }
    if (typeof input.nombre === "string" && input.nombre.trim()) {
      fields.nombre = input.nombre.trim();
    }
    if (typeof input.peticiones === "string" && input.peticiones.trim()) {
      fields.peticiones = input.peticiones.trim();
    }

    return { fields, raw };
  }

  async generateReply(
    systemPrompt: string,
    history: Message[],
    userMessage: string,
  ): Promise<string> {
    const messages: Anthropic.MessageParam[] = [
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: userMessage },
    ];

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 512,
      system: systemPrompt,
      messages,
    });

    const text = response.content.find((b) => b.type === "text");
    return text?.type === "text" ? text.text : "";
  }
}
