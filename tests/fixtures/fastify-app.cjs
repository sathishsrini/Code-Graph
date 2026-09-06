'use strict';
// Fixture for the boot-dump adapter (P0-T8).
//
// Shaped to exercise what the dev-workspace corpus cannot: plugin nesting and
// inherited hook chains. The corpus has zero plugins and no preHandler hooks,
// so a dump that reads only root-level hooks would pass against it while being
// wrong. Line numbers are asserted in tests/boot-dump.test.ts — adding a line
// above an existing hook means updating that test.
//
// Mirrors a real service: built at module scope, listens immediately, exports
// nothing. The adapter must cope without any cooperation from this file.

const Fastify = require('fastify');

const app = Fastify({ logger: true });

// L18: anonymous arrow — the dominant idiom, and fn.name is "".
app.addHook('onRequest', async (req, reply) => {
  req.startTime = Date.now();
});

// L23: named function expression, so fn.name is usable.
app.addHook('onResponse', async function logResponse(req, reply) {
  void req; void reply;
});

// L28: root route, inherits both root hooks and nothing else.
app.get('/health', async () => ({ status: 'ok' }));

// L31: route-level preHandler — present in routeOptions but NOT in the
// instance hook set, so the two sources must be merged, in this order.
app.post('/guarded', {
  preHandler: async function routeGuard(req, reply) { void req; void reply; },
}, async function guardedHandler() { return { ok: true }; });

// L37: an encapsulated plugin. Its routes inherit the root hooks above and add
// their own — the case the corpus cannot produce.
app.register(async function billingPlugin(instance) {
  instance.addHook('preHandler', async function requireTenant(req, reply) {
    void req; void reply;
  });
  instance.get('/invoice', async function listInvoices() { return []; });
}, { prefix: '/billing' });

app.listen({ port: 0, host: '127.0.0.1' })
  .then(() => app.log.info('fixture listening'))
  .catch((err) => { app.log.error(err); process.exit(1); });
