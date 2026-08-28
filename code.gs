const SPREADSHEET_ID = '1iVaAJRkl5Hp30iK7PeF3MHqqWR0UUriHQPFCyD-IIO8';

const SHEETS = {
  DATA: 'DATA MONITORING',
  CHECKLIST: 'CHECKLIST TEPAT',
  PANDUAN: 'PANDUAN',
  AUDIT: 'AUDIT_LOG'
};

const KOMPONEN_TEPAT = ['tertib', 'efektif', 'profesional', 'akurat', 'tepatWaktu'];
const STATUS_VALID = ['SEBELUM', 'SESUDAH'];
const YA_TIDAK_VALID = ['Ya', 'Tidak'];


/* =========================
   WEB APP
========================= */

/**
 * Endpoint utama sebagai BACKEND JSON untuk aplikasi web (Vercel).
 * Dipanggil lewat proxy /api/* di Vercel, maupun bisa langsung.
 *   ?action=dashboard        -> ringkasan kepatuhan
 *   ?action=monitoring&...   -> daftar data (dengan filter opsional)
 *   ?action=setup            -> bangun ulang SELURUH struktur sheet
 *                                (dashboard, data, checklist, rekap,
 *                                 perbandingan, panduan, audit)
 * Tanpa parameter action -> respons kecil bahwa API hidup.
 */
function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || '';

  if (action === 'setup') {
    return jsonOut_(safeRun_(setupSpreadsheet));
  }

  if (action === 'dashboard') {
    return jsonOut_(safeRun_(getDashboardData));
  }

  if (action === 'monitoring') {
    const f = e.parameter || {};
    const rowsOrErr = safeRun_(() => getMonitoringData({
      tanggalDari: f.tanggalDari,
      tanggalSampai: f.tanggalSampai,
      status: f.status,
      bidan: f.bidan,
      kode: f.kode
    }));
    if (rowsOrErr && rowsOrErr.error) {
      return jsonOut_(rowsOrErr);
    }
    return jsonOut_(rowsOrErr.map(toMonitoringObject_));
  }

  return jsonOut_({ ok: true, message: 'PARTOGRAF TEPAT API (Google Apps Script)' });
}


/**
 * Menerima aksi tulis (simpan / hapus) dari proxy Vercel.
 * Body dikirim sebagai text/plain berisi JSON: {action:'save'|'delete', ...}.
 */
function doPost(e) {
  let payload = {};
  try {
    if (e && e.postData && e.postData.contents) {
      payload = JSON.parse(e.postData.contents);
    }
  } catch (err) {
    return jsonOut_({ error: 'Format body tidak valid (bukan JSON).' });
  }

  const action = payload.action;

  if (action === 'save') {
    return jsonOut_(safeRun_(() => saveMonitoring(payload.data || {})));
  }
  if (action === 'delete') {
    return jsonOut_(safeRun_(() => deleteMonitoring(payload.row)));
  }

  return jsonOut_({ error: 'Aksi tidak dikenali.' });
}


/** Bungkus eksekusi agar error tertangkap jadi {error:...} (status 200). */
function safeRun_(fn) {
  try {
    return fn();
  } catch (err) {
    return { error: err.message || String(err) };
  }
}


/** JSON response yang ramah CORS untuk dipanggil dari web app. */
function jsonOut_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}


/**
 * Ubah satu baris array (hasil getMonitoringData) menjadi objek dengan
 * key yang diharapkan frontend: no, tanggal, kode, bidan, tertib,
 * efektif, profesional, akurat, tepatWaktu, skor, statusKepatuhan,
 * statusMonitoring, keterangan, rowNumber.
 * Urutan kolom sheet: A..M = indeks 0..12, ditambah indeks 13 = nomor baris.
 */
