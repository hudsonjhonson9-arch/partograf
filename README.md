# Partograf TEPAT — Versi Vercel

Aplikasi monitoring kepatuhan dokumentasi Partograf TEPAT (RSU Hoba Kalla,
Sumba Barat), versi yang bisa di-deploy ke **Vercel**.

## Kenapa strukturnya beda dari versi Google Apps Script?

Vercel menjalankan Node.js (serverless functions), bukan runtime Google Apps
Script. Jadi arsitekturnya diubah:

- **Frontend** (`public/index.html`) — tampilan & animasi yang sama seperti
  sebelumnya, tapi sekarang mengambil data lewat `fetch()` ke API, bukan
  `google.script.run`.
- **Backend** (`api/*.js`) — Serverless Functions Node.js yang membaca/menulis
  ke Google Sheets lewat **Google Sheets API**, menggunakan **Service
  Account** (bukan login akun Google pribadi).
- **Google Sheets** tetap dipakai sebagai "database"-nya — tidak perlu pindah
  ke database lain.
- Perhitungan Skor TEPAT, Status Kepatuhan, dan rekap Sebelum/Sesudah
  sekarang dihitung langsung di server (Node.js) saat data dibaca — **bukan**
  lewat formula spreadsheet yang di-loop satu-per-satu. Ini sekaligus
  menghilangkan penyebab "loading terus" yang muncul di versi Apps Script
  sebelumnya.

## Struktur folder

```
├── api/
│   ├── dashboard.js     # GET  -> agregat Sebelum/Sesudah/Peningkatan
│   ├── health.js        # GET  -> cek konfigurasi & koneksi ke Google Sheets
│   └── monitoring.js    # GET (list+filter) / POST (simpan) / DELETE (hapus)
├── lib/
│   ├── sheets.js        # koneksi Google Sheets API + auto-buat sheet/header
│   ├── validation.js    # validasi input & hitung skor (dipakai di semua API)
│   └── audit.js         # pencatatan log aktivitas (AUDIT_LOG)
├── public/
│   └── index.html       # seluruh UI (statis, disajikan langsung oleh Vercel)
├── package.json
├── vercel.json
└── .env.example
```

---

## LANGKAH 1 — Siapkan Google Sheet

1. Buat spreadsheet Google Sheets baru (atau pakai yang sudah ada).
2. Ambil **Spreadsheet ID** dari URL-nya:
   ```
   https://docs.google.com/spreadsheets/d/SPREADSHEET_ID_DI_SINI/edit
   ```
3. Sheet **DATA MONITORING**, **CHECKLIST TEPAT**, dan **AUDIT_LOG** akan
   dibuat otomatis beserta headernya saat aplikasi pertama kali diakses —
   tidak perlu dibuat manual.

## LANGKAH 2 — Buat Service Account Google

Service Account adalah "akun robot" supaya server Vercel bisa membaca/menulis
sheet tanpa perlu login manusia.

