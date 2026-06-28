/**
 * setup-menu-sheet.ts
 *
 * Crea (o limpia) la hoja "Menu" en el Google Sheet y la llena con el
 * menú inicial de la cafetería.
 *
 * Uso:
 *   npx tsx scripts/setup-menu-sheet.ts
 *
 * Requiere que .env tenga GOOGLE_SHEETS_ID y
 * GOOGLE_SERVICE_ACCOUNT_KEY_JSON (o GOOGLE_CREDENTIALS_PATH).
 */

import { config } from "dotenv";
config();

import { google } from "googleapis";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ── Credenciales ────────────────────────────────────────────────────────────
const credJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON?.trim();
const credPath = process.env.GOOGLE_CREDENTIALS_PATH?.trim();
const credSource = credJson || credPath;

if (!credSource) {
  console.error(
    "❌  No se encontraron credenciales.\n" +
    "    Configura GOOGLE_SERVICE_ACCOUNT_KEY_JSON o GOOGLE_CREDENTIALS_PATH en .env",
  );
  process.exit(1);
}

const spreadsheetId = process.env.GOOGLE_SHEETS_ID?.trim();
if (!spreadsheetId) {
  console.error("❌  Falta GOOGLE_SHEETS_ID en .env");
  process.exit(1);
}

let credentials: object;
if (credSource.trim().startsWith("{")) {
  credentials = JSON.parse(credSource);
} else {
  credentials = JSON.parse(readFileSync(resolve(credSource), "utf8"));
}

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

// ── Datos del menú ───────────────────────────────────────────────────────────
// Columnas: categoria_num | categoria | categoria_foto | nombre | precio |
//           descripcion | imagen | disponible | extras | sin_opciones
const HEADER = [
  "categoria_num", "categoria", "categoria_foto",
  "nombre", "precio", "descripcion", "imagen",
  "disponible", "extras", "sin_opciones",
];

const MENU_DATA: string[][] = [
  // 01 — Bebidas Calientes  (foto: "Bebida Calientes.jpeg" — sin 's' en Bebida)
  ["01 / Café","Bebidas Calientes","Bebida Calientes.jpeg","Espresso","42","Doble shot, cuerpo intenso y aromático","Expresso.jpeg","TRUE","",""],
  ["01 / Café","Bebidas Calientes","Bebida Calientes.jpeg","Cortado","48","Espresso con un toque de leche tibia","Cortado.jpeg","TRUE","",""],
  ["01 / Café","Bebidas Calientes","Bebida Calientes.jpeg","Latte de Especialidad","62","Leche sedosa, arte latte de la casa","Latte Caliente.jpeg","TRUE","leche de avena, leche deslactosada, shot extra",""],
  ["01 / Café","Bebidas Calientes","Bebida Calientes.jpeg","Chocolate de la Casa","58","Cacao de Tabasco, leche espumada","Chocolate.jpeg","TRUE","leche de avena",""],
  // 02 — Bebidas Frías
  ["02 / Frío","Bebidas Frías","Bebidas Frias.jpg","Cold Brew","58","Extracción en frío de 18 horas","Cold Brew.jpeg","TRUE","leche, jarabe de vainilla",""],
  ["02 / Frío","Bebidas Frías","Bebidas Frias.jpg","Iced Latte","60","Espresso sobre hielo y leche fría","Ice Latte.jpeg","TRUE","leche de avena, shot extra",""],
  ["02 / Frío","Bebidas Frías","Bebidas Frias.jpg","Affogato","72","Helado de vainilla, espresso caliente","Affogato.jpeg","TRUE","",""],
  ["02 / Frío","Bebidas Frías","Bebidas Frias.jpg","Limonada de Temporada","54","Cítricos frescos, hierbas de la huerta","Limonada de Temporada.jpeg","TRUE","sin hielo",""],
  // 03 — Repostería
  ["03 / Horno","Repostería","Reposteria.jpeg","Croissant de Mantequilla","48","Hojaldre artesanal de tres días","Croissant de Mantequilla.jpg","TRUE","",""],
  ["03 / Horno","Repostería","Reposteria.jpeg","Pan de Plátano","52","Con nuez caramelizada y canela","Pan de Platano.jpeg","TRUE","","nuez"],
  ["03 / Horno","Repostería","Reposteria.jpeg","Tarta del Día","66","Pregunta por la selección de hoy","Tarta del Dia.jpeg","TRUE","",""],
  ["03 / Horno","Repostería","Reposteria.jpeg","Galleta de Avena","38","Avena, chocolate amargo, sal de mar","Galleta de Avena.jpeg","TRUE","","chocolate amargo"],
  ["03 / Horno","Repostería","Reposteria.jpeg","Rol de Canela","54","Canela, glasé de vainilla, horneado al momento","Rol de Canela.jpg","TRUE","glasé extra","glasé"],
  ["03 / Horno","Repostería","Reposteria.jpeg","Crepa Dulce","58","Nuez, cajeta, crema batida artesanal","Crepa Dulce.jpg","TRUE","crema extra","nuez, cajeta"],
  // 04 — Desayunos
  ["04 / Mesa","Desayunos","Desayunos.jpeg","Tostada de Aguacate","98","Masa madre, aguacate, semillas, limón","Tostada de aguacate.jpg","TRUE","","semillas"],
  ["04 / Mesa","Desayunos","Desayunos.jpeg","Omelette al Gusto","92","Dos huevos, pan de la casa, guarnición","Omelette al Gusto.jpeg","TRUE","queso, jamón, champiñones",""],
  ["04 / Mesa","Desayunos","Desayunos.jpeg","Bowl de Yogurt","76","Yogurt natural, granola, fruta de temporada","Bowl de Yogurt.jpeg","TRUE","","granola"],
  ["04 / Mesa","Desayunos","Desayunos.jpeg","Chilaquiles de la Casa","104","Salsa verde o roja, crema, queso fresco","Chilaquiles de la Casa.jpeg","TRUE","huevo estrellado","crema, queso"],
];

