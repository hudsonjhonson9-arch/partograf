const { bearer, callApps, route } = require('../lib/apps');

module.exports = route({
  GET: (req) => callApps('me', bearer(req))
});