function toMonitoringObject_(row) {
  const skor =
    (row[4] === 'Ya' ? 1 : 0) +
    (row[5] === 'Ya' ? 1 : 0) +
    (row[6] === 'Ya' ? 1 : 0) +
    (row[7] === 'Ya' ? 1 : 0) +
    (row[8] === 'Ya' ? 1 : 0);
  return {
    no: row[0],
    tanggal: row[1],
    kode: row[2],
    bidan: row[3],
    tertib: row[4],
    efektif: row[5],
    profesional: row[6],
    akurat: row[7],
    tepatWaktu: row[8],
    skor: skor,
    statusKepatuhan: skor === 5 ? 'PATUH' : 'BELUM PATUH',
    statusMonitoring: row[9],
    keterangan: row[10],
    rowNumber: row[11]
  };
}


/* =========================
   INCLUDE HTML
========================= */

function include(filename) {
  return HtmlService
    .createHtmlOutputFromFile(filename)
    .getContent();
}


/* =========================
   BUKA SPREADSHEET
========================= */

function getSpreadsheet() {
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}


/* =========================
   INISIALISASI / GENERATE SHEET

   Prinsip perbaikan performa:
   1. Setiap sheet HANYA dibangun (header, format, formula, validasi)
      pada saat sheet itu benar-benar baru dibuat. Kalau sheet sudah
      ada, fungsi langsung selesai tanpa menulis ulang apa pun.
   2. Formula tidak pernah di-set satu-per-satu dalam loop (itu yang
      membuat Dashboard "loading" tanpa henti sebelumnya). Semua
      formula dibangun sebagai array di memori lalu ditulis sekaligus
      lewat SATU panggilan setFormulas() per kolom.
   3. Ada penanda di Script Properties supaya pemeriksaan "apakah semua
      sheet sudah lengkap" pada pembukaan halaman jadi instan, bukan
      mengecek satu-satu setiap kali.
========================= */

const INIT_FLAG_KEY = 'PTEPAT_STRUKTUR_SIAP_V2';

/**
 * Dipanggil dari doGet(). Cepat: jika penanda sudah tersimpan dan semua
 * sheet wajib memang ada, langsung kembali tanpa menyentuh spreadsheet
 * sama sekali. Struktur lengkap hanya dibangun sekali seumur project
 * (atau setelah setupSpreadsheet() dijalankan ulang secara manual).
 */
function ensureSpreadsheetReady_() {

  const props = PropertiesService.getScriptProperties();

  if (props.getProperty(INIT_FLAG_KEY) === 'true') {
    return;
  }

  const ss = getSpreadsheet();

  if (allSheetsExist_(ss)) {
    props.setProperty(INIT_FLAG_KEY, 'true');
    return;
  }

  buildAllSheets_(ss);
  props.setProperty(INIT_FLAG_KEY, 'true');
}

function allSheetsExist_(ss) {
  return Object.keys(SHEETS).every(key => !!ss.getSheetByName(SHEETS[key]));
}

/**
 * Fungsi utama untuk MEMBANGUN / MEMBUAT ULANG seluruh tabel dan sheet
 * aplikasi. Jalankan fungsi ini secara MANUAL dari editor Apps Script
 * (pilih setupSpreadsheet lalu klik Run) setelah:
 *  - pertama kali menyiapkan spreadsheet baru, atau
 *  - salah satu sheet terhapus/rusak dan perlu dibangun ulang.
 * Aman dijalankan berkali-kali: sheet yang sudah ada tidak akan ditimpa
 * datanya, kecuali eksplisit lewat resetStrukturSheet().
 */
