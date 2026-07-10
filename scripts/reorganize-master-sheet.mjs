/**
 * Reorganiza el Sheet maestro en secciones lógicas y lo hace más amigable:
 *  - Reordena las columnas agrupándolas por sección (Identificación, Servicios,
 *    Reservas, Horarios, Menú y web, Avanzado, Reseñas Google)
 *  - Casillas de verificación (checkbox) para whatsapp_enabled y reviews_enabled
 *  - Colores por sección en los encabezados + verde/rojo en los switches
 *  - Notas explicativas al pasar el cursor sobre cada encabezado
 *  - Congela la fila de encabezados y la columna del nombre
 *
 * Es seguro correrlo más de una vez (detecta el orden actual por nombre).
 *
 * Uso:  node scripts/reorganize-master-sheet.mjs
 */
import { config } from "dotenv";
config();
import { google } from "googleapis";

const SHEET_ID = process.env.MASTER_SHEET_ID;
if (!SHEET_ID) throw new Error("Falta MASTER_SHEET_ID en .env");

// ── Nuevo orden de columnas, agrupado por secciones ──────────────────────
// section: nombre visible, color de encabezado
const SECTIONS = [
  { name: "Identificación", color: { red: 0.17, green: 0.33, blue: 0.58 } },
  { name: "Servicios",      color: { red: 0.42, green: 0.27, blue: 0.60 } },
  { name: "Reservas",       color: { red: 0.18, green: 0.49, blue: 0.30 } },
  { name: "Horarios",       color: { red: 0.80, green: 0.47, blue: 0.13 } },
  { name: "Menú y web",     color: { red: 0.09, green: 0.45, blue: 0.50 } },
  { name: "Avanzado",       color: { red: 0.42, green: 0.42, blue: 0.42 } },
  { name: "Reseñas Google", color: { red: 0.70, green: 0.28, blue: 0.22 } },
];

const COLUMNS = [
  // header, sección (índice en SECTIONS), nota explicativa
  ["nombre",               0, "Nombre del restaurante tal como se presenta al cliente.\nEj: Muna Cafeteria"],
  ["restaurant_id",        0, "Identificador corto interno, sin espacios.\nEj: muna"],
  ["phone_number_id",      0, "phone_number_id del número de WhatsApp en Meta Business.\nSe obtiene en developers.facebook.com → WhatsApp → Configuración de API."],
  ["whatsapp_enabled",     1, "✅ = el agente contesta WhatsApp para este restaurante.\n⬜ = servicio de WhatsApp apagado (los mensajes se ignoran).\nEl cambio tarda máx. 5 minutos en aplicarse."],
  ["reservas_enabled",     1, "Método del chatbot: RESERVAS de mesa.\n✅ = el chatbot toma y cancela reservas.\n⬜ = si piden reservar, responde amablemente que no está disponible por este medio."],
  ["pedidos_enabled",      1, "Método del chatbot: PEDIDOS de comida.\n✅ = el chatbot toma pedidos (requiere menu_sheet_id).\n⬜ = si piden ordenar, responde amablemente que no está disponible por este medio."],
  ["reviews_enabled",      1, "✅ = el agente responde automáticamente las reseñas de Google.\nRequiere llenar gbp_account_id y gbp_location_id (sección Reseñas Google).\nEl cambio tarda máx. 5 minutos en aplicarse."],
  ["timezone",             2, "Zona horaria del restaurante.\nEj: America/Mexico_City"],
  ["calendar_id",          2, "ID del Google Calendar donde se crean las reservas\n(normalmente el correo de la cuenta)."],
  ["human_phone",          2, "Teléfono del encargado para escalaciones y reseñas negativas.\nEj: +52-312-111-6210"],
  ["cancellation_policy",  2, "Política de cancelación que se muestra al confirmar una reserva."],
  ["slot_duration",        2, "Duración de cada reserva en minutos.\nEj: 90"],
  ["capacity",             2, "Personas máximas por turno.\nEj: 30"],
  ["quota",                2, "Fracción de la capacidad reservable por el bot (0 a 1).\nEj: 0.8 = el bot puede llenar hasta el 80%"],
  ["max_group",            2, "Grupo máximo que el bot confirma solo; grupos más grandes se escalan al encargado.\nEj: 8"],
  ["lunes",                3, "Horario del día en formato HH:MM-HH:MM, o closed si no abre.\nEj: 7:00-16:00"],
  ["martes",               3, "Horario del día en formato HH:MM-HH:MM, o closed."],
  ["miercoles",            3, "Horario del día en formato HH:MM-HH:MM, o closed."],
  ["jueves",               3, "Horario del día en formato HH:MM-HH:MM, o closed."],
  ["viernes",              3, "Horario del día en formato HH:MM-HH:MM, o closed."],
  ["sabado",               3, "Horario del día en formato HH:MM-HH:MM, o closed."],
  ["domingo",              3, "Horario del día en formato HH:MM-HH:MM, o closed."],
  ["menu_sheet_id",        4, "ID del Google Sheet con el menú (el texto largo de la URL del Sheet)."],
  ["menu_web_url",         4, "URL pública donde el cliente arma su pedido."],
  ["website_url",          4, "Sitio web del restaurante (se comparte tras confirmar)."],
  ["faq",                  5, "Preguntas frecuentes en formato JSON:\n{\"patrón|palabras|clave\": \"respuesta\"}"],
  ["crm_webhook_url",      5, "URL de webhook para enviar reservas/pedidos al CRM del restaurante (opcional)."],
  ["gbp_account_id",       6, "ID de la cuenta de Google Business Profile.\nRequisito: agregar la service account como Administrador del perfil."],
  ["gbp_location_id",      6, "ID de la ubicación (sucursal) en Google Business Profile."],
  ["reviews_tono",         6, "Instrucciones de tono para responder reseñas.\nEj: Tono cálido y cercano, estilo cafetería saludable."],
  ["reviews_poll_minutes", 6, "Cada cuántos minutos se revisan reseñas nuevas.\nEj: 1440 = una vez al día"],
];

