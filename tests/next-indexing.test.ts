import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildTsconfig, documentAllowed } from "../src/static/scip/runner.ts";
import { validateConfig, type RepoConfig } from "../src/config/repos.ts";

describe("Next.js static indexing", () => {
  test("uses static-only configuration and excludes generated output", () => {
    const config = validateConfig({ repos: [{
      name: "frontend", rootPath: "D:/frontend", serviceName: "frontend",
      lang: "ts", framework: "nextjs", entrypoint: "", include: ["app/**", "lib/**"],
      exclude: [".next/**", "node_modules/**"], baseUrlEnvVars: [], port: 3000,
    }] }, { checkPaths: false });
    const frontend = config.repos[0]!;
    const tsconfig = buildTsconfig(frontend) as { include: string[]; exclude: string[] };

    assert.equal(frontend.framework, "nextjs");
    assert.equal(frontend.entrypoint, "");
    assert.deepEqual(tsconfig.include, ["app/**/*", "lib/**/*"]);
    assert.deepEqual(tsconfig.exclude, [".next/**/*", "node_modules/**/*"]);
    assert.equal(documentAllowed(frontend, "app/page.tsx"), true);
    assert.equal(documentAllowed(frontend, ".next/types/app.d.ts"), false);
  });

  test("does not accidentally broaden the declared static file set", () => {
    const frontend: RepoConfig = {
      name: "frontend", rootPath: "D:/frontend", serviceName: "frontend", lang: "ts",
      framework: "nextjs", entrypoint: "", include: ["app/**"], exclude: [".next/**"],
      baseUrlEnvVars: [], port: 3000, tsconfig: null, pythonBin: null,
    };
    assert.equal(documentAllowed(frontend, "components/Button.tsx"), false);
    assert.equal(documentAllowed(frontend, "app/page.tsx"), true);
  });
});
