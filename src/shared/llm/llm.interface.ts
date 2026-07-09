/** Un turno de conversación (compartido entre el repo de conversaciones y el LLM). */
export interface Message {
  role: "user" | "assistant";
  content: string;
}

/** Campos de reserva que el LLM puede extraer de un mensaje.
 *  Subconjunto estructural de ReservationData (whatsapp/business/reservation). */
export interface ExtractedReservationFields {
  fecha?: string;
  hora?: string;
  personas?: number;
  nombre?: string;
  peticiones?: string;
}

export interface ExtractedFields {
  fields: ExtractedReservationFields;
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

export interface MessageIntent {
  /** Wants to make a reservation */
  isReservation: boolean;
  /** Wants to order food/drinks */
  isOrder: boolean;
  /** Wants to cancel an existing reservation */
  isCancelFlow: boolean;
  /** Accepts/confirms what the bot showed (sí, perfecto, listo, así está bien, muchas gracias exacto, etc.) */
  isConfirm: boolean;
  /** Rejects/cancels what the bot showed (no, cancela, mejor no) */
  isReject: boolean;
  /** Says goodbye or ends the conversation */
  isFarewell: boolean;
  /** Wants to abandon the current flow (siempre no, olvidalo, never mind) */
  isAbandon: boolean;
  /** Asks a question about the restaurant, menu, hours, etc. */
  isQuestion: boolean;
  /** Done adding items and wants to finalize the order */
  isDoneOrdering: boolean;
  /** Wants to see menu categories */
  isCategoryNav: boolean;
  /** Wants to restart the conversation from scratch */
  isReset: boolean;
  /** Says no special requests (no, nada, todo bien) */
  isNegativeResponse: boolean;
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

  classifyIntent(
    status: string,
    collectedFields: string,
    history: Message[],
    userMessage: string,
  ): Promise<MessageIntent>;
}
