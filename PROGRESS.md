# Progres Pengembangan — Partograf TEPAT

Aplikasi monitoring kepatuhan dokumentasi Partograf TEPAT (RSU Hoba Kalla, Kab. Sumba Barat).
Arsitektur: frontend statis (`public/index.html`) → serverless API di Vercel (`api/*.js`) → backend Google Apps Script (`code.gs`) → Google Sheets sebagai database.

_Catatan ini dibuat pada 20 September 2026._

---

## Ringkasan status

| Bagian | Status |
|---|---|
| Hitungan kepatuhan per item TEPAT | Selesai, belum diuji dengan data nyata |
| Penghapusan kotak "Akun awal" di halaman login | Selesai |
| Login server-side + sheet `USERS` | Selesai ditulis, **login dari Vercel masih gagal (504)** |
| Manajemen pengguna (tambah/edit/nonaktifkan/hapus) | Selesai ditulis, belum bisa diuji karena login belum tembus |
| Ganti password mandiri | Selesai ditulis, belum diuji |
| Push ke GitHub | Dilakukan sendiri lewat terminal |

---

## Yang sudah dikerjakan

### 1. Hitungan kepatuhan per item
- `code.gs` → `getDashboardData()` kini mengembalikan `perItem` untuk `sebelum` dan `sesudah` (`ya`, `tidak`, `persentase`) serta `peningkatanPerItem`. Fungsi baru: `hitungPerItem_()`.
- `public/index.html`:
  - Dashboard: grafik "Kepatuhan per Item TEPAT" (bar Sebelum vs Sesudah per komponen).
  - Evaluasi / Rekap Sebelum / Rekap Sesudah / Perbandingan: tabel Item × Sebelum × Sesudah × Perubahan.
- Rumus: persentase item = jumlah partograf dinilai "Ya" pada item tsb ÷ jumlah partograf pada kelompok (Sebelum/Sesudah). Kepatuhan keseluruhan (skor 5/5 = PATUH) tetap dipertahankan.

### 2. Halaman login
- Kotak "Akun awal: admin/admin123 · …" dihapus dari `public/index.html`.

### 3. Autentikasi & manajemen pengguna
**Backend (`code.gs`)**
- Sheet baru `USERS`: Username, Nama, Peran, Inisial, Aktif, Salt, Password Hash, Dibuat, Login Terakhir.
- Password disimpan sebagai hash SHA-256 + salt acak (`HASH_ROUNDS = 500`).
- Login menghasilkan token HMAC berlaku 12 jam; token gugur bila akun dinonaktifkan/dihapus atau password diganti.
- Pembatasan percobaan login: 5 kali gagal → terkunci 10 menit (per username).
- Semua aksi lewat `doPost` dan wajib token; peran dicek di server (`routeAuthed_`):
  - Dashboard/data: semua peran · Simpan data: ADMIN, PETUGAS · Hapus data: ADMIN · Kelola pengguna: ADMIN.
  - PETUGAS: inisial bidan di data dipaksa sesuai inisial akunnya.
- Pengaman: ADMIN tidak bisa menghapus/menonaktifkan/menurunkan perannya sendiri; minimal satu ADMIN aktif harus ada.
- Akun bawaan (admin, bidan, pimpinan) otomatis dibuat di sheet `USERS` bila sheet kosong (login pertama atau jalankan `buatAdminAwal()`). Password bawaan bisa diganti lewat menu **Ganti Password** atau direset ADMIN lewat menu **Pengguna**.
- Audit log kini mencatat username aplikasi.
- `doGet` tidak lagi melayani data. Aksi `?action=setup` (yang bisa menghapus semua sheet lewat URL) dihapus; `setupSpreadsheet()` hanya bisa dijalankan manual dari editor dan tidak menghapus sheet `USERS`.

**Vercel**
- `lib/apps.js` (helper bersama), route baru: `api/login.js`, `api/me.js`, `api/users.js`, `api/password.js`; `api/dashboard.js` dan `api/monitoring.js` ditulis ulang agar membawa token. Respons memakai `Cache-Control: no-store`.

