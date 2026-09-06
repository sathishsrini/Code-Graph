#!/usr/bin/env node
'use strict';
// ============================================================================
// Fastify boot-time reflection  —  task P0-T8  (R21, R24, R25)
// ============================================================================
// Routes and middleware ORDER are a runtime-reflection problem, not a static
// analysis problem. This harness boots a Fastify service far enough to ask it
// what it registered, then stops before it binds a port.
//
// Two properties are deliberate:
//
//   1. THE TARGET REPO IS NOT MODIFIED. Real services build their app at module
//      scope and call listen() immediately; they do not export the instance.
//      An adapter that required `module.exports = app` would need a patch in
//      every repo it indexes, so instead `require('fastify')` is intercepted
//      and the instance captured from the factory call.
//
//   2. ANONYMOUS HOOKS STILL GET AN IDENTITY. `addHook('onRequest', async () => …)`
//      is the dominant idiom and fn.name is "". The V8 inspector's
//      [[FunctionLocation]] yields file:line:col for any function object, which
//      is both a stable key and the thing that joins a hook to its SCIP symbol.
//      The plan proposed renaming the fixture's arrow hooks instead; that fixes
//      the fixture and not the engine. See docs/measurements.md M6.
//
// CommonJS (.cjs) because the target is CommonJS and package.json is
// "type": "module".
//
//   node adapters/fastify/boot-dump.cjs --entry <server.js> --service <name> --out <file>
// ============================================================================

const path = require('node:path');
const fs = require('node:fs');
const Module = require('node:module');
const inspector = require('node:inspector');
const { fileURLToPath } = require('node:url');

// ---------------------------------------------------------------------------
// Function location resolver
// ---------------------------------------------------------------------------

/**
 * Recovers `file:line:col` for arbitrary function objects via the V8 inspector.
 *
 * This is what makes anonymous hooks usable. Without it the boot dump reports a
 * chain of hooks all named "", which is not something a route_chain row can be
 * keyed on and not something a developer can read.
 */
class FunctionLocator {
  constructor() {
    this.session = new inspector.Session();
    this.session.connect();
    this.scripts = new Map();
    this.session.on('Debugger.scriptParsed', (m) => {
      this.scripts.set(m.params.scriptId, m.params.url);
    });
    this.enabled = false;
  }

  post(method, params) {
    return new Promise((resolve, reject) => {
      this.session.post(method, params, (err, res) => (err ? reject(err) : resolve(res)));
    });
  }

  async enable() {
    await this.post('Debugger.enable');
    await this.post('Runtime.enable');
    this.enabled = true;
  }

  /** @returns {Promise<{file:string|null,line:number,col:number}|null>} */
  async locate(fn) {
    if (typeof fn !== 'function' || !this.enabled) return null;
    try {
      globalThis.__codeintel_fn__ = fn;
      const ev = await this.post('Runtime.evaluate', {
        expression: 'globalThis.__codeintel_fn__',
      });
      if (!ev.result || !ev.result.objectId) return null;
      const props = await this.post('Runtime.getProperties', {
        objectId: ev.result.objectId,
        ownProperties: false,
        generatePreview: false,
      });
      const loc = (props.internalProperties || [])
        .find((p) => p.name === '[[FunctionLocation]]');
      if (!loc || !loc.value || !loc.value.value) return null;
      const { scriptId, lineNumber, columnNumber } = loc.value.value;
      const url = this.scripts.get(scriptId);
      return {
        file: url && url.startsWith('file:') ? fileURLToPath(url) : (url || null),
        line: lineNumber + 1,       // inspector is 0-based; SCIP rows are 1-based
        col: columnNumber,
      };
    } catch {
      return null;
    } finally {
      delete globalThis.__codeintel_fn__;
    }
  }

  close() { try { this.session.disconnect(); } catch { /* already gone */ } }
}

// ---------------------------------------------------------------------------
// Fastify interception
// ---------------------------------------------------------------------------

/** Fastify request lifecycle, in execution order. R21 wants the chain ordered. */
const LIFECYCLE = [
  'onRequest', 'preParsing', 'preValidation', 'preHandler',
  '@handler',
  'preSerialization', 'onSend', 'onResponse',
];
/** Off the request path — captured, but never placed in the ordered chain. */
const OFF_PATH = ['onError', 'onTimeout', 'onRequestAbort'];

/**
 * Fastify keeps each instance's merged hook set on a well-known symbol. A child
 * instance created by `register` receives a CLONE of its parent's arrays, so
 * `instance[kHooks]` is already the inherited chain — no manual walk needed.
 *
 * Two things about this are load-bearing and were established by measurement,
 * not by reading the docs (docs/measurements.md M6):
 *
 *   - `routeOptions` in an `onRoute` hook carries ONLY route-level hooks.
 *     Reading the chain from it reports handler-only chains for every route,
 *     which would make every route look unauthenticated.
 *   - `instance[kHooks]` is NOT yet populated when `onRoute` fires for a
 *     root-level route: `addHook` on the root is deferred through avvio. It is
 *     final only after `ready()`. So the owning instance is captured during
 *     `onRoute` and read afterwards.
 */
