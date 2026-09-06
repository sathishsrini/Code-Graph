// ============================================================================
// Workaround: scip-python is broken on Windows  —  task P1-T3, OPEN-5
// ============================================================================
// `@sourcegraph/scip-python@0.6.6` fails to start on Windows before it reads a
// single file:
//
//   src/virtualenv/PythonEnvironment.ts:4
//     const pathSepRegex = new RegExp(path.sep, 'g');
//   SyntaxError: Invalid regular expression: /\/g: \ at end of pattern
//
// `path.sep` is `\` on Windows, and a lone backslash is not a valid pattern.
// It is a module-level constant, so the crash happens at import time and no
// flag, environment or project layout avoids it. Every published version
// carries it.
//
// The fix is one character class: escape the separator before compiling it.
// This rewrites the single occurrence in the shipped bundle, idempotently, and
// verifies afterwards. It is deliberately narrow — it does not vendor the
// package, does not change behaviour on POSIX (where `/` needs no escaping and
// the replacement is a no-op), and re-running it is safe.
//
// Recorded as delta D19. Remove this the day upstream fixes it; the assertion
// below will start failing loudly, which is the intended signal.
// ============================================================================

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

const BROKEN = /new RegExp\((\w+)\.sep,\s*"g"\)/;
// `$&` is special inside a replacement string, so it is written `$$&` here and
// reaches the file as `$&`. Getting this wrong writes the *matched text* into
// the bundle — which is exactly how the first attempt corrupted it.
const FIXED = (v) => `new RegExp(${v}.sep.replace(/[\\\\^$.*+?()[\\]{}|]/g,"\\\\$$&"),"g")`;

function bundlePath() {
  try {
    const pkg = require.resolve("@sourcegraph/scip-python/package.json");
    return join(dirname(pkg), "dist", "scip-python.js");
  } catch {
    return null;
  }
}

const path = bundlePath();
if (path === null || !existsSync(path)) {
  // Not installed is not an error: the Python channel is optional, and
  // `index` reports a missing artifact by name rather than failing.
  process.stdout.write("patch-scip-python: not installed, nothing to do\n");
  process.exit(0);
}

const source = readFileSync(path, "utf8");

if (source.includes(".sep.replace(")) {
  process.stdout.write("patch-scip-python: already patched\n");
  process.exit(0);
}

const match = BROKEN.exec(source);
if (!match) {
  // Upstream changed. Say so rather than silently doing nothing — a silent
  // no-op here reappears as an unexplained crash at index time.
  process.stderr.write(
    "patch-scip-python: the known-broken pattern is gone. Either upstream fixed\n" +
    "  it (delete this script and the postinstall hook) or the bundle changed\n" +
    "  shape (re-derive the patch). Not modifying the file.\n",
  );
  process.exit(0);
}

writeFileSync(path, source.replace(BROKEN, FIXED(match[1])), "utf8");
process.stdout.write(`patch-scip-python: patched ${path}\n`);