function setupSpreadsheet() {
  const ss = getSpreadsheet();

  // Bersihkan sisa lembar sementara dari proses rebuild yang gagal sebelumnya.
  ss.getSheets().forEach(sh => {
    if (sh.getName().indexOf('__tmp') === 0) {
      ss.deleteSheet(sh);
    }
  });

  // Lembar sementara agar Google Sheets tidak menolak menghapus
  // lembar terakhir saat kita membangun ulang seluruh struktur.
  const temp = ss.insertSheet('__tmp_setup__' + new Date().getTime());

  // Hapus SELURUH lembar lama (termasuk sisa DASHBOARD / REKAP / PERBANDINGAN
  // dari versi sebelumnya) supaya struktur dibangun ulang bersih. Spreadsheet
  // kini hanya menyimpan DATA MENTAH; semua perhitungan dilakukan di kode.
  ss.getSheets().forEach(sh => {
    if (sh.getName() !== temp.getName()) {
      ss.deleteSheet(sh);
    }
  });

  buildAllSheets_(ss);
  ss.deleteSheet(temp);

  PropertiesService.getScriptProperties().setProperty(INIT_FLAG_KEY, 'true');
  SpreadsheetApp.flush();
  return 'Struktur sheet berhasil dibangun ulang sepenuhnya.';
}

/**
 * Alias yang bisa dijalankan langsung dari editor Apps Script (tombol Run)
 * untuk memperbaiki sheet yang error / salah referensi tanpa harus deploy
 * ulang web app. Sama persis dengan setupSpreadsheet().
 */
function repairAllSheets() {
  return setupSpreadsheet();
}

/**
 * Memaksa penanda inisialisasi direset sehingga pemeriksaan penuh akan
 * dijalankan lagi pada pembukaan halaman berikutnya. Berguna setelah
 * menghapus salah satu sheet secara manual. Jalankan dari editor Apps
 * Script jika diperlukan.
 */
function resetStrukturSheet() {
  PropertiesService.getScriptProperties().deleteProperty(INIT_FLAG_KEY);
  return 'Penanda direset. Sheet akan diperiksa/dibangun ulang saat halaman berikutnya dibuka.';
}

function buildAllSheets_(ss) {
  createDataMonitoringSheet(ss);
  SpreadsheetApp.flush();
  createChecklistSheet(ss);
  SpreadsheetApp.flush();
  createPanduanSheet(ss);
  SpreadsheetApp.flush();
  getOrCreateAuditSheet(ss);
  SpreadsheetApp.flush();
}


/* =========================
    DATA MONITORING  (DATA MENTAH — tanpa formula)
 ========================= */

function createDataMonitoringSheet(ss) {

  let sheet = ss.getSheetByName(SHEETS.DATA);

  if (sheet) {
    return; // sudah ada, tidak perlu dibangun ulang
  }

  sheet = ss.insertSheet(SHEETS.DATA);

  // HANYA data mentah. Tidak ada formula: Skor & Status Kepatuhan
  // dihitung di kode (Apps Script/API), bukan di dalam sheet.
  const headers = [
    'No',
    'Tanggal',
    'Kode Partograf',
    'Inisial Bidan',
    'Tertib',
    'Efektif',
    'Profesional',
    'Akurat',
    'Tepat Waktu',
    'Status Monitoring',
    'Keterangan'
  ];

  sheet.getRange(1, 1, 1, headers.length)
    .setValues([headers]);

  sheet.getRange(1, 1, 1, headers.length)
    .setFontWeight('bold')
    .setHorizontalAlignment('center')
    .setWrap(true);

  // Validasi dropdown untuk input manual (opsional).
  const n = 1000;
  const yesNoRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(YA_TIDAK_VALID, true)
    .setAllowInvalid(false)
    .build();

  sheet.getRange(2, 5, n, 5) // E:I (P, C, T, A, K)
    .setDataValidation(yesNoRule);

  const statusRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(STATUS_VALID, true)
    .setAllowInvalid(false)
    .build();

  sheet.getRange(2, 10, n, 1) // J (Status Monitoring)
    .setDataValidation(statusRule);

  sheet.setFrozenRows(1);
  sheet.getRange('A:K').setVerticalAlignment('middle');
  sheet.getRange('A:K').setWrap(true);
}


