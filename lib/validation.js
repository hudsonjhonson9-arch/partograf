const KOMPONEN_TEPAT = ['tertib', 'efektif', 'profesional', 'akurat', 'tepatWaktu'];
const STATUS_VALID = ['SEBELUM', 'SESUDAH'];
const YA_TIDAK_VALID = ['Ya', 'Tidak'];

function stripTime(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * Parse tanggal secara defensif dari berbagai format teks yang mungkin
 * muncul (ISO yyyy-mm-dd dari input date HTML, atau teks lain).
 * Mengembalikan null (bukan melempar error) jika tidak bisa di-parse.
 */
function parseDateSafe(value) {
  if (!value) {
    return null;
  }

  if (value instanceof Date && !isNaN(value)) {
    return stripTime(value);
  }

  const text = String(value).trim();

  const isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return stripTime(new Date(
      Number(isoMatch[1]),
      Number(isoMatch[2]) - 1,
      Number(isoMatch[3])
    ));
  }

  const parsed = new Date(text);
  if (!isNaN(parsed)) {
    return stripTime(parsed);
  }

  return null;
}

/**
 * Memvalidasi payload input monitoring sebelum disimpan.
 * Mengembalikan array pesan error (kosong berarti valid).
 */
function validateMonitoringPayload(data) {

  const errors = [];

  if (!data || typeof data !== 'object') {
    return ['Data tidak valid.'];
  }

  if (!data.tanggal) {
    errors.push('Tanggal wajib diisi.');
  } else if (!parseDateSafe(data.tanggal)) {
    errors.push('Format tanggal tidak dikenali.');
  } else {
    const tanggal = parseDateSafe(data.tanggal);
    const besok = stripTime(new Date());
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
  } else if (!/^[A-Za-z0-9\-/]+$/.test(kode)) {
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

function hitungSkor(data) {
  return KOMPONEN_TEPAT.reduce((n, key) => n + (data[key] === 'Ya' ? 1 : 0), 0);
}

module.exports = {
  KOMPONEN_TEPAT,
  STATUS_VALID,
  YA_TIDAK_VALID,
  stripTime,
  parseDateSafe,
  validateMonitoringPayload,
  hitungSkor
};