const CHECKBOX_HEADERS = ["whatsapp_enabled", "reservas_enabled", "pedidos_enabled", "reviews_enabled"];
// Al crear una columna checkbox nueva, estos valores se usan como default
const CHECKBOX_DEFAULTS = { whatsapp_enabled: true, reservas_enabled: true, pedidos_enabled: true, reviews_enabled: false };
const MAX_ROWS = 100;

const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON);
const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

function colLetter(i) {
  return i < 26 ? String.fromCharCode(65 + i) : "A" + String.fromCharCode(65 + i - 26);
}

async function main() {
  // ── 1. Leer datos actuales y re-mapear por nombre de encabezado ────────
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `Restaurantes!A1:AZ${MAX_ROWS}`,
  });
  const rows = res.data.values ?? [];
  const oldHeaders = (rows[0] ?? []).map((h) => String(h).trim().toLowerCase());
  // Una fila cuenta como dato real solo si tiene contenido fuera de los checkboxes
  // (las celdas checkbox vacías devuelven "FALSE" aunque la fila esté vacía)
  const dataRows = rows.slice(1).filter((r) =>
    r.some((c, i) => !CHECKBOX_HEADERS.includes(oldHeaders[i]) && String(c).trim() !== ""),
  );
  console.log(`Leídas ${dataRows.length} fila(s) de datos con ${oldHeaders.length} columnas`);

  const newHeaders = COLUMNS.map(([h]) => h);
  const remapped = dataRows.map((row) =>
    newHeaders.map((h) => {
      const oldIdx = oldHeaders.indexOf(h);
      // Checkboxes necesitan booleanos reales, no texto "TRUE"/"FALSE"
      if (CHECKBOX_HEADERS.includes(h)) {
        if (oldIdx === -1) return CHECKBOX_DEFAULTS[h] ?? true; // columna nueva → default
        return /^(true|sí|si|yes|1)$/i.test(String(row[oldIdx] ?? "").trim());
      }
      return oldIdx === -1 ? "" : (row[oldIdx] ?? "");
    }),
  );

  // ── 2. Escribir la cuadrícula en el nuevo orden ─────────────────────────
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID,
    range: `Restaurantes!A1:AZ${MAX_ROWS}`,
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: "Restaurantes!A1",
    valueInputOption: "RAW",
    requestBody: { values: [newHeaders, ...remapped] },
  });
  console.log("✅ Columnas reordenadas por sección");

  // ── 3. Formato ──────────────────────────────────────────────────────────
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const sheetId = meta.data.sheets.find((s) => s.properties.title === "Restaurantes")
    ?.properties?.sheetId ?? 0;

  const requests = [];

  // Encabezados: color por sección + nota explicativa
  COLUMNS.forEach(([header, sectionIdx, note], i) => {
    requests.push({
      updateCells: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: i, endColumnIndex: i + 1 },
        rows: [{
          values: [{
            userEnteredValue: { stringValue: header },
            note: `【${SECTIONS[sectionIdx].name}】\n\n${note}`,
            userEnteredFormat: {
              backgroundColor: SECTIONS[sectionIdx].color,
              textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
              horizontalAlignment: "CENTER",
              wrapStrategy: "WRAP",
            },
          }],
        }],
        fields: "userEnteredValue,note,userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,wrapStrategy)",
      },
    });
  });

  // Checkboxes en las columnas de servicios
  for (const header of CHECKBOX_HEADERS) {
    const i = newHeaders.indexOf(header);
    requests.push({
      setDataValidation: {
        range: { sheetId, startRowIndex: 1, endRowIndex: MAX_ROWS, startColumnIndex: i, endColumnIndex: i + 1 },
        rule: { condition: { type: "BOOLEAN" }, strict: true, showCustomUi: true },
      },
    });
    // Verde cuando está activo, gris tenue cuando está apagado
    requests.push({
      addConditionalFormatRule: {
        rule: {
          ranges: [{ sheetId, startRowIndex: 1, endRowIndex: MAX_ROWS, startColumnIndex: i, endColumnIndex: i + 1 }],
          booleanRule: {
            condition: { type: "TEXT_EQ", values: [{ userEnteredValue: "TRUE" }] },
            format: { backgroundColor: { red: 0.82, green: 0.94, blue: 0.83 } },
          },
        },
        index: 0,
      },
    });
    requests.push({
      addConditionalFormatRule: {
        rule: {
          ranges: [{ sheetId, startRowIndex: 1, endRowIndex: MAX_ROWS, startColumnIndex: i, endColumnIndex: i + 1 }],
          booleanRule: {
            condition: { type: "TEXT_EQ", values: [{ userEnteredValue: "FALSE" }] },
            format: { backgroundColor: { red: 0.96, green: 0.87, blue: 0.86 } },
          },
        },
        index: 1,
      },
    });
  }

  // phone_number_id como texto plano (evita notación científica)
  const phoneIdx = newHeaders.indexOf("phone_number_id");
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 1, endRowIndex: MAX_ROWS, startColumnIndex: phoneIdx, endColumnIndex: phoneIdx + 1 },
      cell: { userEnteredFormat: { numberFormat: { type: "TEXT" } } },
      fields: "userEnteredFormat.numberFormat",
    },
  });

  // Congelar fila de encabezados y columna del nombre
  requests.push({
    updateSheetProperties: {
      properties: { sheetId, gridProperties: { frozenRowCount: 1, frozenColumnCount: 1 } },
      fields: "gridProperties(frozenRowCount,frozenColumnCount)",
    },
  });

  // Autoajustar anchos y luego fijar ancho de las columnas de texto largo
  requests.push({
    autoResizeDimensions: {
      dimensions: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: newHeaders.length },
    },
  });
  for (const wide of ["cancellation_policy", "faq", "reviews_tono", "menu_web_url", "website_url", "menu_sheet_id"]) {
    const i = newHeaders.indexOf(wide);
    requests.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: "COLUMNS", startIndex: i, endIndex: i + 1 },
        properties: { pixelSize: 200 },
        fields: "pixelSize",
      },
    });
  }

  await sheets.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, requestBody: { requests } });
  console.log("✅ Formato aplicado (secciones, checkboxes, notas, congelado)");

  // ── 4. Resumen ──────────────────────────────────────────────────────────
  console.log("\n════════════════════════════════════════════════════");
  let lastSection = -1;
  COLUMNS.forEach(([h, s], i) => {
    if (s !== lastSection) {
      console.log(`\n  ── ${SECTIONS[s].name} ──`);
      lastSection = s;
    }
    console.log(`  ${colLetter(i).padEnd(3)} ${h}`);
  });
  console.log("\n════════════════════════════════════════════════════");
  console.log(`✅ Listo: ${dataRows.length} restaurante(s) migrado(s) al nuevo orden.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
