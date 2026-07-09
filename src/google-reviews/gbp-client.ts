import { google } from "googleapis";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Cliente para la Google Business Profile API (reseñas de Google Maps).
 *
 * Requisitos por proyecto (una sola vez):
 *  1. Solicitar acceso a la API de Business Profile con el formulario oficial de Google:
 *     https://developers.google.com/my-business/content/prereqs
 *  2. Habilitar "Google My Business API" (mybusiness.googleapis.com) en el proyecto de GCP.
 *
 * Requisitos por restaurante:
 *  - Agregar el email de la service account como Administrador del Perfil de Negocio
 *    (business.google.com → Usuarios → Agregar → rol "Administrador").
 *  - Registrar gbp_account_id y gbp_location_id en el Sheet maestro.
 */

export type StarRating = "ONE" | "TWO" | "THREE" | "FOUR" | "FIVE";

export interface GbpReview {
  reviewId: string;
  reviewer: { displayName?: string };
  starRating: StarRating;
  comment?: string;
  createTime: string;
  updateTime: string;
  reviewReply?: { comment: string; updateTime: string };
}

const GBP_BASE = "https://mybusiness.googleapis.com/v4";

export class GbpReviewsClient {
  private auth: InstanceType<typeof google.auth.GoogleAuth>;

  constructor(credentialsOrPath: string) {
    let credentials: object;
    if (credentialsOrPath.trim().startsWith("{")) {
      credentials = JSON.parse(credentialsOrPath);
    } else {
      credentials = JSON.parse(readFileSync(resolve(credentialsOrPath), "utf8"));
    }
    this.auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/business.manage"],
    });
  }

  /** Lista las reseñas más recientes de una ubicación (máx. `pageSize`). */
  async listReviews(
    accountId: string,
    locationId: string,
    pageSize = 50,
  ): Promise<GbpReview[]> {
    const client = await this.auth.getClient();
    const url =
      `${GBP_BASE}/accounts/${accountId}/locations/${locationId}/reviews` +
      `?pageSize=${pageSize}&orderBy=updateTime%20desc`;
    const res = await client.request<{ reviews?: GbpReview[] }>({ url });
    return res.data.reviews ?? [];
  }

  /** Publica (o reemplaza) la respuesta del negocio a una reseña. */
  async replyToReview(
    accountId: string,
    locationId: string,
    reviewId: string,
    comment: string,
  ): Promise<void> {
    const client = await this.auth.getClient();
    const url =
      `${GBP_BASE}/accounts/${accountId}/locations/${locationId}/reviews/${reviewId}/reply`;
    await client.request({
      url,
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ comment }),
    });
  }
}

// Cache por credencial: cada restaurante puede usar una service account distinta.
const cachedClients = new Map<string, GbpReviewsClient>();

export function getGbpReviewsClient(credentialsOrPath: string): GbpReviewsClient {
  let client = cachedClients.get(credentialsOrPath);
  if (!client) {
    client = new GbpReviewsClient(credentialsOrPath);
    cachedClients.set(credentialsOrPath, client);
  }
  return client;
}

export function starRatingToNumber(rating: StarRating): number {
  return { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 }[rating] ?? 3;
}