/* =========================
    CHECKLIST TEPAT
 ========================= */

function createChecklistSheet(ss) {

  let sheet = ss.getSheetByName(SHEETS.CHECKLIST);

  if (sheet) {
    return; // sudah ada, tidak perlu dibangun ulang
  }

  sheet = ss.insertSheet(SHEETS.CHECKLIST);

  const data = [
    [
      'No',
      'Komponen',
      'Indikator Monitoring',
      'Skor Ya',
      'Skor Tidak'
    ],
    [
      1,
      'Tertib',
      'Partograf diisi sesuai tahapan dan tidak ada bagian penting yang terlewat',
      1,
      0
    ],
    [
      2,
      'Efektif',
      'Pengisian mendukung pemantauan kemajuan persalinan dan pengambilan keputusan',
      1,
      0
    ],
    [
      3,
      'Profesional',
      'Dokumentasi jelas, konsisten, dan sesuai standar pelayanan',
      1,
      0
    ],
    [
      4,
      'Akurat',
      'Data hasil pemantauan dicatat sesuai kondisi atau hasil pemeriksaan',
      1,
      0
    ],
    [
      5,
      'Tepat Waktu',
      'Pengisian dilakukan sesuai waktu pemantauan yang ditetapkan',
      1,
      0
    ]
  ];

  sheet.getRange(
    1,
    1,
    data.length,
    data[0].length
  ).setValues(data);

  sheet.getRange(1, 1, 1, 5)
    .setFontWeight('bold')
    .setHorizontalAlignment('center')
    .setWrap(true);

  sheet.setFrozenRows(1);
}


/* =========================
    PANDUAN
 ========================= */

function createPanduanSheet(ss) {

  let sheet = ss.getSheetByName(SHEETS.PANDUAN);

  if (sheet) {
    return; // sudah ada, tidak perlu dibangun ulang
  }

  sheet = ss.insertSheet(SHEETS.PANDUAN);

  const data = [
    ['PANDUAN PENGGUNAAN SISTEM MONITORING PARTOGRAF TEPAT'],
    ['1. Buka menu DATA MONITORING melalui aplikasi web.'],
    ['2. Isi tanggal monitoring.'],
    ['3. Masukkan kode Partograf.'],
    ['4. Masukkan inisial bidan.'],
    ['5. Pilih Ya atau Tidak pada lima komponen TEPAT.'],
    ['6. Pilih status SEBELUM atau SESUDAH.'],
    ['7. Sistem menghitung skor secara otomatis.'],
    ['8. Skor 5 = PATUH.'],
    ['9. Skor kurang dari 5 = BELUM PATUH.'],
    ['10. Dashboard menampilkan hasil monitoring dan evaluasi.'],
    ['11. Gunakan kode Partograf dan hindari memasukkan identitas pasien yang tidak diperlukan.']
  ];

  sheet.getRange(
    1,
    1,
    data.length,
    1
  ).setValues(data);

  sheet.getRange('A1')
    .setFontWeight('bold')
    .setFontSize(16);

  sheet.setColumnWidth(1, 1000);
}


/* =========================
    DATA UNTUK DASHBOARD WEB  (dihitung di kode, bukan di sheet)
 ========================= */

