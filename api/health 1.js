module.exports = async (req, res) => {
  const ok = !!process.env.APPS_SCRIPT_URL;
  if (!ok) {
    return res.status(500).json({
      ok: false,
      error: 'APPS_SCRIPT_URL belum diatur di Environment Variables Vercel.'
    });
  }
  return res.status(200).json({
    ok: true,
    message: 'Backend: Google Apps Script (via proxy).',
    appsScriptConfigured: true
  });
};
