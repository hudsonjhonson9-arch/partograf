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

    if (req.method === 'GET') {
      const data = await appsGet('monitoring', req.query || {});
      return res.status(200).json(data);
    }
    if (req.method === 'POST') {
      const data = await appsPost({ action: 'save', data: req.body || {} });
      return res.status(200).json(data);
    }
    if (req.method === 'DELETE') {
      const data = await appsPost({ action: 'delete', row: Number((req.query || {}).row) });
      return res.status(200).json(data);
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'Method tidak didukung.' });

  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'Terjadi kesalahan pada server.' });
  }
};
