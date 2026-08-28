const { SHEET_NAMES, SPREADSHEET_ID } = require('./sheets');

/**
 * Audit log tidak boleh pernah menggagalkan operasi utama (simpan/hapus).
 * Kalau gagal menulis log, cukup dicatat ke console (muncul di Vercel
 * Logs), bukan dilempar sebagai error ke pengguna.
 */
async function writeAuditLog(sheets, action, detail, user) {
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${SHEET_NAMES.AUDIT}'!A2`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [[new Date().toISOString(), user || 'web-app', action, detail || '']]
      }
    });
  } catch (e) {
    console.error('Gagal menulis audit log:', e.message);
  }
}

module.exports = { writeAuditLog };
