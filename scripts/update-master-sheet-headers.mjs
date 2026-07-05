/**
 * Actualiza los encabezados del Google Sheet maestro existente.
 * Agrega columnas nuevas al final de la fila 1 sin tocar los datos.
 *
 * Uso:  node scripts/update-master-sheet-headers.mjs
 */
import { config } from "dotenv";
config();
import { google } from "googleapis";

const SHEET_ID = process.env.MASTER_SHEET_ID;
if (!SHEET_ID) throw new Error("Falta MASTER_SHEET_ID en .env");

const EXPECTED_HEADERS = [
  // A  - U  (ya existían)
  "phone_number_id",     // A  0
  "restaurant_id",       // B  1
  "nombre",              // C  2
  "timezone",            // D  3
  "calendar_id",         // E  4
  "menu_sheet_id",       // F  5
  "menu_web_url",        // G  6
  "human_phone",         // H  7
  "cancellation_policy", // I  8
  "slot_duration",       // J  9
  "capacity",            // K 10
  "quota",               // L 11
  "max_group",           // M 12
  "lunes",               // N 13
  "martes",              // O 14
  "miercoles",           // P 15
  "jueves",              // Q 16
  "viernes",             // R 17
  "sabado",              // S 18
  "domingo",             // T 19
  "faq",                 // U 20
  // V - W  (nuevas)
  "website_url",         // V 21
  "crm_webhook_url",     // W 22
];

const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON);
const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

async function main() {
  // Leer encabezados actuales
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "Restaurantes!A1:Z1",
  });
  const currentHeaders = res.data.values?.[0] ?? [];
  console.log(`Columnas actuales (${currentHeaders.length}):`, currentHeaders.join(", "));

  // Detectar qué columnas faltan
  const missing = EXPECTED_HEADERS.filter(h => !currentHeaders.includes(h));
  if (missing.length === 0) {
    console.log("✅ Todos los encabezados ya están presentes. Sin cambios.");
    return;
  }
  console.log(`Columnas nuevas a agregar: ${missing.join(", ")}`);

  // Escribir la fila completa de encabezados (sobreescribe fila 1 entera)
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: "Restaurantes!A1",
    valueInputOption: "RAW",
    requestBody: { values: [EXPECTED_HEADERS] },
  });
  console.log("✅ Fila de encabezados actualizada");

  // Autoajustar ancho de todas las columnas
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const sheetId = meta.data.sheets.find(
    s => s.properties.title === "Restaurantes"
  )?.properties?.sheetId ?? 0;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: [
        // Fondo azul + texto blanco en fila de headers
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 0.2, green: 0.5, blue: 0.8 },
                textFormat: {
                  bold: true,
                  foregroundColor: { red: 1, green: 1, blue: 1 },
                },
              },
            },
            fields: "userEnteredFormat(backgroundColor,textFormat)",
          },
        },
        // Autoajustar ancho de columnas
        {
          autoResizeDimensions: {
            dimensions: {
              sheetId,
              dimension: "COLUMNS",
              startIndex: 0,
              endIndex: EXPECTED_HEADERS.length,
            },
          },
        },
      ],
    },
  });
  console.log("✅ Formato aplicado");

  console.log("\n════════════════════════════════════════════════════");
  console.log("Columnas en el Sheet ahora:");
  EXPECTED_HEADERS.forEach((h, i) => {
    const letter = String.fromCharCode(65 + i);
    const isNew = missing.includes(h) ? " ← NUEVA" : "";
    console.log(`  ${letter}  ${h}${isNew}`);
  });
  console.log("════════════════════════════════════════════════════");
  console.log("\n✅ Listo. Los datos existentes no fueron modificados.");
}

main().catch(err => { console.error(err); process.exit(1); });
