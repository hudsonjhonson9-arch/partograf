const { bearer, callApps, route } = require('../lib/apps');

// Manajemen pengguna (hanya ADMIN — dicek di server Apps Script).
module.exports = route({
  GET: (req) => callApps('listUsers', bearer(req)),

  POST: (req) => callApps('createUser', bearer(req), req.body || {}),

  PUT: (req) => callApps('updateUser', bearer(req), req.body || {}),

  DELETE: (req) => callApps('deleteUser', bearer(req), {
    username: String((req.query || {}).username || '')
  })
});
