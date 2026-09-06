// Reviewed security rule loader (task P1-T9, R20).
//
// This intentionally parses the small, fixed YAML subset used by
// rules/check-kinds.yml instead of adding a general YAML dependency. The
// result is configuration for a later detector; this module writes no facts.

import { readFileSync } from "node:fs";

export type CheckKind = "auth" | "tenant" | "rbac" | "ratelimit" | string;

export interface CheckKindRules {
  byName: Map<string, CheckKind>;
}

export function loadCheckKindRules(path: string): CheckKindRules {
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  const byName = new Map<string, CheckKind>();
  let current: CheckKind | null = null;

  for (const [index, raw] of lines.entries()) {
    const line = raw.replace(/\s+#.*$/, "").trimEnd();
    if (line.trim() === "" || line.trim().startsWith("#") || line.trim() === "check_kinds:") continue;

    const kind = /^  ([A-Za-z0-9_-]+):$/.exec(line);
    if (kind) {
      current = kind[1]!;
      continue;
    }

    const helper = /^    - ([A-Za-z0-9_$.-]+)$/.exec(line);
    if (helper && current) {
      byName.set(helper[1]!, current);
      continue;
    }

    throw new Error(`invalid check-kinds.yml at line ${index + 1}: ${raw}`);
  }

  if (byName.size === 0) throw new Error("check-kinds.yml contains no helper rules");
  return { byName };
}

export function classifyCheckKind(
  helperName: string, rules: CheckKindRules,
): CheckKind | null {
  return rules.byName.get(helperName) ?? null;
}

export function classifyHelpers(
  helperNames: string[], rules: CheckKindRules,
): Array<{ helperName: string; checkKind: CheckKind }> {
  return helperNames.flatMap((helperName) => {
    const checkKind = classifyCheckKind(helperName, rules);
    return checkKind ? [{ helperName, checkKind }] : [];
  });
}
