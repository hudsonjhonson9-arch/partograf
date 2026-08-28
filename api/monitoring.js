const { getSheetsClient, ensureSheetsReady, getSheetIdByName, SHEET_NAMES, SPREADSHEET_ID } = require('../lib/sheets');
const { validateMonitoringPayload, parseDateSafe, hitungSkor, KOMPONEN_TEPAT } = require('../lib/validation');
const { writeAuditLog } = require('../lib/audit');

module.exports = async (req, res) => {
  try {
    await ensureSheetsReady();
    const sheets = await getSheetsClient();

    if (req.method === 'GET') {
      return await handleList(req, res, sheets);
    }
    if (req.method === 'POST') {
      return await handleSave(req, res, sheets);
    }
    if (req.method === 'DELETE') {
      return await handleDelete(req, res, sheets);
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'Method tidak didukung.' });

  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'Terjadi kesalahan pada server.' });
  }
};

/**
 * Membaca seluruh baris data monitoring lalu menghitung ulang Skor dan
 * Status Kepatuhan langsung di server (menggantikan formula spreadsheet
 * pada versi Apps Script). Baris tanpa kode Partograf diabaikan.
 */
async function readAllRows(sheets) {
  const range = `'${SHEET_NAMES.DATA}'!A2:M`;
  const result = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range });
  const rows = result.data.values || [];

  return rows
    .map((row, i) => {
      const kode = (row[2] || '').trim();
      if (!kode) {
        return null;
      }

      const nilai = {
        tertib: row[4] || '',
        efektif: row[5] || '',
        profesional: row[6] || '',
        akurat: row[7] || '',
        tepatWaktu: row[8] || ''
      };

      const skor = hitungSkor(nilai);
      const statusKepatuhan = skor === 5 ? 'PATUH' : 'BELUM PATUH';

      return {
        no: null, // diisi ulang setelah filter, lihat handleList
        rowNumber: i + 2, // posisi baris asli di sheet (untuk hapus)
        tanggal: row[1] || '',
        kode,
        bidan: row[3] || '',
        tertib: nilai.tertib,
        efektif: nilai.efektif,
        profesional: nilai.profesional,
        akurat: nilai.akurat,
        tepatWaktu: nilai.tepatWaktu,
        skor,
        statusKepatuhan,
        statusMonitoring: (row[11] || '').trim().toUpperCase(),
        keterangan: row[12] || ''
      };
    })
    .filter(Boolean);
}

function applyFilter(rows, query) {
  const dari = query.tanggalDari ? parseDateSafe(query.tanggalDari) : null;
  const sampai = query.tanggalSampai ? parseDateSafe(query.tanggalSampai) : null;
  const status = (query.status || '').trim().toUpperCase();
  const bidan = (query.bidan || '').trim().toLowerCase();
  const kode = (query.kode || '').trim().toLowerCase();

  return rows.filter(r => {
    if (status && r.statusMonitoring !== status) return false;
    if (bidan && !r.bidan.toLowerCase().includes(bidan)) return false;
    if (kode && !r.kode.toLowerCase().includes(kode)) return false;

    if (dari || sampai) {
      const d = parseDateSafe(r.tanggal);
      if (!d) return false;
      if (dari && d < dari) return false;
      if (sampai && d > sampai) return false;
    }

    return true;
  });
}

async function handleList(req, res, sheets) {
  const all = await readAllRows(sheets);
  const filtered = applyFilter(all, req.query || {});

  // Nomor urut tampilan mengikuti posisi kronologis asli di sheet,
  // supaya tetap konsisten walaupun sedang difilter.
  filtered.forEach(r => { r.no = r.rowNumber - 1; });

  res.status(200).json(filtered);
}

async function handleSave(req, res, sheets) {
  const data = req.body || {};

  const errors = validateMonitoringPayload(data);
  if (errors.length > 0) {
    return res.status(400).json({ error: errors.join(' ') });
  }

  const kode = String(data.kode).trim();
  const status = String(data.status).trim().toUpperCase();

  const all = await readAllRows(sheets);
  const duplikat = all.some(r =>
    r.kode.toLowerCase() === kode.toLowerCase() && r.statusMonitoring === status
  );

  if (duplikat) {
    return res.status(409).json({
      error: `Kode Partograf "${kode}" sudah tercatat untuk status ${status}. ` +
             'Gunakan kode yang berbeda atau perbarui data yang sudah ada.'
    });
  }

  const skor = hitungSkor(data);
  const statusKepatuhan = skor === 5 ? 'PATUH' : 'BELUM PATUH';
  const tanggal = parseDateSafe(data.tanggal);
  const tanggalStr = tanggal.toISOString().slice(0, 10);
  const keterangan = data.keterangan ? String(data.keterangan).trim() : '';

  const values = [[
    all.length + 1,
    tanggalStr,
    kode,
    String(data.bidan).trim(),
    data.tertib,
    data.efektif,
    data.profesional,
    data.akurat,
    data.tepatWaktu,
    skor,
    statusKepatuhan,
    status,
    keterangan
  ]];

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${SHEET_NAMES.DATA}'!A2`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values }
  });

  await writeAuditLog(sheets, 'SIMPAN_MONITORING',
    `Kode=${kode}; Status=${status}; Skor=${skor}/5; Bidan=${data.bidan}`
  );

  res.status(200).json({
    success: true,
    message: 'Data monitoring berhasil disimpan.',
    skor,
    statusKepatuhan
  });
}

async function handleDelete(req, res, sheets) {
  const rowNumber = Number((req.query || {}).row);

  if (!Number.isInteger(rowNumber) || rowNumber < 2) {
    return res.status(400).json({ error: 'Baris tidak valid.' });
  }

  const checkRange = `'${SHEET_NAMES.DATA}'!C${rowNumber}`;
  const check = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: checkRange });
  const kodeCell = (check.data.values && check.data.values[0] && check.data.values[0][0]) || '';

  if (!kodeCell) {
    return res.status(404).json({ error: 'Baris ini tidak berisi data monitoring atau sudah dihapus.' });
  }

  const sheetId = await getSheetIdByName(sheets, SHEET_NAMES.DATA);

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: {
            sheetId,
            dimension: 'ROWS',
            startIndex: rowNumber - 1, // 0-based, sesuai posisi baris di sheet
            endIndex: rowNumber
          }
        }
      }]
    }
  });

  await writeAuditLog(sheets, 'HAPUS_MONITORING', `Baris=${rowNumber}; Kode=${kodeCell}`);

  res.status(200).json({ success: true, message: 'Data berhasil dihapus.' });
}