1. Buka [Google Cloud Console](https://console.cloud.google.com/).
2. Buat project baru (atau pakai project yang ada).
3. Aktifkan **Google Sheets API**:
   `APIs & Services` → `Enable APIs and Services` → cari "Google Sheets API"
   → `Enable`.
4. Buat Service Account:
   `APIs & Services` → `Credentials` → `Create Credentials` →
   `Service Account`. Beri nama bebas, mis. `partograf-tepat-sa`, lalu
   selesaikan (peran/role tidak perlu diisi, biarkan default).
5. Buka Service Account yang baru dibuat → tab **Keys** → `Add Key` →
   `Create new key` → pilih **JSON** → unduh filenya.
6. Buka file JSON tersebut, catat dua nilai ini:
   - `client_email` → contoh: `partograf-tepat-sa@nama-project.iam.gserviceaccount.com`
   - `private_key` → teks panjang diawali `-----BEGIN PRIVATE KEY-----`

## LANGKAH 3 — Bagikan Spreadsheet ke Service Account

1. Buka spreadsheet Google Sheets kamu.
2. Klik **Share/Bagikan**.
3. Tempel email `client_email` dari file JSON tadi.
4. Beri akses **Editor**.
5. Klik **Send/Kirim** (boleh matikan notifikasi email).

> Tanpa langkah ini, server akan menolak akses dengan error `403` — dan
> pesan error itu akan langsung terlihat jelas di aplikasi (lihat bagian
> Troubleshooting di bawah), bukan hang tanpa penjelasan.

## LANGKAH 4 — Deploy ke Vercel

### Opsi A — lewat Vercel Dashboard (paling mudah)

1. Push folder project ini ke repository GitHub/GitLab/Bitbucket.
2. Buka [vercel.com](https://vercel.com) → `Add New` → `Project` → import
   repository tadi.
3. Saat pengaturan project muncul, buka bagian **Environment Variables**,
   tambahkan tiga variabel ini:

   | Name | Value |
   |---|---|
   | `GOOGLE_SHEET_ID` | ID spreadsheet dari Langkah 1 |
   | `GOOGLE_SERVICE_ACCOUNT_EMAIL` | `client_email` dari Langkah 2 |
   | `GOOGLE_PRIVATE_KEY` | `private_key` dari Langkah 2 (tempel apa adanya, lihat catatan di bawah) |

   **Catatan soal `GOOGLE_PRIVATE_KEY`:** di file JSON, private key punya
   baris baru sungguhan. Kalau kamu tempel ke kotak env var Vercel sebagai
   satu blok teks utuh (multi-baris, termasuk `-----BEGIN...` dan
   `-----END...`), itu **sudah benar** dan tidak perlu diubah — kode di
   `lib/sheets.js` sudah menangani kedua kemungkinan format (baris baru asli
   maupun `\n` literal).

4. Klik **Deploy**.

### Opsi B — lewat Vercel CLI

```bash
npm install -g vercel
cd folder-project-ini
vercel login
vercel

# isi environment variables:
vercel env add GOOGLE_SHEET_ID
vercel env add GOOGLE_SERVICE_ACCOUNT_EMAIL
vercel env add GOOGLE_PRIVATE_KEY

# deploy ke production:
vercel --prod
```

### Coba di lokal dulu (opsional)

```bash
npm install
cp .env.example .env
# isi .env dengan tiga nilai di atas
vercel dev
```

---

## LANGKAH 5 — Verifikasi

Setelah deploy selesai, buka:

```
https://nama-project-kamu.vercel.app/api/health
```

- Kalau muncul `{"ok": true, ...}` → konfigurasi sudah benar, aplikasi siap
  dipakai, buka domain utamanya di browser.
- Kalau muncul `{"ok": false, "error": "..."}` → pesan error-nya akan
  memberi tahu persis apa yang belum beres (lihat Troubleshooting).

---

## Troubleshooting — kalau masih "loading terus"

Beda dengan versi Apps Script, di versi ini setiap pemanggilan API dibungkus
`try/catch` dan **selalu** membalas pesan JSON yang jelas (bukan diam saja),
jadi kalau layar masih terus berputar, buka **Developer Tools browser (F12)**
→ tab **Network**, lalu lihat respons dari `/api/dashboard` atau
`/api/monitoring`:

| Pesan error | Penyebab | Solusi |
|---|---|---|
| `Environment variable belum diatur...` | Env var belum diisi di Vercel | Ulangi Langkah 4 poin 3, lalu **redeploy** (env var baru butuh deploy ulang) |
| `error: 403` / `The caller does not have permission` | Sheet belum dibagikan ke Service Account | Ulangi Langkah 3 |
| `Requested entity was not found` | `GOOGLE_SHEET_ID` salah | Cek ulang ID di URL spreadsheet |
| `invalid_grant` / JWT error | `GOOGLE_PRIVATE_KEY` terpotong/rusak saat disalin | Salin ulang isi `private_key` dari file JSON apa adanya |
| Halaman putih polos, tidak ada apa-apa | `public/index.html` tidak ke-deploy sebagai static file | Pastikan struktur folder persis seperti di atas (`public/` di root project) |

Cek juga **Vercel Dashboard → Deployments → pilih deployment → Functions
Logs** untuk melihat pesan error lengkap dari server.

---

## Catatan Keamanan (penting dibaca)

- Login di aplikasi ini (`admin/admin123`, dst.) **masih dicek di sisi
  browser** (persis seperti versi sebelumnya) — ini cukup untuk membedakan
  tampilan menu per peran, tapi **bukan otentikasi yang aman** untuk data
  klinis produksi karena kredensialnya terlihat di kode frontend.
- Untuk penggunaan resmi, sebaiknya:
  1. Pindahkan pengecekan username/password ke sebuah API route baru
     (mis. `api/login.js`) yang membandingkan dengan nilai di Environment
     Variables Vercel (bukan hardcoded di HTML).
  2. Gunakan cookie sesi (mis. `iron-session` atau JWT) supaya status login
     tervalidasi di server, bukan hanya `localStorage` di browser.
  3. Pertimbangkan Vercel/Google SSO kalau penggunanya staf rumah sakit yang
     sudah punya akun Google institusi.
- Jangan commit file `.env` yang berisi nilai asli ke Git (`.gitignore`
  sudah menyertakan ini).
