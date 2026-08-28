const SPREADSHEET_ID = '1iVaAJRkl5Hp30iK7PeF3MHqqWR0UUriHQPFCyD-IIO8';

const SHEETS = {
  DASHBOARD: 'DASHBOARD',
  DATA: 'DATA MONITORING',
  CHECKLIST: 'CHECKLIST TEPAT',
  SEBELUM: 'REKAP SEBELUM',
  SESUDAH: 'REKAP SESUDAH',
  PERBANDINGAN: 'PERBANDINGAN',
  PANDUAN: 'PANDUAN',
  AUDIT: 'AUDIT_LOG'
};

const KOMPONEN_TEPAT = ['tertib', 'efektif', 'profesional', 'akurat', 'tepatWaktu'];
const KOMPONEN_KOLOM = { tertib: 5, efektif: 6, profesional: 7, akurat: 8, tepatWaktu: 9 }; // kolom E-I
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
 * Tanpa parameter action -> respons kecil bahwa API hidup.
 */
function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || '';

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
    skor: row[9],
    statusKepatuhan: row[10],
    statusMonitoring: row[11],
    keterangan: row[12],
    rowNumber: row[13]
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

const DATA_PREFILL_ROWS = 500; // jumlah baris formula yang disiapkan di muka pada sheet DATA MONITORING
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
  buildAllSheets_(ss);
  PropertiesService.getScriptProperties().setProperty(INIT_FLAG_KEY, 'true');
  SpreadsheetApp.flush();
  return 'Struktur sheet berhasil disiapkan/diperiksa.';
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
  createDashboardSheet(ss);
  createDataMonitoringSheet(ss);
  createChecklistSheet(ss);
  createRekapSheet(ss, SHEETS.SEBELUM, 'SEBELUM');
  createRekapSheet(ss, SHEETS.SESUDAH, 'SESUDAH');
  createPerbandinganSheet(ss);
  createPanduanSheet(ss);
  getOrCreateAuditSheet(ss);
  SpreadsheetApp.flush();
}


/* =========================
   DASHBOARD
========================= */

function createDashboardSheet(ss) {

  let sheet = ss.getSheetByName(SHEETS.DASHBOARD);

  if (sheet) {
    return; // sudah ada, tidak perlu dibangun ulang
  }

  sheet = ss.insertSheet(SHEETS.DASHBOARD);

  sheet.getRange('A1').setValue(
    'DASHBOARD MONITORING KEPATUHAN PARTOGRAF TEPAT'
  );

  sheet.getRange('A2').setValue(
    'RSU Hoba Kalla Kabupaten Sumba Barat'
  );

  sheet.getRange('A4').setValue('Jumlah Partograf Sebelum');
  sheet.getRange('C4').setValue('Kepatuhan Sebelum');
  sheet.getRange('E4').setValue('Jumlah Partograf Sesudah');
  sheet.getRange('G4').setValue('Kepatuhan Sesudah');
  sheet.getRange('A7').setValue('Peningkatan Kepatuhan');

  sheet.getRange('A5').setFormula(
    `='${SHEETS.SEBELUM}'!B4`
  );

  sheet.getRange('C5').setFormula(
    `='${SHEETS.SEBELUM}'!B7`
  );

  sheet.getRange('E5').setFormula(
    `='${SHEETS.SESUDAH}'!B4`
  );

  sheet.getRange('G5').setFormula(
    `='${SHEETS.SESUDAH}'!B7`
  );

  sheet.getRange('A8').setFormula(
    `='${SHEETS.PERBANDINGAN}'!D7`
  );

  sheet.getRange('C5').setNumberFormat('0.0%');
  sheet.getRange('G5').setNumberFormat('0.0%');
  sheet.getRange('A8').setNumberFormat('0.0%');

  sheet.getRange('A1:H1')
    .merge()
    .setFontSize(18)
    .setFontWeight('bold')
    .setHorizontalAlignment('center');

  sheet.getRange('A2:H2')
    .merge()
    .setHorizontalAlignment('center');

  sheet.getRange('A4:H4')
    .setFontWeight('bold');

  sheet.getRange('A1:H8')
    .setVerticalAlignment('middle');
}


/* =========================
   DATA MONITORING
========================= */

