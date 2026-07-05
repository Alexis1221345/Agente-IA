import { google } from "googleapis";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RestaurantConfig } from "../../config/types.js";
import type { ConversationState } from "../../data/conversation-repo.js";
import { orderTotal } from "../../business/order.js";

const ORDERS_TAB = "Pedidos";
const RESERVATIONS_TAB = "Reservas";

const ORDER_HEADERS = [
  "Folio", "Restaurante", "Fecha", "Hora", "Cliente", "Teléfono",
  "Productos", "Total", "Hora Recogida", "Estado",
];

const RESERVATION_HEADERS = [
  "Folio", "Restaurante", "Fecha Solicitud", "Hora Solicitud",
  "Cliente", "Teléfono", "Fecha Reserva", "Hora", "Personas",
  "Peticiones", "Estado",
];

// Tracks which (spreadsheetId:tab) combos are already initialized to avoid
// repeated metadata calls on every write.
const initialized = new Set<string>();

const clientCache = new Map<string, CRMSheetsClient>();

export class CRMSheetsClient {
  private sheets: ReturnType<typeof google.sheets>;
  private spreadsheetId: string;

  constructor(credentialsOrPath: string, spreadsheetId: string) {
    let credentials: object;
    if (credentialsOrPath.trim().startsWith("{")) {
      credentials = JSON.parse(credentialsOrPath);
    } else {
      credentials = JSON.parse(readFileSync(resolve(credentialsOrPath), "utf8"));
    }
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    this.sheets = google.sheets({ version: "v4", auth });
    this.spreadsheetId = spreadsheetId;
  }

  /** Creates the tab and writes headers if it doesn't already exist. */
  private async ensureTab(tabName: string, headers: string[]): Promise<void> {
    const cacheKey = `${this.spreadsheetId}:${tabName}`;
    if (initialized.has(cacheKey)) return;

    const meta = await this.sheets.spreadsheets.get({
      spreadsheetId: this.spreadsheetId,
    });
    const existingTitles = (meta.data.sheets ?? []).map(
      (s) => s.properties?.title,
    );

    if (!existingTitles.includes(tabName)) {
      await this.sheets.spreadsheets.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: {
          requests: [{ addSheet: { properties: { title: tabName } } }],
        },
      });
      await this.sheets.spreadsheets.values.append({
        spreadsheetId: this.spreadsheetId,
        range: `${tabName}!A1`,
        valueInputOption: "RAW",
        requestBody: { values: [headers] },
      });
    } else {
      // Tab exists — add headers only if row 1 is still empty
      const existing = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: `${tabName}!A1:Z1`,
      });
      if (!existing.data.values?.[0]?.length) {
        await this.sheets.spreadsheets.values.append({
          spreadsheetId: this.spreadsheetId,
          range: `${tabName}!A1`,
          valueInputOption: "RAW",
          requestBody: { values: [headers] },
        });
      }
    }

    initialized.add(cacheKey);
  }

  async appendOrder(params: {
    orderCode: string;
    restaurantName: string;
    state: ConversationState;
    timezone: string;
    crmWebhookUrl?: string;
  }): Promise<void> {
    await this.ensureTab(ORDERS_TAB, ORDER_HEADERS);

    const { state, orderCode, restaurantName, timezone } = params;
    const items = state.data.order?.items ?? [];
    const now = new Date();
    const dateStr = now.toLocaleDateString("es-MX", { timeZone: timezone });
    const timeStr = now.toLocaleTimeString("es-MX", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
    });

    const itemsSummary = items
      .map((i) => {
        const mods: string[] = [];
        if (i.extras.length) mods.push(`+${i.extras.join(",")}`);
        if (i.sin.length) mods.push(`sin ${i.sin.join(",")}`);
        if (i.nota) mods.push(i.nota);
        return `${i.cantidad}x ${i.nombre}${mods.length ? ` (${mods.join(" ")})` : ""}`;
      })
      .join(" | ");

    const row = [
      orderCode,
      restaurantName,
      dateStr,
      timeStr,
      state.data.nombre ?? "",
      state.phone,
      itemsSummary,
      `$${orderTotal(items)}`,
      state.data.order?.pickupTime ?? "",
      "Pendiente",
    ];

    await this.sheets.spreadsheets.values.append({
      spreadsheetId: this.spreadsheetId,
      range: `${ORDERS_TAB}!A1`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [row] },
    });

    if (params.crmWebhookUrl) {
      await postWebhook(params.crmWebhookUrl, {
        type: "order",
        folio: orderCode,
        restaurante: restaurantName,
        cliente: state.data.nombre ?? "",
        telefono: state.phone,
        productos: items.map((i) => ({
          nombre: i.nombre,
          cantidad: i.cantidad,
          precio: i.precio,
          extras: i.extras,
          sin: i.sin,
          nota: i.nota,
        })),
        total: orderTotal(items),
        horaRecogida: state.data.order?.pickupTime ?? null,
        timestamp: new Date().toISOString(),
      });
    }
  }

  async appendReservation(params: {
    resCode: string;
    restaurantName: string;
    state: ConversationState;
    timezone: string;
    crmWebhookUrl?: string;
  }): Promise<void> {
    await this.ensureTab(RESERVATIONS_TAB, RESERVATION_HEADERS);

    const { state, resCode, restaurantName, timezone } = params;
    const d = state.data;
    const now = new Date();
    const dateStr = now.toLocaleDateString("es-MX", { timeZone: timezone });
    const timeStr = now.toLocaleTimeString("es-MX", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
    });

    const row = [
      resCode,
      restaurantName,
      dateStr,
      timeStr,
      d.nombre ?? "",
      state.phone,
      d.fecha ?? "",
      d.hora ?? "",
      String(d.personas ?? ""),
      d.peticiones ?? "",
      "Confirmada",
    ];

    await this.sheets.spreadsheets.values.append({
      spreadsheetId: this.spreadsheetId,
      range: `${RESERVATIONS_TAB}!A1`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [row] },
    });

    if (params.crmWebhookUrl) {
      await postWebhook(params.crmWebhookUrl, {
        type: "reservation",
        folio: resCode,
        restaurante: restaurantName,
        cliente: d.nombre ?? "",
        telefono: state.phone,
        fechaReserva: d.fecha ?? "",
        hora: d.hora ?? "",
        personas: d.personas ?? 0,
        peticiones: d.peticiones ?? "",
        timestamp: new Date().toISOString(),
      });
    }
  }
}

async function postWebhook(url: string, payload: unknown): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`Webhook error ${res.status}: ${await res.text()}`);
  }
}

export function getCRMClient(
  credentialsOrPath: string,
  spreadsheetId: string,
): CRMSheetsClient {
  const key = spreadsheetId;
  if (clientCache.has(key)) return clientCache.get(key)!;
  const client = new CRMSheetsClient(credentialsOrPath, spreadsheetId);
  clientCache.set(key, client);
  return client;
}
