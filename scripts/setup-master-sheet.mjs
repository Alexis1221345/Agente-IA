/**
 * One-time script: creates the "Restaurantes-Agente" master Google Sheet
 * and populates it with Muna Cafeteria's current config.
 *
 * Usage:  node scripts/setup-master-sheet.mjs
 */
import { config } from "dotenv";
config();

import { google } from "googleapis";

const FAQ = {
  "ubicación|dirección|dónde están|cómo llegar|dónde quedan":
    "Estamos en Av. de la Reforma 218, Local 4, Cuauhtémoc, CDMX. Abre el mapa aquí: https://maps.google.com/?q=Av.+de+la+Reforma+218,+Local+4,+Cuauhtémoc,+Ciudad+de+Mexico",
  "estacionamiento|parking|dónde estaciono":
    "Sí, contamos con estacionamiento propio. ¡Llegas y te orientamos!",
  "pago|cobran|tarjeta|efectivo|transferencia|cómo pagan":
    "Aceptamos efectivo, todas las tarjetas bancarias (débito y crédito) y transferencias. Sin problema.",
  "reservar|necesito reservar|se necesita reservar|es necesario reservar":
    "No es obligatorio reservar, pero lo recomendamos para asegurarte mesa, especialmente fines de semana y temporadas altas.",
  "evento|eventos|privado|salón|celebración|cumpleaños|fiesta|reunión privada":
    "¡Sí, organizamos eventos privados! Desde cumpleaños hasta reuniones especiales. Cuéntanos tu idea y nuestro equipo te da todos los detalles y disponibilidad: +52-312-111-6210.",
  "mascotas|perros|animales": "Lo sentimos, no permitimos mascotas.",
  "niños|bebés|silla": "Con gusto te preparamos una silla para bebé.",
};

const MUNA = {
  phone_number_id:      "1165004710034140",
  restaurant_id:        "muna",
  nombre:               "Muna Cafeteria",
  timezone:             "America/Mexico_City",
  calendar_id:          "alexis.morfin.alexander.chuqui@gmail.com",
  menu_sheet_id:        "16t5lMZ3-KkQgXrfP-OyTfmWKq0hTwI3Ys67eVp0vn5w",
  menu_web_url:         "https://alexis1221345.github.io/Pagina-Web-Cafeteria/pedido.html",
  human_phone:          "+52-312-111-6210",
  cancellation_policy:  "Puedes cancelar sin costo hasta 2 horas antes de tu reserva.",
  slot_duration:        "90",
  capacity:             "30",
  quota:                "0.8",
  max_group:            "8",
  lunes:                "closed",
  martes:               "7:00-16:00",
  miercoles:            "7:00-16:00",
  jueves:               "7:00-16:00",
  viernes:              "7:00-16:00",
  sabado:               "7:00-16:00",
  domingo:              "7:00-16:00",
  faq:                  JSON.stringify(FAQ),
};

const HEADERS = [
  "phone_number_id", "restaurant_id", "nombre", "timezone",
  "calendar_id", "menu_sheet_id", "menu_web_url", "human_phone",
  "cancellation_policy", "slot_duration", "capacity", "quota", "max_group",
  "lunes", "martes", "miercoles", "jueves", "viernes", "sabado", "domingo",
  "faq",
];

async function main() {
  const credJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON?.trim();
  if (!credJson) throw new Error("Falta GOOGLE_SERVICE_ACCOUNT_KEY_JSON en .env");

  const credentials = JSON.parse(credJson);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/drive",
    ],
  });

  const sheets = google.sheets({ version: "v4", auth });
  const drive  = google.drive({ version: "v3", auth });

  // 1. Create spreadsheet
  console.log("Creando spreadsheet...");
  const created = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title: "Restaurantes-Agente" },
      sheets: [{
        properties: {
          title: "Restaurantes",
          gridProperties: { frozenRowCount: 1 },
        },
      }],
    },
  });

  const spreadsheetId = created.data.spreadsheetId;
  const sheetId       = created.data.sheets[0].properties.sheetId;
  console.log(`✅ Spreadsheet creado: ${spreadsheetId}`);

  // 2. Write headers + data row
  const row = HEADERS.map(h => MUNA[h] ?? "");
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: "Restaurantes!A1",
    valueInputOption: "RAW",
    requestBody: { values: [HEADERS, row] },
  });
  console.log("✅ Datos de Muna Cafeteria escritos");

  // 3. Format header row (bold, background)
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 0.2, green: 0.5, blue: 0.8 },
                textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
              },
            },
            fields: "userEnteredFormat(backgroundColor,textFormat)",
          },
        },
        {
          autoResizeDimensions: {
            dimensions: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: HEADERS.length },
          },
        },
      ],
    },
  });
  console.log("✅ Formato aplicado");

  // 4. Share with user email so they can edit it in Google Drive
  const userEmail = "alexis.morfin.alexander.chuqui@gmail.com";
  await drive.permissions.create({
    fileId: spreadsheetId,
    requestBody: { type: "user", role: "writer", emailAddress: userEmail },
    sendNotificationEmail: false,
  });
  console.log(`✅ Compartido con ${userEmail}`);

  console.log("\n════════════════════════════════════════");
  console.log(`MASTER_SHEET_ID=${spreadsheetId}`);
  console.log(`URL: https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`);
  console.log("════════════════════════════════════════\n");
  console.log("Copia el MASTER_SHEET_ID de arriba y ponlo en .env y en Render.");
}

main().catch(err => { console.error(err); process.exit(1); });