function createDataMonitoringSheet(ss) {

  let sheet = ss.getSheetByName(SHEETS.DATA);

  if (sheet) {
    return; // sudah ada, tidak perlu dibangun ulang (mencegah proses berat berulang)
  }

  sheet = ss.insertSheet(SHEETS.DATA);

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
    'Skor TEPAT',
    'Status Kepatuhan',
    'Status Monitoring',
    'Keterangan'
  ];

  sheet.getRange(1, 1, 1, headers.length)
    .setValues([headers]);

  sheet.getRange(1, 1, 1, headers.length)
    .setFontWeight('bold')
    .setHorizontalAlignment('center')
    .setWrap(true);

  // Formula No/Skor/Status untuk sejumlah baris disiapkan di muka.
  // PENTING: dibangun sebagai array lalu ditulis SEKALIGUS lewat
  // setFormulas() — bukan setFormula() satu-per-satu dalam loop.
  // Cara lama (loop 1000x, masing-masing 3 panggilan API) adalah
  // penyebab Dashboard "loading" tanpa henti / timeout.
  const n = DATA_PREFILL_ROWS;
  const colA = [], colJ = [], colK = [];

  for (let i = 0; i < n; i++) {
    const r = i + 2;
    colA.push([`=IF(C${r}="","",ROW()-1)`]);
    colJ.push([`=IF(C${r}="","",COUNTIF(E${r}:I${r},"Ya"))`]);
    colK.push([`=IF(C${r}="","",IF(J${r}=5,"PATUH","BELUM PATUH"))`]);
  }

  sheet.getRange(2, 1, n, 1).setFormulas(colA);
  sheet.getRange(2, 10, n, 1).setFormulas(colJ);
  sheet.getRange(2, 11, n, 1).setFormulas(colK);

  // Dropdown Ya/Tidak
  const yesNoRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(YA_TIDAK_VALID, true)
    .setAllowInvalid(false)
    .build();

  sheet.getRange(2, 5, n, 5) // E2:I(n+1)
    .setDataValidation(yesNoRule);

  // Dropdown status
  const statusRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(STATUS_VALID, true)
    .setAllowInvalid(false)
    .build();

  sheet.getRange(2, 12, n, 1) // L2:L(n+1)
    .setDataValidation(statusRule);

  sheet.setFrozenRows(1);
  sheet.getRange('A:M').setVerticalAlignment('middle');
  sheet.getRange('A:M').setWrap(true);
}


/**
 * Memastikan baris ke depan (di luar rentang prefill awal) tetap punya
 * formula No/Skor/Status saat sheet sudah dipakai bertahun-tahun dan
 * baris data melebihi DATA_PREFILL_ROWS. Ditulis dalam batch, aman
 * dipanggil kapan saja (mis. dari trigger terjadwal bulanan), TIDAK
 * dipanggil otomatis setiap request supaya tetap ringan.
 */
