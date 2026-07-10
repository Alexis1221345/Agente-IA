import { google } from "googleapis";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RestaurantConfig, DaySchedule } from "../config/types.js";

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Las columnas se buscan POR NOMBRE en la fila de encabezados (fila 1),
 * así el Sheet puede reordenarse o crecer sin romper el código.
 */
type HeaderIndex = Map<string, number>;

function cell(row: string[], idx: HeaderIndex, header: string): string {
  const i = idx.get(header);
  return i === undefined ? "" : (row[i] ?? "");
}

/** "HH:MM-HH:MM" → DaySchedule | null */
function parseDay(raw: string): DaySchedule | null {
  if (!raw || raw.toLowerCase() === "closed") return null;
  const m = raw.match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
  return m ? { open: m[1], close: m[2] } : null;
}

/**
 * phone_number_id can arrive in scientific notation from Sheets (e.g. "1.165E+15").
 * Convert to a plain integer string.
 */
function normalizeId(raw: string): string {
  if (/e\+/i.test(raw)) return String(BigInt(Math.round(Number(raw))));
  return raw.trim();
}

function parseFaq(raw: string): Record<string, string> {
  if (!raw?.trim()) return {};
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

function rowToConfig(row: string[], idx: HeaderIndex): RestaurantConfig | null {
  const phoneNumberIdRaw = cell(row, idx, "phone_number_id").trim();
  if (!phoneNumberIdRaw) return null;

  const phoneNumberId = normalizeId(phoneNumberIdRaw);
  const restaurantId  = cell(row, idx, "restaurant_id").trim() || phoneNumberId;

  const schedule: Record<string, DaySchedule | null> = {
    monday:    parseDay(cell(row, idx, "lunes")),
    tuesday:   parseDay(cell(row, idx, "martes")),
    wednesday: parseDay(cell(row, idx, "miercoles")),
    thursday:  parseDay(cell(row, idx, "jueves")),
    friday:    parseDay(cell(row, idx, "viernes")),
    saturday:  parseDay(cell(row, idx, "sabado")),
    sunday:    parseDay(cell(row, idx, "domingo")),
  };

  // Global cred from env (not per-restaurant)
  const credJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON?.trim();
  const credPath = process.env.GOOGLE_CREDENTIALS_PATH?.trim();

  return {
    id: restaurantId,
    phoneNumberId,
    name:                cell(row, idx, "nombre").trim()              || restaurantId,
    timezone:            cell(row, idx, "timezone").trim()            || "America/Mexico_City",
    calendarId:          cell(row, idx, "calendar_id").trim()         || "",
    sheetsId:            cell(row, idx, "menu_sheet_id").trim()       || undefined,
    menuWebUrl:          cell(row, idx, "menu_web_url").trim()        || undefined,
    websiteUrl:          cell(row, idx, "website_url").trim()         || undefined,
    crmWebhookUrl:       cell(row, idx, "crm_webhook_url").trim()     || undefined,
    humanPhone:          cell(row, idx, "human_phone").trim()         || "",
    cancellationPolicy:  cell(row, idx, "cancellation_policy").trim() || "",
    slotDurationMinutes: Number(cell(row, idx, "slot_duration"))  || 90,
    capacityPerSlot:     Number(cell(row, idx, "capacity"))       || 30,
    bookableQuota:       Number(cell(row, idx, "quota"))          || 0.8,
    maxAutoGroupSize:    Number(cell(row, idx, "max_group"))      || 8,
    schedule,
    googleCredentialsPath: credJson || credPath || undefined,
    faq: parseFaq(cell(row, idx, "faq")),
    gbpAccountId:  cell(row, idx, "gbp_account_id").trim()  || undefined,
    gbpLocationId: cell(row, idx, "gbp_location_id").trim() || undefined,
    reviewsEnabled: /^(true|sí|si|yes|1)$/i.test(cell(row, idx, "reviews_enabled").trim()),
    reviewsTone:   cell(row, idx, "reviews_tono").trim()    || undefined,
    reviewsPollMinutes: Number(cell(row, idx, "reviews_poll_minutes").trim()) || undefined,
    // Celda vacía = activo (compatibilidad con filas existentes); solo FALSE/no/0 lo apaga
    whatsappEnabled:     !/^(false|no|0)$/i.test(cell(row, idx, "whatsapp_enabled").trim()),
    reservationsEnabled: !/^(false|no|0)$/i.test(cell(row, idx, "reservas_enabled").trim()),
    ordersEnabled:       !/^(false|no|0)$/i.test(cell(row, idx, "pedidos_enabled").trim()),
  };
}

export class MasterConfigClient {
  private sheets: ReturnType<typeof google.sheets>;
  private spreadsheetId: string;
  private cache: { configs: Map<string, RestaurantConfig>; fetchedAt: number } | null = null;

  constructor(credentialsOrPath: string, spreadsheetId: string) {
    let credentials: object;
    if (credentialsOrPath.trim().startsWith("{")) {
      credentials = JSON.parse(credentialsOrPath);
    } else {
      credentials = JSON.parse(readFileSync(resolve(credentialsOrPath), "utf8"));
    }
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    });
    this.sheets = google.sheets({ version: "v4", auth });
    this.spreadsheetId = spreadsheetId;
  }

  async getConfigs(forceRefresh = false): Promise<Map<string, RestaurantConfig>> {
    const now = Date.now();
    if (!forceRefresh && this.cache && now - this.cache.fetchedAt < CACHE_TTL_MS) {
      return this.cache.configs;
    }

    const res = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: "Restaurantes!A1:AZ100", // fila 1 = encabezados; columnas por nombre
    });

    const rows = (res.data.values ?? []) as string[][];
    const headers = (rows[0] ?? []).map((h) => String(h).trim().toLowerCase());
    const idx: HeaderIndex = new Map(headers.map((h, i) => [h, i]));
    const configs = new Map<string, RestaurantConfig>();

    for (const row of rows.slice(1)) {
      const cfg = rowToConfig(row, idx);
      if (cfg) configs.set(cfg.phoneNumberId!, cfg);
    }

    this.cache = { configs, fetchedAt: now };
    return configs;
  }

  async getByPhoneNumberId(id: string): Promise<RestaurantConfig | null> {
    const configs = await this.getConfigs();
    return configs.get(id) ?? null;
  }
}

const clientCache = new Map<string, MasterConfigClient>();

export function getMasterConfigClient(
  credentialsOrPath: string,
  spreadsheetId: string,
): MasterConfigClient {
  const key = spreadsheetId;
  if (clientCache.has(key)) return clientCache.get(key)!;
  const client = new MasterConfigClient(credentialsOrPath, spreadsheetId);
  clientCache.set(key, client);
  return client;
}
