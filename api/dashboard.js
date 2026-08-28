const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;

async function appsGet(action, params) {
  const url = new URL(APPS_SCRIPT_URL);
  url.searchParams.set('action', action);
  if (params) {
    Object.entries(params).forEach(([k, v]) => { if (v) url.searchParams.set(k, v); });
  }
  return handle(await fetch(url.toString()));
}

async function appsPost(payload) {
  return handle(await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(payload)
  }));
}

async function handle(r) {
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { throw new Error('Respons backend tidak valid: ' + text.slice(0, 200)); }
  if (!r.ok || body.error) throw new Error(body.error || ('Backend status ' + r.status));
  return body;
}

module.exports = async (req, res) => {
  try {
    if (!APPS_SCRIPT_URL) {
      return res.status(500).json({ error: 'APPS_SCRIPT_URL belum diatur di Environment Variables Vercel.' });
    }
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ error: 'Method tidak didukung.' });
    }
    const data = await appsGet('dashboard');
    res.status(200).json(data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Terjadi kesalahan pada server.' });
  }
};
