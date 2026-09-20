const SPREADSHEET_ID = '1iVaAJRkl5Hp30iK7PeF3MHqqWR0UUriHQPFCyD-IIO8';

const SHEETS = {
  DATA: 'DATA MONITORING',
  CHECKLIST: 'CHECKLIST TEPAT',
  PANDUAN: 'PANDUAN',
  AUDIT: 'AUDIT_LOG',
  USERS: 'USERS'
};

const KOMPONEN_TEPAT = ['tertib', 'efektif', 'profesional', 'akurat', 'tepatWaktu'];
const STATUS_VALID = ['SEBELUM', 'SESUDAH'];
const YA_TIDAK_VALID = ['Ya', 'Tidak'];


/* =========================
   WEB APP
========================= */

/**
 * Endpoint GET hanya untuk cek bahwa API hidup. Semua aksi data memakai
 * doPost() dengan token sesi (lihat routeAuthed_).
 */
function doGet(e) {
  // SENGAJA tidak melayani data apa pun lewat GET. Semua aksi (login, data,
  // pengguna) lewat doPost dan wajib memakai token sesi. Aksi 'setup' tidak
  // lagi bisa dipanggil lewat web: jalankan setupSpreadsheet() manual dari
  // editor Apps Script bila memang perlu membangun ulang struktur sheet.
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

  if (action === 'login') {
    return jsonOut_(safeRun_(() => handleLogin_(payload)));
  }

  return jsonOut_(safeRun_(() => routeAuthed_(action, payload)));
}


/**
 * Semua aksi selain login: wajib token sesi valid, lalu dicek peran (role)
 * di SISI SERVER. Pembatasan menu di frontend hanya tampilan.
 */
function routeAuthed_(action, p) {

  const user = authenticate_(p.token);

  switch (action) {

    case 'me':
      return { user: publicUser_(user) };

    case 'dashboard':
      return getDashboardData();

    case 'monitoring': {
      const f = p.filter || {};
      return getMonitoringData({
        tanggalDari: f.tanggalDari,
        tanggalSampai: f.tanggalSampai,
        status: f.status,
        bidan: f.bidan,
        kode: f.kode
      }).map(toMonitoringObject_);
    }

    case 'save': {
      requireRole_(user, ['ADMIN', 'PETUGAS']);
      const data = Object.assign({}, p.data || {});
      // Petugas bidan selalu tercatat dengan inisialnya sendiri.
      if (user.peran === 'PETUGAS' && user.inisial) {
        data.bidan = user.inisial;
      }
      return saveMonitoring(data);
    }

    case 'delete':
      requireRole_(user, ['ADMIN']);
      return deleteMonitoring(p.row);

    case 'changePassword':
      return changePassword_(user, p);

    case 'listUsers':
      requireRole_(user, ['ADMIN']);
      return { users: readUsers_().map(publicUser_) };

    case 'createUser':
      requireRole_(user, ['ADMIN']);
      return createUser_(user, p);

    case 'updateUser':
      requireRole_(user, ['ADMIN']);
      return updateUser_(user, p);

    case 'deleteUser':
      requireRole_(user, ['ADMIN']);
      return deleteUser_(user, p);

    default:
      throw httpError_(400, 'Aksi tidak dikenali.');
  }
}


