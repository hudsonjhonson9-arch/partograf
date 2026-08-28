const { ensureSheetsReady, SPREADSHEET_ID } = require('../lib/sheets');

module.exports = async (req, res) => {
  const checks = {
    GOOGLE_SHEET_ID: !!process.env.GOOGLE_SHEET_ID,
    GOOGLE_SERVICE_ACCOUNT_EMAIL: !!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    GOOGLE_PRIVATE_KEY: !!process.env.GOOGLE_PRIVATE_KEY
  };

  const missing = Object.keys(checks).filter(k => !checks[k]);

  if (missing.length > 0) {
    return res.status(500).json({
      ok: false,
      error: 'Environment variable belum lengkap: ' + missing.join(', '),
      checks
    });
  }

  try {
    await ensureSheetsReady();
    return res.status(200).json({
      ok: true,
      message: 'Terhubung ke Google Sheets.',
      spreadsheetId: SPREADSHEET_ID,
      checks
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e.message || 'Gagal terhubung ke Google Sheets.',
      checks
    });
  }
};
