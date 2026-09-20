const { bearer, callApps, route } = require('../lib/apps');

module.exports = route({
  GET: (req) => {
    const q = req.query || {};
    const filter = {
      tanggalDari: q.tanggalDari,
      tanggalSampai: q.tanggalSampai,
      status: q.status,
      bidan: q.bidan,
      kode: q.kode
    };
    return callApps('monitoring', bearer(req), { filter });
  },

  POST: (req) => callApps('save', bearer(req), { data: req.body || {} }),

  DELETE: (req) => callApps('delete', bearer(req), { row: Number((req.query || {}).row) })
});