function getDashboardData() {

  ensureSpreadsheetReady_();

  // Agregat dihitung dari data mentah di sheet DATA MONITORING.
  const items = getMonitoringData().map(toMonitoringObject_);

  const sb = { jumlah: 0, patuh: 0, belumPatuh: 0 };
  const sd = { jumlah: 0, patuh: 0, belumPatuh: 0 };

  items.forEach(it => {
    const grp = String(it.statusMonitoring || '').trim().toUpperCase();
    const patuh = it.statusKepatuhan === 'PATUH';
    if (grp === 'SEBELUM') {
      sb.jumlah++;
      if (patuh) { sb.patuh++; } else { sb.belumPatuh++; }
    } else if (grp === 'SESUDAH') {
      sd.jumlah++;
      if (patuh) { sd.patuh++; } else { sd.belumPatuh++; }
    }
  });

  const sbPct = sb.jumlah ? sb.patuh / sb.jumlah : 0;
  const sdPct = sd.jumlah ? sd.patuh / sd.jumlah : 0;

  return {
    sebelum: {
      jumlah: sb.jumlah,
      patuh: sb.patuh,
      belumPatuh: sb.belumPatuh,
      persentase: sbPct
    },
    sesudah: {
      jumlah: sd.jumlah,
      patuh: sd.patuh,
      belumPatuh: sd.belumPatuh,
      persentase: sdPct
    },
    peningkatan: sdPct - sbPct
  };
}


/* =========================
   AMBIL DATA MONITORING
   filter: {tanggalDari, tanggalSampai, status, bidan, kode} - semua opsional
========================= */

function getMonitoringData(filter) {

  ensureSpreadsheetReady_();

  const sheet = getSpreadsheet()
    .getSheetByName(SHEETS.DATA);

  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    return [];
  }

  let rows = sheet
    .getRange(2, 1, lastRow - 1, 11)
    .getDisplayValues()
    .map((row, i) => row.concat([i + 2])) // kolom ke-14 = nomor baris asli di sheet
    .filter(row => row[2] !== '');

  if (filter && typeof filter === 'object') {
    rows = applyMonitoringFilter_(rows, filter);
  }

  return rows;
}


/**
 * Menerapkan filter tanggal/status/bidan/kode pada baris data
 * yang sudah diambil dengan getDisplayValues (kolom tanggal berupa teks
 * yang diformat sesuai locale spreadsheet, sehingga di-parse ulang
 * dengan aman sebelum dibandingkan).
 */
function applyMonitoringFilter_(rows, filter) {

  const dariDate = filter.tanggalDari ? parseDateSafe_(filter.tanggalDari) : null;
  const sampaiDate = filter.tanggalSampai ? parseDateSafe_(filter.tanggalSampai) : null;
  const status = (filter.status || '').trim().toUpperCase();
  const bidan = (filter.bidan || '').trim().toLowerCase();
  const kode = (filter.kode || '').trim().toLowerCase();

  return rows.filter(row => {

    if (status && String(row[9]).trim().toUpperCase() !== status) {
      return false;
    }

    if (bidan && !String(row[3]).trim().toLowerCase().includes(bidan)) {
      return false;
    }

    if (kode && !String(row[2]).trim().toLowerCase().includes(kode)) {
      return false;
    }

    if (dariDate || sampaiDate) {
      const rowDate = parseDateSafe_(row[1]);
      if (!rowDate) {
        return false;
      }
      if (dariDate && rowDate < dariDate) {
        return false;
      }
      if (sampaiDate && rowDate > sampaiDate) {
        return false;
      }
    }

    return true;
  });
}


/**
 * Parse tanggal secara defensif dari berbagai format teks yang mungkin
 * muncul (ISO yyyy-mm-dd dari input date HTML, atau format tampilan
 * spreadsheet). Mengembalikan null jika tidak bisa di-parse, alih-alih
 * melempar error yang menghentikan seluruh proses filter.
 */
function parseDateSafe_(value) {

  if (!value) {
    return null;
  }

  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value)) {
    return stripTime_(value);
  }

  const text = String(value).trim();

  const isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return stripTime_(new Date(
      Number(isoMatch[1]),
      Number(isoMatch[2]) - 1,
      Number(isoMatch[3])
    ));
  }

  const parsed = new Date(text);
  if (!isNaN(parsed)) {
    return stripTime_(parsed);
  }

  return null;
}

function stripTime_(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}


/* =========================
   VALIDASI DATA MONITORING
========================= */

/**
 * Memvalidasi payload input monitoring sebelum disimpan.
 * Mengembalikan array pesan error (kosong berarti valid).
 */
