import { google } from "googleapis";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface MenuItem {
  categoriaNum: string;   // "01 / Café"
  categoria: string;      // "Bebidas Calientes"
  categoriaFoto: string;  // filename in Imagenes/
  nombre: string;
  precio: number;
  descripcion: string;
  imagen: string;         // filename in Imagenes/
  disponible: boolean;
  extras: string[];       // additions customer can request
  sinOpciones: string[];  // ingredients customer can remove
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let cache: { items: MenuItem[]; fetchedAt: number } | null = null;
const clientCache = new Map<string, MenuSheetsClient>();

export class MenuSheetsClient {
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
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    });
    this.sheets = google.sheets({ version: "v4", auth });
    this.spreadsheetId = spreadsheetId;
  }

  async getMenu(forceRefresh = false): Promise<MenuItem[]> {
    const now = Date.now();
    if (!forceRefresh && cache && now - cache.fetchedAt < CACHE_TTL_MS) {
      return cache.items;
    }

    const res = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: "Menu!A2:J1000",
    });

    const rows = (res.data.values ?? []) as string[][];
    const items: MenuItem[] = rows
      .filter((r) => r[3]?.trim()) // must have a product name
      .map((r) => ({
        categoriaNum:  r[0]?.trim() ?? "",
        categoria:     r[1]?.trim() ?? "",
        categoriaFoto: r[2]?.trim() ?? "",
        nombre:        r[3]?.trim() ?? "",
        precio:        Number(r[4] ?? 0),
        descripcion:   r[5]?.trim() ?? "",
        imagen:        r[6]?.trim() ?? "",
        disponible:    (r[7]?.trim().toUpperCase() ?? "TRUE") !== "FALSE",
        extras:     r[8] ? r[8].split(",").map((s) => s.trim()).filter(Boolean) : [],
        sinOpciones: r[9] ? r[9].split(",").map((s) => s.trim()).filter(Boolean) : [],
      }))
      .filter((i) => i.disponible);

    cache = { items, fetchedAt: now };
    return items;
  }

  /** Fuzzy match by name (normalizes accents + case). */
  findByName(nombre: string, items: MenuItem[]): MenuItem | undefined {
    const norm = (s: string) =>
      s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    const target = norm(nombre);
    return (
      items.find((i) => norm(i.nombre) === target) ??
      items.find((i) => norm(i.nombre).includes(target)) ??
      items.find((i) => target.includes(norm(i.nombre)))
    );
  }

  /** Build a text summary of the menu for inclusion in prompts. */
  menuText(items: MenuItem[]): string {
    const groups = new Map<string, MenuItem[]>();
    for (const item of items) {
      const key = item.categoria || "General";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(item);
    }
    const lines: string[] = [];
    for (const [cat, catItems] of groups) {
      lines.push(`${cat}:`);
      for (const i of catItems) {
        const mods: string[] = [];
        if (i.extras.length) mods.push(`extras: ${i.extras.join(", ")}`);
        if (i.sinOpciones.length) mods.push(`sin: ${i.sinOpciones.join(", ")}`);
        lines.push(`  - ${i.nombre} $${i.precio}${mods.length ? ` (${mods.join("; ")})` : ""}`);
      }
    }
    return lines.join("\n");
  }
}

export function getMenuClient(
  credentialsOrPath: string,
  spreadsheetId: string,
): MenuSheetsClient {
  const key = `${spreadsheetId}`;
  if (clientCache.has(key)) return clientCache.get(key)!;
  const client = new MenuSheetsClient(credentialsOrPath, spreadsheetId);
  clientCache.set(key, client);
  return client;
}
