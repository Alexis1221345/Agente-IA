import type { ReservationData } from "../../business/reservation.js";
import type { Message } from "../../data/conversation-repo.js";

export interface ExtractedFields {
  fields: Partial<ReservationData>;
  // Raw text fragment the LLM identified for each field (for debugging)
  raw?: Record<string, string>;
}

export interface ILLMClient {
  /**
   * Given the conversation history + latest user message,
   * extract any reservation fields present in the text.
   */
  extractFields(
    history: Message[],
    userMessage: string,
    timezone: string,
  ): Promise<ExtractedFields>;

  /**
   * Generate a natural-language response given context.
   * Used when we need a freeform reply (escalation, FAQ, etc.)
   */
  generateReply(
    systemPrompt: string,
    history: Message[],
    userMessage: string,
  ): Promise<string>;
}