// ── Funciones de utilidad ───────────────────────────────────────────────────

async function getOrCreateMenuSheet(): Promise<number> {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = meta.data.sheets?.find(
    (s) => s.properties?.title === "Menu",
  );

  if (existing) {
    const sheetId = existing.properties!.sheetId!;
    console.log(`  Hoja "Menu" encontrada (id=${sheetId}). Limpiando contenido…`);

    // Clear existing content
    await sheets.spreadsheets.values.clear({
      spreadsheetId,
      range: "Menu",
    });
    return sheetId;
  }

  // Create new sheet named "Menu"
  console.log('  Hoja "Menu" no encontrada. Creando…');
  const addResp = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          addSheet: {
            properties: {
              title: "Menu",
              gridProperties: { rowCount: 200, columnCount: 10 },
            },
          },
        },
      ],
    },
  });
  const newSheetId =
    addResp.data.replies?.[0]?.addSheet?.properties?.sheetId ?? 0;
  console.log(`  Hoja "Menu" creada (id=${newSheetId}).`);
  return newSheetId;
}

async function writeData(): Promise<void> {
  const rows = [HEADER, ...MENU_DATA];
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: "Menu!A1",
    valueInputOption: "RAW",
    requestBody: { values: rows },
  });
  console.log(`  ${rows.length - 1} productos escritos (+ 1 fila de encabezado).`);
}

async function formatHeader(sheetId: number): Promise<void> {
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        // Bold header row
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
            cell: { userEnteredFormat: { textFormat: { bold: true } } },
            fields: "userEnteredFormat.textFormat.bold",
          },
        },
        // Freeze header row
        {
          updateSheetProperties: {
            properties: {
              sheetId,
              gridProperties: { frozenRowCount: 1 },
            },
            fields: "gridProperties.frozenRowCount",
          },
        },
        // Auto-resize all columns
        {
          autoResizeDimensions: {
            dimensions: {
              sheetId,
              dimension: "COLUMNS",
              startIndex: 0,
              endIndex: 10,
            },
          },
        },
      ],
    },
  });
  console.log("  Formato aplicado (negrita, fila congelada, columnas ajustadas).");
}

async function getOrCreateInstructionsSheet(): Promise<number> {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = meta.data.sheets?.find(
    (s) => s.properties?.title === "Instrucciones",
  );
  if (existing) return existing.properties!.sheetId!;

  const addResp = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{ addSheet: { properties: { title: "Instrucciones" } } }],
    },
  });
  return addResp.data.replies?.[0]?.addSheet?.properties?.sheetId ?? 0;
}