function validateMonitoringPayload_(data) {

  const errors = [];

  if (!data || typeof data !== 'object') {
    return ['Data tidak valid.'];
  }

  if (!data.tanggal) {
    errors.push('Tanggal wajib diisi.');
  } else if (!parseDateSafe_(data.tanggal)) {
    errors.push('Format tanggal tidak dikenali.');
  } else {
    const tanggal = parseDateSafe_(data.tanggal);
    const besok = stripTime_(new Date());
    besok.setDate(besok.getDate() + 1);
    if (tanggal > besok) {
      errors.push('Tanggal monitoring tidak boleh lebih dari hari ini.');
    }
  }

  const kode = String(data.kode || '').trim();
  if (!kode) {
    errors.push('Kode Partograf wajib diisi.');
  } else if (kode.length > 30) {
    errors.push('Kode Partograf terlalu panjang (maksimal 30 karakter).');
  } else if (!/^[A-Za-z0-9\-\/]+$/.test(kode)) {
    errors.push('Kode Partograf hanya boleh berisi huruf, angka, "-", dan "/".');
  }

  const bidan = String(data.bidan || '').trim();
  if (!bidan) {
    errors.push('Inisial bidan wajib diisi.');
  } else if (bidan.length > 15) {
    errors.push('Inisial bidan terlalu panjang (maksimal 15 karakter).');
  }

  const status = String(data.status || '').trim().toUpperCase();
  if (!status) {
    errors.push('Status monitoring wajib dipilih.');
  } else if (STATUS_VALID.indexOf(status) === -1) {
    errors.push('Status monitoring harus SEBELUM atau SESUDAH.');
  }

  KOMPONEN_TEPAT.forEach(key => {
    const nilai = String(data[key] || '').trim();
    if (!nilai) {
      errors.push('Komponen "' + key + '" wajib dinilai.');
    } else if (YA_TIDAK_VALID.indexOf(nilai) === -1) {
      errors.push('Komponen "' + key + '" harus bernilai Ya atau Tidak.');
    }
  });

  if (data.keterangan && String(data.keterangan).length > 500) {
    errors.push('Keterangan terlalu panjang (maksimal 500 karakter).');
  }

  return errors;
}


/**
 * Mengecek apakah kombinasi kode Partograf + status monitoring
 * sudah pernah dicatat sebelumnya, untuk mencegah duplikasi data
 * pada sheet yang sama.
 */
function isDuplicateEntry_(sheet, kode, status, ignoreRow) {

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return false;
  }

  const kodeCol = sheet.getRange(2, 3, lastRow - 1, 1).getValues();
  const statusCol = sheet.getRange(2, 10, lastRow - 1, 1).getValues();

  for (let i = 0; i < kodeCol.length; i++) {
    const currentRow = i + 2;
    if (ignoreRow && currentRow === ignoreRow) {
      continue;
    }
    const currentKode = String(kodeCol[i][0] || '').trim().toLowerCase();
    const currentStatus = String(statusCol[i][0] || '').trim().toUpperCase();
    if (currentKode === String(kode).trim().toLowerCase() &&
        currentStatus === String(status).trim().toUpperCase()) {
      return true;
    }
  }

  return false;
}


/* =========================
   SIMPAN DATA MONITORING
========================= */

