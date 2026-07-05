import { google } from "googleapis";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RestaurantConfig, DaySchedule } from "../../config/types.js";

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Column indices in the Sheet (A=0, B=1, …)
const COL = {
  phone_number_id:     0,
  restaurant_id:       1,
  nombre:              2,
  timezone:            3,
  calendar_id:         4,
  menu_sheet_id:       5,
  menu_web_url:        6,
  human_phone:         7,
  cancellation_policy: 8,
  slot_duration:       9,
  capacity:           10,
  quota:              11,
  max_group:          12,
  // días: lunes=13 … domingo=19
  lunes:              13,
  martes:             14,
  miercoles:          15,
  jueves:             16,
  viernes:            17,
  sabado:             18,
  domingo:            19,
  faq:                20,
  website_url:        21,
  crm_webhook_url:   22,
} as const;

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

function rowToConfig(row: string[]): RestaurantConfig | null {
  const phoneNumberIdRaw = row[COL.phone_number_id]?.trim();
  if (!phoneNumberIdRaw) return null;

  const phoneNumberId = normalizeId(phoneNumberIdRaw);
  const restaurantId  = row[COL.restaurant_id]?.trim() || phoneNumberId;

  const schedule: Record<string, DaySchedule | null> = {
    monday:    parseDay(row[COL.lunes]    ?? ""),
    tuesday:   parseDay(row[COL.martes]   ?? ""),
    wednesday: parseDay(row[COL.miercoles]?? ""),
    thursday:  parseDay(row[COL.jueves]   ?? ""),
    friday:    parseDay(row[COL.viernes]  ?? ""),
    saturday:  parseDay(row[COL.sabado]   ?? ""),
    sunday:    parseDay(row[COL.domingo]  ?? ""),
  };

  // Global cred from env (not per-restaurant)
  const credJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON?.trim();
  const credPath = process.env.GOOGLE_CREDENTIALS_PATH?.trim();

  return {
    id: restaurantId,
    phoneNumberId,
    name:                row[COL.nombre]?.trim()              || restaurantId,
    timezone:            row[COL.timezone]?.trim()            || "America/Mexico_City",
    calendarId:          row[COL.calendar_id]?.trim()         || "",
    sheetsId:            row[COL.menu_sheet_id]?.trim()       || undefined,
    menuWebUrl:          row[COL.menu_web_url]?.trim()        || undefined,
    websiteUrl:          row[COL.website_url]?.trim()         || undefined,
    crmWebhookUrl:       row[COL.crm_webhook_url]?.trim()    || undefined,
    humanPhone:          row[COL.human_phone]?.trim()         || "",
    cancellationPolicy:  row[COL.cancellation_policy]?.trim() || "",
    slotDurationMinutes: Number(row[COL.slot_duration]  ?? 90)  || 90,
    capacityPerSlot:     Number(row[COL.capacity]       ?? 30)  || 30,
    bookableQuota:       Number(row[COL.quota]          ?? 0.8) || 0.8,
    maxAutoGroupSize:    Number(row[COL.max_group]      ?? 8)   || 8,
    schedule,
    googleCredentialsPath: credJson || credPath || undefined,
    faq: parseFaq(row[COL.faq] ?? ""),
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
      range: "Restaurantes!A2:W100",
    });

    const rows = (res.data.values ?? []) as string[][];
    const configs = new Map<string, RestaurantConfig>();

    for (const row of rows) {
      const cfg = rowToConfig(row);
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
