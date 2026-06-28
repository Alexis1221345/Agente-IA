import type { ReservationData } from "../../business/reservation.js";
import type { Message } from "../../data/conversation-repo.js";

export interface ExtractedFields {
  fields: Partial<ReservationData>;
  raw?: Record<string, string>;
}

export interface RawOrderItem {
  nombre: string;
  cantidad: number;
  extras: string[];
  sin: string[];
  nota?: string;
}

export interface ExtractedOrderItems {
  items: RawOrderItem[];
  isDone: boolean;           // customer said "listo", "nada más", etc.
  removeNombre?: string;     // customer said "quita X" or "elimina X"
}

export interface ILLMClient {
  extractFields(
    history: Message[],
    userMessage: string,
    timezone: string,
  ): Promise<ExtractedFields>;

  extractOrderItems(
    history: Message[],
    userMessage: string,
  ): Promise<ExtractedOrderItems>;

  generateReply(
    systemPrompt: string,
    history: Message[],
    userMessage: string,
  ): Promise<string>;
}