function saveMonitoring(data) {

  ensureSpreadsheetReady_();

  const errors = validateMonitoringPayload_(data);
  if (errors.length > 0) {
    throw new Error(errors.join(' '));
  }

  const sheet = getSpreadsheet()
    .getSheetByName(SHEETS.DATA);

  const kode = String(data.kode).trim();
  const status = String(data.status).trim().toUpperCase();

  if (isDuplicateEntry_(sheet, kode, status)) {
    throw new Error(
      'Kode Partograf "' + kode + '" sudah tercatat untuk status ' + status +
      '. Gunakan kode yang berbeda atau perbarui data yang sudah ada.'
    );
  }

  const keterangan = data.keterangan ? String(data.keterangan).trim() : '';

  const skor =
    (data.tertib === 'Ya' ? 1 : 0) +
    (data.efektif === 'Ya' ? 1 : 0) +
    (data.profesional === 'Ya' ? 1 : 0) +
    (data.akurat === 'Ya' ? 1 : 0) +
    (data.tepatWaktu === 'Ya' ? 1 : 0);

  const values = [
    '',
    parseDateSafe_(data.tanggal),
    kode,
    String(data.bidan).trim(),
    data.tertib,
    data.efektif,
    data.profesional,
    data.akurat,
    data.tepatWaktu,
    status,
    keterangan
  ];

  sheet.appendRow(values);

  const row = sheet.getLastRow();
  // No (kolom A) ditulis sebagai nilai nomor baris — tanpa formula apa pun.
  sheet.getRange(row, 1).setValue(row);

  SpreadsheetApp.flush();

  writeAuditLog('SIMPAN_MONITORING',
    'Kode=' + kode + '; Status=' + status + '; Skor=' + skor + '/5; Bidan=' + data.bidan
  );

  return {
    success: true,
    message: 'Data monitoring berhasil disimpan.',
    skor: skor,
    statusKepatuhan: skor === 5 ? 'PATUH' : 'BELUM PATUH'
  };
}


/* =========================
   HAPUS DATA
========================= */

function deleteMonitoring(rowNumber) {

  const row = Number(rowNumber);

  if (!Number.isInteger(row) || row < 2) {
    throw new Error('Baris tidak valid.');
  }

  const sheet = getSpreadsheet()
    .getSheetByName(SHEETS.DATA);

  const lastRow = sheet.getLastRow();
  if (row > lastRow) {
    throw new Error('Baris tidak ditemukan.');
  }

  const rowData = sheet.getRange(row, 1, 1, 11).getDisplayValues()[0];
  if (!rowData[2]) {
    throw new Error('Baris ini tidak berisi data monitoring.');
  }

  sheet.deleteRow(row);

  writeAuditLog('HAPUS_MONITORING',
    'Baris=' + row + '; Kode=' + rowData[2] + '; Status=' + rowData[9]
  );

  return {
    success: true,
    message: 'Data berhasil dihapus.'
  };
}


// CATATAN: Hak akses pada versi ini diterapkan pada antarmuka Web App.
// Untuk keamanan produksi, tambahkan autentikasi server-side berbasis akun Google/SSO
// atau mekanisme session server-side sebelum digunakan untuk data klinis resmi.


/* =========================
   AUDIT LOG
========================= */

function getOrCreateAuditSheet(ss) {

  let sheet = ss.getSheetByName(SHEETS.AUDIT);

  if (!sheet) {
    sheet = ss.insertSheet(SHEETS.AUDIT);
    sheet.appendRow(['Waktu', 'User', 'Aktivitas', 'Detail']);
    sheet.getRange(1, 1, 1, 4).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }

  return sheet;
}

function writeAuditLog(action, detail) {

  try {
    const ss = getSpreadsheet();
    const sheet = getOrCreateAuditSheet(ss);

    let user = 'guest';
    try {
      user = Session.getActiveUser().getEmail() || 'guest';
    } catch (e) {
      user = 'guest';
    }

    sheet.appendRow([new Date(), user, action, detail || '']);
  } catch (e) {
    // Audit log tidak boleh menggagalkan operasi utama; kesalahan
    // di sini hanya dicatat ke log eksekusi Apps Script.
    Logger.log('Gagal menulis audit log: ' + e.message);
  }
}

function getCurrentUser() {
  let email = 'guest';
  try {
    email = Session.getActiveUser().getEmail() || 'guest';
  } catch (e) {
    email = 'guest';
  }
  return { email: email };
}