function perluasFormulaDataMonitoring(sampaiBaris) {

  const sheet = getSpreadsheet().getSheetByName(SHEETS.DATA);
  const target = Number(sampaiBaris) || (sheet.getLastRow() + 200);
  const mulai = Math.max(2, sheet.getMaxRows() > 1 ? sheet.getLastRow() + 1 : 2);

  if (target < mulai) {
    return 'Tidak ada baris baru yang perlu diperluas.';
  }

  const n = target - mulai + 1;
  const colA = [], colJ = [], colK = [];

  for (let i = 0; i < n; i++) {
    const r = mulai + i;
    colA.push([`=IF(C${r}="","",ROW()-1)`]);
    colJ.push([`=IF(C${r}="","",COUNTIF(E${r}:I${r},"Ya"))`]);
    colK.push([`=IF(C${r}="","",IF(J${r}=5,"PATUH","BELUM PATUH"))`]);
  }

  sheet.getRange(mulai, 1, n, 1).setFormulas(colA);
  sheet.getRange(mulai, 10, n, 1).setFormulas(colJ);
  sheet.getRange(mulai, 11, n, 1).setFormulas(colK);

  const yesNoRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(YA_TIDAK_VALID, true)
    .setAllowInvalid(false)
    .build();
  sheet.getRange(mulai, 5, n, 5).setDataValidation(yesNoRule);

  const statusRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(STATUS_VALID, true)
    .setAllowInvalid(false)
    .build();
  sheet.getRange(mulai, 12, n, 1).setDataValidation(statusRule);

  return 'Formula diperluas sampai baris ' + target + '.';
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
   REKAP
========================= */

function createRekapSheet(ss, sheetName, status) {

  let sheet = ss.getSheetByName(sheetName);

  if (sheet) {
    return; // sudah ada, tidak perlu dibangun ulang
  }

  sheet = ss.insertSheet(sheetName);

  sheet.getRange('A1')
    .setValue('REKAP MONITORING ' + status)
    .setFontWeight('bold')
    .setFontSize(16);

  sheet.getRange('A3:B3')
    .setValues([
      ['Indikator', 'Nilai']
    ])
    .setFontWeight('bold');

  sheet.getRange('A4').setValue('Jumlah Partograf');

  sheet.getRange('B4').setFormula(
    `=COUNTIF('${SHEETS.DATA}'!L:L,"${status}")`
  );

  sheet.getRange('A5').setValue('Jumlah Patuh');

  sheet.getRange('B5').setFormula(
    `=COUNTIFS('${SHEETS.DATA}'!L:L,"${status}",'${SHEETS.DATA}'!K:K,"PATUH")`
  );

  sheet.getRange('A6').setValue('Jumlah Belum Patuh');

  sheet.getRange('B6').setFormula(
    `=COUNTIFS('${SHEETS.DATA}'!L:L,"${status}",'${SHEETS.DATA}'!K:K,"BELUM PATUH")`
  );

  sheet.getRange('A7').setValue(
    'Persentase Kepatuhan'
  );

  sheet.getRange('B7').setFormula(
    '=IFERROR(B5/B4,0)'
  );

  sheet.getRange('B7')
    .setNumberFormat('0.0%');
}


/* =========================
   PERBANDINGAN
========================= */

function createPerbandinganSheet(ss) {

  let sheet = ss.getSheetByName(SHEETS.PERBANDINGAN);

  if (sheet) {
    return; // sudah ada, tidak perlu dibangun ulang
  }

  sheet = ss.insertSheet(SHEETS.PERBANDINGAN);

  sheet.getRange('A1')
    .setValue(
      'PERBANDINGAN HASIL MONITORING SEBELUM DAN SESUDAH'
    )
    .setFontWeight('bold')
    .setFontSize(16);

  sheet.getRange('A3:D3')
    .setValues([
      [
        'Indikator',
        'SEBELUM',
        'SESUDAH',
        'Perubahan'
      ]
    ])
    .setFontWeight('bold');

  sheet.getRange('A4').setValue('Jumlah Partograf');
  sheet.getRange('A5').setValue('Jumlah Patuh');
  sheet.getRange('A6').setValue('Jumlah Belum Patuh');
  sheet.getRange('A7').setValue('Persentase Kepatuhan');

  sheet.getRange('B4').setFormula(
    `='${SHEETS.SEBELUM}'!B4`
  );

  sheet.getRange('C4').setFormula(
    `='${SHEETS.SESUDAH}'!B4`
  );

  sheet.getRange('B5').setFormula(
    `='${SHEETS.SEBELUM}'!B5`
  );

  sheet.getRange('C5').setFormula(
    `='${SHEETS.SESUDAH}'!B5`
  );

  sheet.getRange('B6').setFormula(
    `='${SHEETS.SEBELUM}'!B6`
  );

  sheet.getRange('C6').setFormula(
    `='${SHEETS.SESUDAH}'!B6`
  );

  sheet.getRange('B7').setFormula(
    `='${SHEETS.SEBELUM}'!B7`
  );

  sheet.getRange('C7').setFormula(
    `='${SHEETS.SESUDAH}'!B7`
  );

  sheet.getRange('D4').setFormula('=C4-B4');
  sheet.getRange('D5').setFormula('=C5-B5');
  sheet.getRange('D6').setFormula('=C6-B6');
  sheet.getRange('D7').setFormula('=C7-B7');

  sheet.getRange('B7:D7')
    .setNumberFormat('0.0%');
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
   DATA UNTUK DASHBOARD WEB
========================= */

function getDashboardData() {

  ensureSpreadsheetReady_();

  const ss = getSpreadsheet();

  const sebelum = ss.getSheetByName(SHEETS.SEBELUM);
  const sesudah = ss.getSheetByName(SHEETS.SESUDAH);

  const result = {
    sebelum: {
      jumlah: sebelum.getRange('B4').getValue(),
      patuh: sebelum.getRange('B5').getValue(),
      belumPatuh: sebelum.getRange('B6').getValue(),
      persentase: sebelum.getRange('B7').getValue()
    },

    sesudah: {
      jumlah: sesudah.getRange('B4').getValue(),
      patuh: sesudah.getRange('B5').getValue(),
      belumPatuh: sesudah.getRange('B6').getValue(),
      persentase: sesudah.getRange('B7').getValue()
    }
  };

  result.peningkatan =
    result.sesudah.persentase -
    result.sebelum.persentase;

  return result;
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
    .getRange(2, 1, lastRow - 1, 13)
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

    if (status && String(row[11]).trim().toUpperCase() !== status) {
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
  const statusCol = sheet.getRange(2, 12, lastRow - 1, 1).getValues();

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
    '',
    '',
    status,
    keterangan
  ];

  sheet.appendRow(values);

  const row = sheet.getLastRow();

  sheet.getRange(row, 1).setFormula(
    `=IF(C${row}="","",ROW()-1)`
  );

  sheet.getRange(row, 10).setFormula(
    `=IF(C${row}="","",COUNTIF(E${row}:I${row},"Ya"))`
  );

  sheet.getRange(row, 11).setFormula(
    `=IF(C${row}="","",IF(J${row}=5,"PATUH","BELUM PATUH"))`
  );

  SpreadsheetApp.flush();

  const skor = KOMPONEN_TEPAT.reduce((n, key) => n + (data[key] === 'Ya' ? 1 : 0), 0);

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

  const rowData = sheet.getRange(row, 1, 1, 13).getDisplayValues()[0];
  if (!rowData[2]) {
    throw new Error('Baris ini tidak berisi data monitoring.');
  }

  sheet.deleteRow(row);

  writeAuditLog('HAPUS_MONITORING',
    'Baris=' + row + '; Kode=' + rowData[2] + '; Status=' + rowData[11]
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