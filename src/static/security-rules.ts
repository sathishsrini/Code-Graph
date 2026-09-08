// Reviewed security rule loader (task P1-T9, R20).
//
// This intentionally parses the small, fixed YAML subset used by
// rules/check-kinds.yml instead of adding a general YAML dependency. The
// result is configuration for a later detector; this module writes no facts.

import { readFileSync } from "node:fs";

export type CheckKind = "auth" | "tenant" | "rbac" | "ratelimit" | string;

export interface CheckKindRules {
  byName: Map<string, CheckKind>;
  /**
   * Functions whose return value IS an error (R76, P1-T17).
   *
   * Kept in the same reviewed file as the check kinds for the same reason:
   * "is `envelopeError` an error builder" is a judgement about a codebase, not
   * something to infer from a name.
   */
  errorBuilders: Set<string>;
}

export function loadCheckKindRules(path: string): CheckKindRules {
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  const byName = new Map<string, CheckKind>();
  const errorBuilders = new Set<string>();
  let current: CheckKind | null = null;
  // The file carries two vocabularies with the same shape. `section` is what
  // decides which map a `- name` line lands in.
  let section: "check_kinds" | "error_builders" = "check_kinds";

  for (const [index, raw] of lines.entries()) {
    const line = raw.replace(/\s+#.*$/, "").trimEnd();
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    if (line.trim() === "check_kinds:") { section = "check_kinds"; current = null; continue; }
    if (line.trim() === "error_builders:") { section = "error_builders"; current = null; continue; }

    const kind = /^  ([A-Za-z0-9_-]+):$/.exec(line);
    if (kind) {
      current = kind[1]!;
      continue;
    }

    const helper = /^    - ([A-Za-z0-9_$.-]+)$/.exec(line);
    if (helper && current) {
      if (section === "error_builders") errorBuilders.add(helper[1]!);
      else byName.set(helper[1]!, current);
      continue;
    }

    throw new Error(`invalid check-kinds.yml at line ${index + 1}: ${raw}`);
  }

  if (byName.size === 0) throw new Error("check-kinds.yml contains no helper rules");
  return { byName, errorBuilders };
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
