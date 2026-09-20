// Helper bersama untuk semua API route: memanggil backend Google Apps Script
// (semua lewat POST + token sesi di body, supaya token tidak muncul di URL).

const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status || 500;
  }
}

/** Ambil token dari header "Authorization: Bearer <token>". */
function bearer(req) {
  const h = (req.headers && req.headers['authorization']) || '';
  const m = String(h).match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

/** Panggil aksi di Apps Script. Melempar ApiError bila backend membalas error. */
async function callApps(action, token, data) {
  if (!APPS_SCRIPT_URL) {
    throw new ApiError('APPS_SCRIPT_URL belum diatur di Environment Variables Vercel.', 500);
  }

  const r = await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(Object.assign({}, data || {}, { action: action, token: token || '' }))
  });

  const text = await r.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch (e) {
    throw new ApiError('Respons backend tidak valid: ' + text.slice(0, 200), 502);
  }

  if (body && !Array.isArray(body) && body.error) {
    throw new ApiError(body.error, Number(body.code) || 400);
  }
  if (!r.ok) {
    throw new ApiError('Backend status ' + r.status, 502);
  }
  return body;
}

/** Bungkus handler agar semua error jadi JSON {error} dengan status yang benar. */
function route(handlers) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const fn = handlers[req.method];
      if (!fn) {
        res.setHeader('Allow', Object.keys(handlers).join(', '));
        return res.status(405).json({ error: 'Method tidak didukung.' });
      }
      const out = await fn(req);
      return res.status(200).json(out);
    } catch (e) {
      if (!(e instanceof ApiError)) console.error(e);
      return res.status(e.status || 500).json({ error: e.message || 'Terjadi kesalahan pada server.' });
    }
  };
}

module.exports = { ApiError, bearer, callApps, route };
