const { getSheetsClient, ensureSheetsReady, SHEET_NAMES, SPREADSHEET_ID } = require('../lib/sheets');
const { hitungSkor } = require('../lib/validation');

module.exports = async (req, res) => {
  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ error: 'Method tidak didukung.' });
    }

    await ensureSheetsReady();
    const sheets = await getSheetsClient();

    const range = `'${SHEET_NAMES.DATA}'!A2:M`;
    const result = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range });
    const rows = (result.data.values || []).filter(r => (r[2] || '').trim());

    function agg(statusTarget) {
      const subset = rows.filter(r => (r[11] || '').trim().toUpperCase() === statusTarget);

      const jumlah = subset.length;
      const patuh = subset.filter(r => {
        const skor = hitungSkor({
          tertib: r[4], efektif: r[5], profesional: r[6], akurat: r[7], tepatWaktu: r[8]
        });
        return skor === 5;
      }).length;
      const belumPatuh = jumlah - patuh;
      const persentase = jumlah > 0 ? patuh / jumlah : 0;

      return { jumlah, patuh, belumPatuh, persentase };
    }

    const sebelum = agg('SEBELUM');
    const sesudah = agg('SESUDAH');
    const peningkatan = sesudah.persentase - sebelum.persentase;

    res.status(200).json({ sebelum, sesudah, peningkatan });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Terjadi kesalahan pada server.' });
  }
};