**Frontend (`public/index.html`)**
- Akun/password hardcoded dihapus dari kode; login lewat `/api/login`, sesi disimpan sebagai token, cache data dibersihkan saat logout, dan sesi habis (401) mengembalikan ke halaman login.
- Halaman **Pengguna** lengkap (tambah, edit, reset password, aktif/nonaktif, hapus) dan menu **Ganti Password** untuk semua peran.
- Tombol Hapus data hanya tampil untuk ADMIN.
- Perbaikan bug lama: kolom inisial bidan tidak lagi terhapus setelah PETUGAS menyimpan data.

---

## Masalah yang sedang dihadapi

**`POST /api/login` → 504 Gateway Timeout** (setelah ditambah timeout: "Apps Script tidak merespons dalam 20 detik.").

Fakta yang sudah dipastikan:
- Deployment Apps Script sudah **Versi 14** (versi terbaru).
- Eksekusi `doPost` di Apps Script selesai normal dalam ±1,3 detik.
- `APPS_SCRIPT_URL` di Vercel sudah benar (sama dengan URL `/exec` deployment aktif).
- Membuka URL `/exec` di browser membalas `{"ok":true,"message":"PARTOGRAF TEPAT API (Google Apps Script)"}`.
- Error `codes.forEach` dan `chrome-extension://invalid/` di konsol berasal dari ekstensi Chrome, bukan aplikasi; `favicon.ico 404` tidak berpengaruh.

Kesimpulan sementara: permintaan sampai ke Apps Script dan dijawab cepat, tetapi fetch dari fungsi Vercel tidak selesai. Dugaan: macet saat mengikuti redirect 302 Apps Script (POST → `script.googleusercontent.com`). **Belum terbukti.**

Langkah terakhir yang sudah dilakukan: `lib/apps.js` diubah agar redirect diikuti **manual** (POST, lalu GET ke alamat `Location`), dengan timeout 20 detik dan log per langkah (`[apps] aksi ... langkah ...`).

---

## Langkah berikutnya

1. Push dan deploy `lib/apps.js` terbaru ke Vercel:
   ```bash
   git add lib/apps.js
   git commit -m "Ikuti redirect Apps Script secara manual"
   git push
   ```
2. Coba login lagi. Jika masih gagal, ambil baris `[apps] aksi login ...` dari **Vercel → Logs** (filter `/api/login`) untuk melihat langkah mana yang macet dan berapa ms.
3. Setelah login berhasil, uji berurutan: dashboard (per item), input data (PETUGAS), hapus data (hanya ADMIN), menu Pengguna, Ganti Password, dan sesi habis.
4. Jika hashing terasa lambat di Apps Script, kecilkan `HASH_ROUNDS` (mis. 100), lalu kosongkan sheet `USERS` dan jalankan ulang `buatAdminAwal()` (hash lama tidak akan cocok).

---

## Checklist sebelum/sesudah push ke GitHub

- [ ] `VERCEL_ENV.txt` berisi `APPS_SCRIPT_URL` dan **tidak** ada di `.gitignore`. Jika repo public, tambahkan ke `.gitignore` dan `git rm --cached VERCEL_ENV.txt`. Jika sudah terlanjur ter-push, buat deployment Apps Script baru (URL berubah) lalu perbarui env var di Vercel.
- [ ] `code.gs` memuat password akun bawaan dan `SPREADSHEET_ID`. Jika repo public, password itu terbaca siapa saja: ganti password ketiga akun setelah login pertama, atau jadikan repo private.
- [ ] Sheet `USERS` berisi hash password: jangan bagikan spreadsheet ke pihak yang tidak berhak.

---

## Catatan & ide lanjutan

- `index.html` di root proyek tidak diubah (ukurannya berbeda dari `public/index.html`, kemungkinan versi lama); README masih menyebut Google Sheets API + service account dan perlu diperbarui.
- Opsional: wajibkan ganti password saat pertama kali login dengan akun bawaan.
- Pengunci login berbasis username bisa dimanfaatkan untuk mengunci akun orang lain (5 kali salah = terkunci 10 menit); dinilai wajar untuk aplikasi internal ini.
