const { bearer, callApps, route } = require('../lib/apps');

// Ganti password akun yang sedang login.
module.exports = route({
  POST: (req) => {
    const b = req.body || {};
    return callApps('changePassword', bearer(req), {
      oldPassword: String(b.oldPassword || ''),
      newPassword: String(b.newPassword || '')
    });
  }
});
