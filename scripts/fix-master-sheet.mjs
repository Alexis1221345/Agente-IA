/**
 * Fixes the master sheet after creation:
 * - Overwrites phone_number_id as plain text (Google converts large numbers to scientific notation)
 * - Validates the FAQ JSON
 *
 * Run AFTER sharing the sheet with the service account:
 *   node scripts/fix-master-sheet.mjs
 */
import { config } from "dotenv";
config();
import { google } from "googleapis";

const SHEET_ID = process.env.MASTER_SHEET_ID;
if (!SHEET_ID) throw new Error("Falta MASTER_SHEET_ID en .env");

const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON);
const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

async function main() {
  // Discover the real tab name (CSV import may name it differently)
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const firstTab = meta.data.sheets[0].properties.title;
  console.log(`Tab encontrado: "${firstTab}"`);

  // Rename to "Restaurantes" if needed
  if (firstTab !== "Restaurantes") {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        requests: [{
          updateSheetProperties: {
            properties: { sheetId: meta.data.sheets[0].properties.sheetId, title: "Restaurantes" },
            fields: "title",
          },
        }],
      },
    });
    console.log(`✅ Tab renombrado: "${firstTab}" → "Restaurantes"`);
  }

  // Read current data
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "Restaurantes!A1:V100",
  });
  const rows = res.data.values ?? [];
  console.log(`Filas encontradas: ${rows.length}`);
  if (rows.length < 2) throw new Error("Sheet vacío o sin datos");

  const headers = rows[0];
  console.log("Columnas:", headers.join(", "));

  // Find phone_number_id column
  const phoneCol = headers.indexOf("phone_number_id");
  if (phoneCol === -1) throw new Error("No se encontró columna phone_number_id");

  // Fix all data rows: force phone_number_id to text and validate FAQ
  const faqCol = headers.indexOf("faq");
  const updates = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const phoneRaw = row[phoneCol];

    if (!phoneRaw) continue;

    // Convert scientific notation to integer string
    let phoneFixed = phoneRaw;
    if (/e\+/i.test(phoneRaw) || phoneRaw.includes("E+")) {
      phoneFixed = String(BigInt(Math.round(Number(phoneRaw))));
      console.log(`Fila ${i + 1}: phone_number_id corregido: ${phoneRaw} → ${phoneFixed}`);
    }

    // Update the cell as plain text
    const colLetter = String.fromCharCode(65 + phoneCol); // A=65
    updates.push({
      range: `Restaurantes!${colLetter}${i + 1}`,
      values: [[phoneFixed]],
    });

    // Validate FAQ JSON
    if (faqCol !== -1) {
      const faqRaw = row[faqCol];
      try {
        JSON.parse(faqRaw);
        console.log(`Fila ${i + 1}: FAQ JSON válido ✅`);
      } catch {
        console.warn(`Fila ${i + 1}: FAQ JSON inválido ⚠️  → "${faqRaw?.slice(0, 80)}..."`);
      }
    }
  }

  if (updates.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        valueInputOption: "RAW",
        data: updates,
      },
    });
    console.log("✅ phone_number_id corregido como texto plano");
  } else {
    console.log("ℹ️  No se necesitaron correcciones");
  }

  // Set phone_number_id column format to Plain Text to prevent future auto-conversion
  const sheetId = meta.data.sheets[0].properties.sheetId;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: [{
        repeatCell: {
          range: {
            sheetId,
            startRowIndex: 1,
            startColumnIndex: phoneCol,
            endColumnIndex: phoneCol + 1,
          },
          cell: {
            userEnteredFormat: {
              numberFormat: { type: "TEXT" },
            },
          },
          fields: "userEnteredFormat.numberFormat",
        },
      }],
    },
  });
  console.log("✅ Columna phone_number_id marcada como Texto");
  console.log("\n✅ Sheet listo para usarse.");
}

main().catch(err => { console.error(err); process.exit(1); });
