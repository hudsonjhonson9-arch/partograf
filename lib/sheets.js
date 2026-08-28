const { google } = require('googleapis');

const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;

const SHEET_NAMES = {
  DATA: 'DATA MONITORING',
  CHECKLIST: 'CHECKLIST TEPAT',
  AUDIT: 'AUDIT_LOG'
};

const DATA_HEADERS = [
  'No', 'Tanggal', 'Kode Partograf', 'Inisial Bidan', 'Tertib', 'Efektif',
  'Profesional', 'Akurat', 'Tepat Waktu', 'Skor TEPAT', 'Status Kepatuhan',
  'Status Monitoring', 'Keterangan'
];

const AUDIT_HEADERS = ['Waktu', 'User', 'Aktivitas', 'Detail'];

const CHECKLIST_DATA = [
  ['No', 'Komponen', 'Indikator Monitoring', 'Skor Ya', 'Skor Tidak'],
  [1, 'Tertib', 'Partograf diisi sesuai tahapan dan tidak ada bagian penting yang terlewat', 1, 0],
  [2, 'Efektif', 'Pengisian mendukung pemantauan kemajuan persalinan dan pengambilan keputusan', 1, 0],
  [3, 'Profesional', 'Dokumentasi jelas, konsisten, dan sesuai standar pelayanan', 1, 0],
  [4, 'Akurat', 'Data hasil pemantauan dicatat sesuai kondisi atau hasil pemeriksaan', 1, 0],
  [5, 'Tepat Waktu', 'Pengisian dilakukan sesuai waktu pemantauan yang ditetapkan', 1, 0]
];

let cachedClient = null;
let readyPromise = null;

/**
 * Autentikasi ke Google Sheets API memakai Service Account.
 * GOOGLE_PRIVATE_KEY di environment variable Vercel biasanya menyimpan
 * "\n" literal (bukan baris baru sungguhan), jadi perlu di-decode dulu.
 */
function getAuth() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawKey = process.env.GOOGLE_PRIVATE_KEY;

  if (!email || !rawKey) {
    throw new Error(
      'Konfigurasi belum lengkap: GOOGLE_SERVICE_ACCOUNT_EMAIL dan/atau GOOGLE_PRIVATE_KEY ' +
      'belum diatur di Environment Variables Vercel.'
    );
  }

  if (!SPREADSHEET_ID) {
    throw new Error('Konfigurasi belum lengkap: GOOGLE_SHEET_ID belum diatur di Environment Variables Vercel.');
  }

  const key = rawKey.replace(/\\n/g, '\n');

  return new google.auth.JWT(email, null, key, ['https://www.googleapis.com/auth/spreadsheets']);
}

async function getSheetsClient() {
  if (cachedClient) {
    return cachedClient;
  }
  const auth = getAuth();
  await auth.authorize();
  cachedClient = google.sheets({ version: 'v4', auth });
  return cachedClient;
}

function colLetter(n) {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

async function ensureHeaderRow(sheets, sheetName, headers) {
  const range = `'${sheetName}'!A1:${colLetter(headers.length)}1`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range });
  const row = (res.data.values && res.data.values[0]) || [];
  if (row.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range,
      valueInputOption: 'RAW',
      requestBody: { values: [headers] }
    });
  }
}

async function ensureChecklistData(sheets) {
  const range = `'${SHEET_NAMES.CHECKLIST}'!A1:E1`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range });
  const row = (res.data.values && res.data.values[0]) || [];
  if (row.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${SHEET_NAMES.CHECKLIST}'!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: CHECKLIST_DATA }
    });
  }
}

/**
 * Memastikan sheet DATA MONITORING, CHECKLIST TEPAT, dan AUDIT_LOG ada
 * beserta header-nya. Dijalankan ringan (hanya baca metadata sekali per
 * cold start berkat cache di bawah), TIDAK pernah melakukan loop
 * penulisan formula per-baris seperti versi Apps Script sebelumnya —
 * itulah yang dulu membuat dashboard "loading" tanpa henti.
 */
async function ensureSheetsReady() {
  if (readyPromise) {
    return readyPromise;
  }

  readyPromise = (async () => {
    const sheets = await getSheetsClient();

    const meta = await sheets.spreadsheets.get({
      spreadsheetId: SPREADSHEET_ID,
      fields: 'sheets.properties'
    });

    const existingNames = meta.data.sheets.map(s => s.properties.title);
    const requests = [];

    Object.values(SHEET_NAMES).forEach(name => {
      if (!existingNames.includes(name)) {
        requests.push({ addSheet: { properties: { title: name } } });
      }
    });

    if (requests.length) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: { requests }
      });
    }

    await ensureHeaderRow(sheets, SHEET_NAMES.DATA, DATA_HEADERS);
    await ensureHeaderRow(sheets, SHEET_NAMES.AUDIT, AUDIT_HEADERS);
    await ensureChecklistData(sheets);

    return sheets;
  })().catch(err => {
    // Jangan simpan promise yang gagal — biar percobaan berikutnya bisa retry,
    // bukan terus-menerus melempar error lama yang sama.
    readyPromise = null;
    throw err;
  });

  return readyPromise;
}

async function getSheetIdByName(sheets, sheetName) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
    fields: 'sheets.properties'
  });
  const found = meta.data.sheets.find(s => s.properties.title === sheetName);
  if (!found) {
    throw new Error(`Sheet "${sheetName}" tidak ditemukan.`);
  }
  return found.properties.sheetId;
}

module.exports = {
  SPREADSHEET_ID,
  SHEET_NAMES,
  DATA_HEADERS,
  getSheetsClient,
  ensureSheetsReady,
  getSheetIdByName,
  colLetter
};