function findHooksSymbol(instance) {
  return Object.getOwnPropertySymbols(instance)
    .find((s) => String(s) === 'Symbol(fastify.hooks)') || null;
}

function interceptFastify(onInstance, { quiet }) {
  const originalLoad = Module._load;
  const wrapped = new WeakMap();

  Module._load = function (request) {
    const exported = originalLoad.apply(this, arguments);
    if (request !== 'fastify' || typeof exported !== 'function') return exported;
    if (wrapped.has(exported)) return wrapped.get(exported);

    const factory = function fastifyIntercepted(opts) {
      // Silence the app's own logger so it cannot interleave with JSON on
      // stdout. Fastify substitutes a no-op logger, so app.log.* still works.
      const effective = quiet ? { ...(opts || {}), logger: false } : opts;
      const app = exported(effective);
      onInstance(app);
      return app;
    };
    // Preserve fastify.fastify / fastify.default / any statics.
    Object.assign(factory, exported);
    factory.fastify = factory;
    factory.default = factory;

    wrapped.set(exported, factory);
    return factory;
  };

  return () => { Module._load = originalLoad; };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const USAGE = `fastify boot-dump — emit routes + ordered hook chains (P0-T8)

  node adapters/fastify/boot-dump.cjs --entry <server.js> [options]

  --entry <path>     Service entrypoint (required)
  --service <name>   Service name for the emitted JSON (default: repo dir name)
  --out <path>       Write JSON here (default: stdout)
  --cwd <path>       chdir before requiring (default: the entry's directory)
  --no-quiet         Leave the app's logger enabled
  --overview         Also register fastify-overview for its plugin tree.
                     Off by default: it misses module-scope routes and emits
                     random ids. See docs/measurements.md M6.
`;

function parseArgv(argv) {
  const out = {
    entry: '', service: '', out: '', cwd: '',
    quiet: true, overview: false, help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--entry') out.entry = argv[++i];
    else if (a === '--service') out.service = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--cwd') out.cwd = argv[++i];
    else if (a === '--no-quiet') out.quiet = false;
    else if (a === '--overview') out.overview = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

async function main() {
  const args = parseArgv(process.argv.slice(2));
  if (args.help || !args.entry) {
    process.stderr.write(USAGE);
    return args.help ? 0 : 2;
  }

  const entry = path.resolve(args.entry);
  if (!fs.existsSync(entry)) {
    process.stderr.write(`boot-dump: entry not found: ${entry}\n`);
    return 2;
  }
  const repoRoot = args.cwd ? path.resolve(args.cwd) : path.dirname(entry);
  const service = args.service || path.basename(repoRoot);

  const wantOverview = args.overview;

  const locator = new FunctionLocator();
  await locator.enable();

  let app = null;
  let kHooks = null;
  /** onRoute payloads plus the instance that owns each route, in order. */
  const routeRecords = [];
  /** Every encapsulation scope, so a hook can be attributed to its declarer. */
  const scopes = [];
  const warnings = [];

  const restore = interceptFastify((instance) => {
    if (app) {
      warnings.push('more than one Fastify instance was created; reflecting the first');
      return;
    }
    app = instance;
    kHooks = findHooksSymbol(instance);
    if (!kHooks) {
      // Never fall back to a handler-only chain: an empty chain and an
      // unreadable one look identical downstream, and one of them is a lie.
      warnings.push(
        'FATAL: Symbol(fastify.hooks) not found on the instance — this Fastify ' +
        'version stores hooks elsewhere. Inherited hook chains CANNOT be read ' +
        'and every chain below is handler-only. Do not treat this dump as ' +
        'evidence of an unhooked route.',
      );
    }
    // The root's pluginName is the opaque string "fastify"; call it "root".
    scopes.push({ instance, name: 'root', depth: 0 });

    // R21 names fastify-overview as the boot-reflection source. It is OFF by
    // default here, and the reasons are measured rather than stylistic
    // (docs/measurements.md M6):
    //
    //   1. It instruments when its own plugin body runs — during ready() —
    //      so it sees 0 of 23 routes on a service that registers at module
    //      scope, which is the common single-file shape.
    //   2. With addSource:true it THROWS during boot on such a service,
    //      taking the whole dump with it.
    //   3. It stamps Math.random() tracking ids into its tree, which makes
    //      the dump non-reproducible run to run.
    //
    // None of the chain depends on it: hooks come from Fastify directly. It
    // stays available for plugin-structured apps, where its tree is sound.
    if (wantOverview) {
      try {
        instance.register(require('fastify-overview'), { addSource: false });
      } catch (e) {
        warnings.push(`fastify-overview unavailable: ${e.message}`);
      }
    }

    instance.addHook('onRegister', function trackScope(child) {
      const parent = Object.getPrototypeOf(child);
      const parentScope = scopes.find((s) => s.instance === parent);
      scopes.push({
        instance: child,
        name: child.pluginName || 'anonymous plugin',
        depth: parentScope ? parentScope.depth + 1 : 1,
      });
    });

    instance.addHook('onRoute', function captureRoute(routeOptions) {
      const rec = {
        method: routeOptions.method,
        url: routeOptions.url,
        prefix: routeOptions.prefix,
        handler: routeOptions.handler,
        constraints: routeOptions.constraints || null,
        hasSchema: Boolean(routeOptions.schema),
        logLevel: routeOptions.logLevel || null,
        // `this` is the encapsulated instance that owns this route. Its merged
        // hook set is read after ready(), not now.
        owner: this,
        routeLevel: {},
      };
      for (const phase of [...LIFECYCLE.filter((p) => p !== '@handler'), ...OFF_PATH]) {
        const v = routeOptions[phase];
        if (!v) continue;
        rec.routeLevel[phase] = Array.isArray(v) ? v.slice() : [v];
      }
      routeRecords.push(rec);
    });

    // Never bind a port. Reflection must not make the service reachable.
    instance.listen = function bootDumpListenStub() {
      return Promise.resolve('http://127.0.0.1:0 (boot-dump: listen suppressed)');
    };
  }, { quiet: args.quiet });

  const prevCwd = process.cwd();
  let bootError = null;
  try {
    process.chdir(repoRoot);
    if (args.quiet) {
      // Keep the app's own pino output off stdout, which carries our JSON.
      process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';
    }
    require(entry);
    if (!app) {
      process.stderr.write('boot-dump: entry did not construct a Fastify instance\n');
      return 3;
    }
    await app.ready();
  } catch (e) {
    bootError = e;
  } finally {
    restore();
    process.chdir(prevCwd);
  }

  if (bootError) {
    process.stderr.write(`boot-dump: boot failed: ${bootError.stack || bootError.message}\n`);
    locator.close();
    return 4;
  }

  const dump = await buildDump({
    app, routeRecords, scopes, kHooks, locator, repoRoot, service, entry, warnings,
    wantOverview,
  });
  locator.close();

  const json = JSON.stringify(dump, null, 2) + '\n';
  if (args.out) {
    const outPath = path.resolve(args.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, json, 'utf8');
    process.stderr.write(
      `boot-dump: ${dump.stats.routes} routes, ` +
      `${dump.stats.chainEntries} chain entries -> ${outPath}\n`,
    );
  } else {
    process.stdout.write(json);
  }

  try { await app.close(); } catch { /* nothing was listening */ }
  return 0;
}

// ---------------------------------------------------------------------------
// Dump construction
// ---------------------------------------------------------------------------

async function buildDump({
  app, routeRecords, scopes, kHooks, locator, repoRoot, service, entry, warnings,
  wantOverview,
}) {
  const rel = (abs) => {
    if (!abs) return null;
    const r = path.relative(repoRoot, abs);
    return (r.startsWith('..') ? abs : r).split(path.sep).join('/');
  };

  /**
   * Which encapsulation scope declared this hook (R6 `inherited_from`).
   *
   * Child scopes hold a clone of the parent's arrays, so the OUTERMOST scope
   * whose own hook array contains this exact function is the one that declared
   * it. Anything shallower than the route's own scope is inherited.
   */
  const declaringScope = (fn, phase) => {
    if (!kHooks) return null;
    let best = null;
    for (const s of scopes) {
      const arr = (s.instance[kHooks] || {})[phase];
      if (Array.isArray(arr) && arr.includes(fn)) {
        if (!best || s.depth < best.depth) best = s;
      }
    }
    return best;
  };

  /** Resolve one function to a stable, human-usable chain entry. */
  const describe = async (fn) => {
    const loc = await locator.locate(fn);
    const file = loc ? rel(loc.file) : null;
    const name = (fn && fn.name) || '';
    return {
      name: name || null,
      // Anonymous hooks are the common case, so the key is positional. This is
      // what a route_chain row is keyed on, and what joins a hook to the SCIP
      // definition whose enclosingRange contains this line.
      key: file && loc ? `${file}:${loc.line}:${loc.col}` : (name || 'unknown'),
      file,
      line: loc ? loc.line : null,
      col: loc ? loc.col : null,
      anonymous: name === '',
    };
  };

  const routes = [];
  let chainEntries = 0;

  for (const rec of routeRecords) {
    const methods = Array.isArray(rec.method) ? rec.method : [rec.method];
    const ownerHooks = (kHooks && rec.owner[kHooks]) || {};
    const ownerScope = scopes.find((s) => s.instance === rec.owner) || null;

    /**
     * Fastify's own merge order: inherited instance hooks first, then hooks
     * passed in the route definition. `origin` records which of the two a hook
     * came from, because they behave differently — a scope hook covers every
     * route in that scope, a route hook covers exactly one.
     */
    const forPhase = (phase) => [
      ...(Array.isArray(ownerHooks[phase]) ? ownerHooks[phase] : [])
        .map((fn) => ({ fn, origin: 'scope' })),
      ...(rec.routeLevel[phase] || []).map((fn) => ({ fn, origin: 'route' })),
    ];

    const chainEntry = async (fn, phase, origin) => {
      const described = await describe(fn);
      const scope = origin === 'scope' ? declaringScope(fn, phase) : ownerScope;
      // Fastify injects hooks of its own (headRouteOnSendHandler on every auto
      // HEAD route). They belong in the chain but are not the service's code.
      const framework = Boolean(
        described.file && /(^|\/)node_modules\//.test(described.file),
      );
      return {
        phase,
        ...described,
        origin: framework ? 'framework' : origin,
        declaredIn: scope ? scope.name : null,
        inheritedFrom:
          origin === 'scope' && scope && ownerScope && scope.depth < ownerScope.depth
            ? scope.name
            : null,
      };
    };

    const chain = [];
    let position = 0;
    for (const phase of LIFECYCLE) {
      if (phase === '@handler') {
        chain.push({
          position: position++,
          ...(await chainEntry(rec.handler, 'handler', 'route')),
        });
        continue;
      }
      for (const { fn, origin } of forPhase(phase)) {
        chain.push({ position: position++, ...(await chainEntry(fn, phase, origin)) });
      }
    }

    const offPath = [];
    for (const phase of OFF_PATH) {
      for (const { fn, origin } of forPhase(phase)) {
        offPath.push(await chainEntry(fn, phase, origin));
      }
    }

    chainEntries += chain.length * methods.length;
    for (const method of methods) {
      routes.push({
        method,
        url: rec.url,
        prefix: rec.prefix || '',
        routeKey: `${service} ${method} ${rec.url}`,
        constraints: rec.constraints,
        hasSchema: rec.hasSchema,
        logLevel: rec.logLevel,
        chain,
        offPath,
      });
    }
  }

  // fastify-overview's plugin tree, kept whole: it is the only source of
  // encapsulation structure, which is what `inherited_from` needs in P1-T8.
  let overview = null;
  if (wantOverview) {
    try {
      overview = typeof app.overview === 'function' ? app.overview() : null;
    } catch (e) {
      warnings.push(`overview() failed: ${e.message}`);
    }
  }
  const overviewRoutes = overview ? countOverviewRoutes(overview) : 0;
  if (wantOverview && routes.length > 0 && overviewRoutes < routes.length) {
    // A PARTIAL tree is more dangerous than an empty one: it looks credible.
    // Fire on any under-report, not just on zero.
    warnings.push(
      `fastify-overview saw ${overviewRoutes} of ${routes.length} routes. Its ` +
      'instrumentation installs when its own plugin body runs, i.e. during ' +
      'ready(); routes registered at module scope are earlier than that and are ' +
      'invisible to it. Its plugin tree is incomplete here and must not be read ' +
      'as the route set. The chains below come from Fastify directly and are ' +
      'unaffected.',
    );
  }

  const count = (pred) =>
    routes.reduce((n, r) => n + r.chain.filter(pred).length, 0);

  return {
    schema: 'codeintel.boot.fastify/1',
    service,
    generatedAt: new Date().toISOString(),
    evidenceKind: 'boot',
    confidence: 'certain',
    tool: {
      adapter: 'boot-dump.cjs',
      fastify: app.version || null,
      fastifyOverview: safeVersion('fastify-overview'),
      node: process.version,
    },
    entrypoint: rel(entry),
    repoRoot: repoRoot.split(path.sep).join('/'),
    stats: {
      routes: routes.length,
      chainEntries,
      anonymousChainEntries: count((c) => c.anonymous),
      unlocatedChainEntries: count((c) => c.file === null),
    },
    routes,
    overview,
    warnings,
  };
}

function countOverviewRoutes(node) {
  const own = (node.routes || []).length;
  return (node.children || []).reduce((n, c) => n + countOverviewRoutes(c), own);
}

function safeVersion(pkg) {
  try { return require(`${pkg}/package.json`).version; } catch { return null; }
}

main().then(
  (code) => { process.exitCode = code; },
  (err) => {
    process.stderr.write(`boot-dump: ${err.stack || err.message}\n`);
    process.exitCode = 1;
  },
);
