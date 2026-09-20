const { callApps, route } = require('../lib/apps');

module.exports = route({
  POST: (req) => {
    const b = req.body || {};
    return callApps('login', '', {
      username: String(b.username || ''),
      password: String(b.password || '')
    });
  }
});