async function writeInstructions(sheetId: number): Promise<void> {
  const rows = [
    ["📋 GUÍA PARA EL GERENTE — Menú de Muna Café"],
    [],
    ["━━━  CÓMO AGREGAR UN PRODUCTO NUEVO  ━━━"],
    ["1. Ve a la hoja  Menu  (pestaña abajo)"],
    ["2. Agrega una nueva fila al final con estos datos:"],
    [],
    ["  Columna A — categoria_num", "Ej:  01 / Café   (usa uno de los existentes o crea uno nuevo)"],
    ["  Columna B — categoria",     "Ej:  Bebidas Calientes"],
    ["  Columna C — categoria_foto","Foto de portada de la categoría (ver sección IMÁGENES abajo)"],
    ["  Columna D — nombre",        "Nombre del producto  Ej:  Matcha Latte"],
    ["  Columna E — precio",        "Solo el número, sin $  Ej:  68"],
    ["  Columna F — descripcion",   "Descripción corta  Ej:  Matcha ceremonial, leche espumada"],
    ["  Columna G — imagen",        "Foto del producto (ver sección IMÁGENES abajo)"],
    ["  Columna H — disponible",    "TRUE = visible en menú  |  FALSE = oculto (sin borrar la fila)"],
    ["  Columna I — extras",        "Opciones que el cliente puede AGREGAR, separadas por coma"],
    ["                               Ej:  leche de avena, shot extra, jarabe de vainilla"],
    ["  Columna J — sin_opciones",  "Ingredientes que el cliente puede QUITAR, separados por coma"],
    ["                               Ej:  nuez, cajeta"],
    [],
    ["━━━  CÓMO CAMBIAR PRECIO O DESCRIPCIÓN  ━━━"],
    ["Simplemente edita la celda correspondiente en la hoja Menu."],
    ["La página web y el chatbot se actualizan solos en menos de 5 minutos."],
    [],
    ["━━━  CÓMO OCULTAR UN PRODUCTO TEMPORALMENTE  ━━━"],
    ["Cambia la columna H (disponible) de TRUE a FALSE."],
    ["El producto desaparece del menú y del chatbot sin borrarlo."],
    [],
    ["━━━  IMÁGENES — CÓMO SUBIR Y USAR  ━━━"],
    [],
    ["OPCIÓN A — Google Drive (recomendada para el gerente):"],
    ["  1. Abre esta carpeta en Drive: https://drive.google.com/  (crea una carpeta 'Menu Cafeteria')"],
    ["  2. Sube la foto (JPG o PNG, mínimo 400×400 px)"],
    ["  3. Haz clic derecho en la imagen → 'Compartir' → 'Cualquiera con el enlace puede ver'"],
    ["  4. Copia el enlace  (se ve así: https://drive.google.com/file/d/XXXXX/view?usp=sharing)"],
    ["  5. Pega ese enlace completo en la columna G (imagen) o C (categoria_foto) del Sheet"],
    ["  ✅ La web convierte automáticamente el link de Drive a imagen directa"],
    [],
    ["OPCIÓN B — Nombre de archivo local (solo si tienes acceso al repositorio de GitHub):"],
    ["  Sube la imagen a la carpeta Imagenes/ del repositorio y pon solo el nombre del archivo"],
    ["  Ej:  Matcha Latte.jpeg"],
    [],
    ["━━━  ORDEN EN EL MENÚ  ━━━"],
    ["Los productos aparecen en el orden de las filas del Sheet."],
    ["Reordena las filas para cambiar el orden en la página web."],
    [],
    ["━━━  CATEGORÍAS  ━━━"],
    ["Las categorías actuales son:"],
    ["  01 / Café  →  Bebidas Calientes"],
    ["  02 / Frío  →  Bebidas Frías"],
    ["  03 / Horno →  Repostería"],
    ["  04 / Mesa  →  Desayunos"],
    ["Para agregar una nueva categoría, usa un número nuevo (05 / Nueva) y un nombre nuevo."],
    ["Aparecerá automáticamente como sección nueva en la página web."],
  ];

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: "Instrucciones!A1",
    valueInputOption: "RAW",
    requestBody: { values: rows },
  });

  // Format title row
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
            cell: {
              userEnteredFormat: {
                textFormat: { bold: true, fontSize: 13 },
                backgroundColor: { red: 0.12, green: 0.12, blue: 0.12 },
              },
            },
            fields: "userEnteredFormat(textFormat,backgroundColor)",
          },
        },
        {
          autoResizeDimensions: {
            dimensions: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 2 },
          },
        },
      ],
    },
  });

  console.log("  Hoja 'Instrucciones' escrita.");
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("\n🚀 Configurando hoja de menú en Google Sheets…");
  console.log(`   Spreadsheet: ${spreadsheetId}\n`);

  const sheetId = await getOrCreateMenuSheet();
  await writeData();
  await formatHeader(sheetId);

  const instrSheetId = await getOrCreateInstructionsSheet();
  await writeInstructions(instrSheetId);

  console.log("\n✅ ¡Listo! El Sheet está configurado con menú e instrucciones.\n");
  console.log("El gerente solo necesita abrir la hoja 'Instrucciones' para saber qué hacer.\n");
}

main().catch((err) => {
  console.error("❌ Error:", err.message ?? err);
  process.exit(1);
});