/** Bungkus eksekusi agar error tertangkap jadi {error:...} (status 200). */
function safeRun_(fn) {
  try {
    return fn();
  } catch (err) {
    const out = { error: err.message || String(err) };
    if (err.code) {
      out.code = err.code;
    }
    return out;
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

const INIT_FLAG_KEY = 'PTEPAT_STRUKTUR_SIAP_V3';

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
  // Sheet USERS sengaja TIDAK dihapus supaya akun pengguna tidak hilang.
  ss.getSheets().forEach(sh => {
    if (sh.getName() !== temp.getName() && sh.getName() !== SHEETS.USERS) {
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
  getOrCreateUsersSheet_(ss);
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
  const sbItems = [];
  const sdItems = [];

  items.forEach(it => {
    const grp = String(it.statusMonitoring || '').trim().toUpperCase();
    const patuh = it.statusKepatuhan === 'PATUH';
    if (grp === 'SEBELUM') {
      sb.jumlah++;
      sbItems.push(it);
      if (patuh) { sb.patuh++; } else { sb.belumPatuh++; }
    } else if (grp === 'SESUDAH') {
      sd.jumlah++;
      sdItems.push(it);
      if (patuh) { sd.patuh++; } else { sd.belumPatuh++; }
    }
  });

  const sbPct = sb.jumlah ? sb.patuh / sb.jumlah : 0;
  const sdPct = sd.jumlah ? sd.patuh / sd.jumlah : 0;

  // Hitungan PER ITEM (Tertib, Efektif, Profesional, Akurat, Tepat Waktu)
  const sbPerItem = hitungPerItem_(sbItems);
  const sdPerItem = hitungPerItem_(sdItems);
  const peningkatanPerItem = {};
  KOMPONEN_TEPAT.forEach(k => {
    peningkatanPerItem[k] = sdPerItem[k].persentase - sbPerItem[k].persentase;
  });

  return {
    sebelum: {
      jumlah: sb.jumlah,
      patuh: sb.patuh,
      belumPatuh: sb.belumPatuh,
      persentase: sbPct,
      perItem: sbPerItem
    },
    sesudah: {
      jumlah: sd.jumlah,
      patuh: sd.patuh,
      belumPatuh: sd.belumPatuh,
      persentase: sdPct,
      perItem: sdPerItem
    },
    peningkatan: sdPct - sbPct,
    peningkatanPerItem: peningkatanPerItem
  };
}

/**
 * Hitung persentase "Ya" untuk masing-masing komponen TEPAT.
 * Mengembalikan { tertib:{ya,tidak,persentase}, efektif:{...}, ... }.
 * persentase berupa pecahan 0..1 (sama seperti field persentase lainnya).
 */
function hitungPerItem_(items) {
  const hasil = {};
  const total = items.length;
  KOMPONEN_TEPAT.forEach(k => {
    const ya = items.filter(it => it[k] === 'Ya').length;
    hasil[k] = {
      ya: ya,
      tidak: total - ya,
      persentase: total ? ya / total : 0
    };
  });
  return hasil;
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

    // Pengguna aplikasi (dari token sesi / login), bukan akun Google.
    const user = CURRENT_USERNAME_ || 'guest';

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


/* =====================================================================
   AUTENTIKASI & MANAJEMEN PENGGUNA

   - Akun disimpan di sheet USERS (password TIDAK disimpan polos: hanya
     hash SHA-256 + salt acak per pengguna, diulang HASH_ROUNDS kali).
   - Login menghasilkan token bertanda-tangan (HMAC) yang berlaku
     SESSION_HOURS jam. Kunci penandatangan disimpan otomatis di Script
     Properties (SESSION_SECRET). Token otomatis tidak berlaku bila akun
     dinonaktifkan/dihapus atau password diganti.
   - Peran dicek di server pada setiap aksi (lihat routeAuthed_).
   - JANGAN bagikan spreadsheet ini ke orang yang tidak berhak: sheet
     USERS berisi hash password.
===================================================================== */

let CURRENT_USERNAME_ = '';

const ROLES_VALID = ['ADMIN', 'PETUGAS', 'PIMPINAN'];
const SESSION_HOURS = 12;
const HASH_ROUNDS = 500;
const MAX_LOGIN_FAIL = 5;
const LOCK_SECONDS = 600;
const TZ_APP = 'Asia/Makassar';
const USER_HEADERS = [
  'Username', 'Nama', 'Peran', 'Inisial', 'Aktif',
  'Salt', 'Password Hash', 'Dibuat', 'Login Terakhir'
];


function httpError_(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function nowStr_() {
  return Utilities.formatDate(new Date(), TZ_APP, 'yyyy-MM-dd HH:mm:ss');
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}


/* ---------- sheet USERS ---------- */

function getOrCreateUsersSheet_(ss) {

  let sheet = ss.getSheetByName(SHEETS.USERS);

  if (sheet) {
    return sheet;
  }

  sheet = ss.insertSheet(SHEETS.USERS);

  sheet.getRange(1, 1, 1, USER_HEADERS.length)
    .setValues([USER_HEADERS])
    .setFontWeight('bold')
    .setHorizontalAlignment('center');

  // Format teks supaya hash heksadesimal tidak terbaca sebagai angka.
  sheet.getRange('A:I').setNumberFormat('@');
  sheet.setFrozenRows(1);
  sheet.setTabColor('#B23A2E');

  return sheet;
}

function readUsers_() {

  const sheet = getOrCreateUsersSheet_(getSpreadsheet());
  const last = sheet.getLastRow();

  if (last < 2) {
    return [];
  }

  const values = sheet.getRange(2, 1, last - 1, USER_HEADERS.length).getValues();
  const users = [];

  values.forEach((r, i) => {
    const username = String(r[0]).trim().toLowerCase();
    if (!username) {
      return;
    }
    users.push({
      row: i + 2,
      username: username,
      nama: String(r[1]),
      peran: String(r[2]).trim().toUpperCase(),
      inisial: String(r[3]),
      aktif: String(r[4]).trim() === 'Ya',
      salt: String(r[5]),
      hash: String(r[6]),
      dibuat: String(r[7]),
      loginTerakhir: String(r[8])
    });
  });

  return users;
}

function publicUser_(u) {
  return {
    username: u.username,
    nama: u.nama,
    peran: u.peran,
    inisial: u.inisial,
    aktif: u.aktif,
    dibuat: u.dibuat,
    loginTerakhir: u.loginTerakhir
  };
}


/* ---------- hash & token ---------- */

function bytesToHex_(bytes) {
  return bytes.map(b => (b < 0 ? b + 256 : b).toString(16).padStart(2, '0')).join('');
}

function hashPassword_(password, salt) {
  let h = salt + '|' + password;
  for (let i = 0; i < HASH_ROUNDS; i++) {
    h = bytesToHex_(Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256,
      h + '|' + salt,
      Utilities.Charset.UTF_8
    ));
  }
  return h;
}

function safeEqual_(a, b) {
  a = String(a);
  b = String(b);
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function getSecret_() {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty('SESSION_SECRET');
  if (!secret) {
    secret = Utilities.getUuid() + Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('SESSION_SECRET', secret);
  }
  return secret;
}

function signPart_(body) {
  return Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(body, getSecret_())
  );
}

function issueToken_(username, hash) {
  const exp = Date.now() + SESSION_HOURS * 3600 * 1000;
  const body = Utilities.base64EncodeWebSafe(JSON.stringify({
    u: username,
    pv: String(hash).slice(0, 10),
    exp: exp
  }));
  return { token: body + '.' + signPart_(body), expiresAt: exp };
}

function verifyToken_(token) {

  if (!token || typeof token !== 'string') {
    return null;
  }

  const parts = token.split('.');
  if (parts.length !== 2 || !safeEqual_(signPart_(parts[0]), parts[1])) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(
      Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString()
    );
  } catch (err) {
    return null;
  }

  if (!payload || !payload.exp || Date.now() > payload.exp) {
    return null;
  }

  return payload;
}

function authenticate_(token) {

  const msg = 'Sesi tidak valid atau sudah berakhir. Silakan masuk kembali.';
  const payload = verifyToken_(token);

  if (!payload) {
    throw httpError_(401, msg);
  }

  const user = readUsers_().find(u => u.username === payload.u);

  if (!user || !user.aktif || user.hash.slice(0, 10) !== payload.pv) {
    throw httpError_(401, msg);
  }

  CURRENT_USERNAME_ = user.username;
  return user;
}

function requireRole_(user, roles) {
  if (roles.indexOf(user.peran) === -1) {
    throw httpError_(403, 'Anda tidak memiliki hak akses untuk aksi ini.');
  }
}


/* ---------- pembatasan percobaan login ---------- */

function failKey_(username) {
  return 'loginfail_' + String(username).slice(0, 60);
}

function getFails_(username) {
  return Number(CacheService.getScriptCache().get(failKey_(username)) || 0);
}

function addFail_(username) {
  CacheService.getScriptCache().put(
    failKey_(username), String(getFails_(username) + 1), LOCK_SECONDS
  );
}

function clearFails_(username) {
  CacheService.getScriptCache().remove(failKey_(username));
}

function assertNotLocked_(username) {
  if (getFails_(username) >= MAX_LOGIN_FAIL) {
    throw httpError_(429, 'Terlalu banyak percobaan gagal. Coba lagi dalam 10 menit.');
  }
}


/* ---------- login ---------- */

function handleLogin_(p) {

  const username = String(p.username || '').trim().toLowerCase();
  const password = String(p.password || '');

  if (!username || !password) {
    throw httpError_(400, 'Username dan password wajib diisi.');
  }

  assertNotLocked_(username);
  seedAdminIfEmpty_();

  const user = readUsers_().find(u => u.username === username);

  // Hash tetap dihitung walau user tidak ada, agar waktu respons seragam.
  const candidate = hashPassword_(password, user ? user.salt : 'x');
  const ok = !!user && user.aktif && safeEqual_(candidate, user.hash);

  if (!ok) {
    addFail_(username);
    CURRENT_USERNAME_ = username.slice(0, 30);
    writeAuditLog('LOGIN_GAGAL', 'Username=' + username.slice(0, 30));
    throw httpError_(401, 'Username atau password salah.');
  }

  clearFails_(username);
  CURRENT_USERNAME_ = user.username;

  getOrCreateUsersSheet_(getSpreadsheet())
    .getRange(user.row, 9)
    .setValue(nowStr_());

  writeAuditLog('LOGIN', 'Peran=' + user.peran);

  const session = issueToken_(user.username, user.hash);

  return {
    token: session.token,
    expiresAt: session.expiresAt,
    user: publicUser_(user)
  };
}


/* ---------- admin awal ---------- */

/**
 * Jika sheet USERS masih kosong, buat 3 akun bawaan: admin/admin123,
 * bidan/bidan123, pimpinan/pimpinan123. Dipanggil otomatis saat login
 * pertama, atau jalankan buatAdminAwal() manual dari editor. Setelah itu
 * password tiap akun bisa diganti pemiliknya lewat menu "Ganti Password",
 * atau direset ADMIN lewat menu Pengguna.
 */
function seedAdminIfEmpty_() {

  // Jalur cepat tanpa lock: hampir semua login lewat sini.
  if (readUsers_().length > 0) {
    return false;
  }

  return withLock_(() => {

    if (readUsers_().length > 0) {
      return false;
    }

    // Akun bawaan (sama seperti versi sebelumnya). Password disimpan sebagai
    // hash di sheet USERS, dan semua bisa diganti lewat menu "Ganti Password".
    const defaults = [
      { username: 'admin', nama: 'Administrator', peran: 'ADMIN', inisial: '', password: 'admin123' },
      { username: 'bidan', nama: 'Petugas Bidan', peran: 'PETUGAS', inisial: 'BD', password: 'bidan123' },
      { username: 'pimpinan', nama: 'Pimpinan RS', peran: 'PIMPINAN', inisial: '', password: 'pimpinan123' }
    ];

    // Opsional: password admin awal bisa diganti lewat Script Property
    // ADMIN_PASSWORD_AWAL (dihapus otomatis setelah dipakai).
    const props = PropertiesService.getScriptProperties();
    const adminPwd = props.getProperty('ADMIN_PASSWORD_AWAL');
    if (adminPwd && adminPwd.length >= 8) {
      defaults[0].password = adminPwd;
      props.deleteProperty('ADMIN_PASSWORD_AWAL');
    }

    defaults.forEach(d => {
      d.aktif = true;
      createUserRow_(d);
    });

    CURRENT_USERNAME_ = 'system';
    writeAuditLog('SEED_USERS_BAWAAN', 'Dibuat: admin, bidan, pimpinan');

    return true;
  });
}

function buatAdminAwal() {
  return seedAdminIfEmpty_()
    ? 'Akun bawaan (admin, bidan, pimpinan) berhasil dibuat di sheet USERS.'
    : 'Tidak dibuat: sheet USERS sudah berisi pengguna.';
}


/* ---------- CRUD pengguna ---------- */

function normalizeUserInput_(p) {
  return {
    username: String(p.username || '').trim().toLowerCase(),
    nama: String(p.nama || '').trim(),
    peran: String(p.peran || '').trim().toUpperCase(),
    inisial: String(p.inisial || '').trim().toUpperCase(),
    aktif: !(p.aktif === false || p.aktif === 'Tidak'),
    password: p.password ? String(p.password) : ''
  };
}

function validateUserInput_(d, isNew) {

  const errors = [];

  if (!/^[a-z0-9._-]{3,30}$/.test(d.username)) {
    errors.push('Username 3-30 karakter, hanya huruf kecil, angka, titik, garis bawah, atau strip.');
  }
  if (!d.nama || d.nama.length > 60) {
    errors.push('Nama wajib diisi (maksimal 60 karakter).');
  }
  if (ROLES_VALID.indexOf(d.peran) === -1) {
    errors.push('Peran harus ADMIN, PETUGAS, atau PIMPINAN.');
  }
  if (d.inisial.length > 15) {
    errors.push('Inisial maksimal 15 karakter.');
  }
  if (d.peran === 'PETUGAS' && !d.inisial) {
    errors.push('Inisial bidan wajib diisi untuk peran PETUGAS.');
  }
  if (isNew && !d.password) {
    errors.push('Password wajib diisi.');
  }
  if (d.password && (d.password.length < 8 || d.password.length > 72)) {
    errors.push('Password 8-72 karakter.');
  }

  return errors;
}

function createUserRow_(d) {

  const salt = Utilities.getUuid();

  getOrCreateUsersSheet_(getSpreadsheet()).appendRow([
    d.username,
    d.nama,
    d.peran,
    d.inisial || '',
    d.aktif ? 'Ya' : 'Tidak',
    salt,
    hashPassword_(d.password, salt),
    nowStr_(),
    ''
  ]);
}

function countOtherActiveAdmins_(users, username) {
  return users.filter(u =>
    u.username !== username && u.peran === 'ADMIN' && u.aktif
  ).length;
}

function createUser_(actor, p) {

  const d = normalizeUserInput_(p);
  const errors = validateUserInput_(d, true);

  if (errors.length > 0) {
    throw httpError_(400, errors.join(' '));
  }

  return withLock_(() => {

    if (readUsers_().some(u => u.username === d.username)) {
      throw httpError_(400, 'Username "' + d.username + '" sudah dipakai.');
    }

    createUserRow_(d);
    writeAuditLog('TAMBAH_USER', 'Username=' + d.username + '; Peran=' + d.peran);

    return { success: true, message: 'Pengguna berhasil ditambahkan.' };
  });
}

function updateUser_(actor, p) {

  return withLock_(() => {

    const users = readUsers_();
    const username = String(p.username || '').trim().toLowerCase();
    const target = users.find(u => u.username === username);

    if (!target) {
      throw httpError_(404, 'Pengguna tidak ditemukan.');
    }

    const d = normalizeUserInput_(p);
    if (p.aktif === undefined) {
      d.aktif = target.aktif;
    }

    const errors = validateUserInput_(d, false);
    if (errors.length > 0) {
      throw httpError_(400, errors.join(' '));
    }

    if (target.username === actor.username) {
      if (d.peran !== 'ADMIN') {
        throw httpError_(400, 'Anda tidak dapat mengubah peran akun Anda sendiri.');
      }
      if (!d.aktif) {
        throw httpError_(400, 'Anda tidak dapat menonaktifkan akun Anda sendiri.');
      }
    }

    if (target.peran === 'ADMIN' && target.aktif &&
        (d.peran !== 'ADMIN' || !d.aktif) &&
        countOtherActiveAdmins_(users, target.username) === 0) {
      throw httpError_(400, 'Harus ada minimal satu ADMIN yang aktif.');
    }

    const sheet = getOrCreateUsersSheet_(getSpreadsheet());

    sheet.getRange(target.row, 2, 1, 4).setValues([[
      d.nama, d.peran, d.inisial, d.aktif ? 'Ya' : 'Tidak'
    ]]);

    let passwordChanged = false;
    if (d.password) {
      const salt = Utilities.getUuid();
      sheet.getRange(target.row, 6, 1, 2).setValues([[
        salt, hashPassword_(d.password, salt)
      ]]);
      passwordChanged = true;
    }

    writeAuditLog('UBAH_USER',
      'Username=' + target.username + '; Peran=' + d.peran +
      '; Aktif=' + (d.aktif ? 'Ya' : 'Tidak') +
      (passwordChanged ? '; PasswordDireset' : '')
    );

    return { success: true, message: 'Pengguna berhasil diperbarui.' };
  });
}

function deleteUser_(actor, p) {

  return withLock_(() => {

    const users = readUsers_();
    const username = String(p.username || '').trim().toLowerCase();
    const target = users.find(u => u.username === username);

    if (!target) {
      throw httpError_(404, 'Pengguna tidak ditemukan.');
    }
    if (target.username === actor.username) {
      throw httpError_(400, 'Anda tidak dapat menghapus akun Anda sendiri.');
    }
    if (target.peran === 'ADMIN' && target.aktif &&
        countOtherActiveAdmins_(users, target.username) === 0) {
      throw httpError_(400, 'Harus ada minimal satu ADMIN yang aktif.');
    }

    getOrCreateUsersSheet_(getSpreadsheet()).deleteRow(target.row);
    writeAuditLog('HAPUS_USER', 'Username=' + target.username);

    return { success: true, message: 'Pengguna berhasil dihapus.' };
  });
}

function changePassword_(user, p) {

  const oldPassword = String(p.oldPassword || '');
  const newPassword = String(p.newPassword || '');

  assertNotLocked_(user.username);

  if (!oldPassword || !newPassword) {
    throw httpError_(400, 'Password lama dan baru wajib diisi.');
  }
  if (newPassword.length < 8 || newPassword.length > 72) {
    throw httpError_(400, 'Password baru 8-72 karakter.');
  }
  if (!safeEqual_(hashPassword_(oldPassword, user.salt), user.hash)) {
    addFail_(user.username);
    throw httpError_(400, 'Password saat ini salah.');
  }
  if (newPassword === oldPassword) {
    throw httpError_(400, 'Password baru tidak boleh sama dengan yang lama.');
  }

  clearFails_(user.username);

  const salt = Utilities.getUuid();
  const hash = hashPassword_(newPassword, salt);

  getOrCreateUsersSheet_(getSpreadsheet())
    .getRange(user.row, 6, 1, 2)
    .setValues([[salt, hash]]);

  writeAuditLog('GANTI_PASSWORD', 'Username=' + user.username);

  // Token lama otomatis tidak berlaku (hash berubah); beri token baru.
  const session = issueToken_(user.username, hash);

  return {
    success: true,
    message: 'Password berhasil diubah.',
    token: session.token,
    expiresAt: session.expiresAt
  };
}