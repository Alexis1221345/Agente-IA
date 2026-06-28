import type { ICalendarClient } from "./calendar.interface.js";
import type { RestaurantConfig } from "../../config/types.js";
import { GoogleCalendarClient } from "./google.js";

const clientCache = new Map<string, ICalendarClient>();

export function getCalendarClient(config: RestaurantConfig): ICalendarClient {
  if (clientCache.has(config.id)) {
    return clientCache.get(config.id)!;
  }

  if (!config.googleCredentialsPath) {
    throw new Error(
      `No hay credenciales de Google Calendar para el restaurante "${config.id}". ` +
      `Configura GOOGLE_SERVICE_ACCOUNT_KEY_JSON o GOOGLE_CREDENTIALS_PATH en .env`,
    );
  }

  const client = new GoogleCalendarClient(config.googleCredentialsPath);
  clientCache.set(config.id, client);
  return client;
}

export function clearCalendarCache(): void {
  clientCache.clear();
}
