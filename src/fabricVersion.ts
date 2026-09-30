/**
 * Fabric dependency version predicates (Pack Manager).
 *
 * Unsupported / ambiguous syntax → UNKNOWN_VERSION_SEMANTICS (never silent VERSION_INCOMPATIBLE).
 */

export type VersionEvalResult =
  | { status: "SATISFIED" }
  | { status: "INCOMPATIBLE" }
  | { status: "UNKNOWN_VERSION_SEMANTICS"; reason: string };

function parseNumericParts(v: string): number[] | null {
  const core = String(v).trim().split("+")[0]!.split("-")[0]!;
  if (!/^\d/.test(core)) return null;
  const parts = core.split(".").map(p => {
    const m = /^(\d+)/.exec(p);
    return m ? Number(m[1]) : 0;
  });
  while (parts.length < 3) parts.push(0);
  return parts.slice(0, 8);
}

/** Compare dotted numeric versions; null if not comparable. */
export function compareFabricVersions(a: string, b: string): number | null {
  const A = parseNumericParts(a);
  const B = parseNumericParts(b);
  if (!A || !B) return null;
  const n = Math.max(A.length, B.length);
  for (let i = 0; i < n; i++) {
    const x = A[i] ?? 0;
    const y = B[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Match installed version against a single Fabric predicate string.
 * Supports: *, exact, >= > <= < = ~ ^, and `x` wildcards (e.g. 26.1.x, 26.101.x).
 */
export function satisfiesFabricVersionPredicate(
  installed: string,
  predicate: string
): VersionEvalResult {
  const p = String(predicate).trim();
  if (p === "" || p === "*") return { status: "SATISFIED" };

  // Maven-style intervals not supported
  if (/^[\[\(]/.test(p) || /,\s*[\]\)]/.test(p)) {
    return { status: "UNKNOWN_VERSION_SEMANTICS", reason: `maven-interval:${p}` };
  }

  const opMatch = /^(>=|<=|>|<|=|~|\^)(.+)$/.exec(p);
  if (opMatch) {
    const op = opMatch[1]!;
    const target = opMatch[2]!.trim();
    if (target.includes("x") || target.includes("X") || target.includes("*")) {
      // e.g. >=26.1.x — treat as unknown rather than wrong
      return { status: "UNKNOWN_VERSION_SEMANTICS", reason: `op+wildcard:${p}` };
    }
    const cmp = compareFabricVersions(installed, target);
    if (cmp === null) {
      if (op === "=" || op === "") {
        return installed === target ? { status: "SATISFIED" } : { status: "INCOMPATIBLE" };
      }
      return { status: "UNKNOWN_VERSION_SEMANTICS", reason: `non-numeric:${p}` };
    }
    switch (op) {
      case ">=":
        return cmp >= 0 ? { status: "SATISFIED" } : { status: "INCOMPATIBLE" };
      case ">":
        return cmp > 0 ? { status: "SATISFIED" } : { status: "INCOMPATIBLE" };
      case "<=":
        return cmp <= 0 ? { status: "SATISFIED" } : { status: "INCOMPATIBLE" };
      case "<":
        return cmp < 0 ? { status: "SATISFIED" } : { status: "INCOMPATIBLE" };
      case "=":
        return cmp === 0 ? { status: "SATISFIED" } : { status: "INCOMPATIBLE" };
      case "~": {
        const t = parseNumericParts(target)!;
        const upper = `${t[0]}.${(t[1] ?? 0) + 1}.0`;
        const up = compareFabricVersions(installed, upper);
        return cmp >= 0 && up !== null && up < 0
          ? { status: "SATISFIED" }
          : { status: "INCOMPATIBLE" };
      }
      case "^": {
        const t = parseNumericParts(target)!;
        const upper =
          (t[0] ?? 0) === 0 ? `0.${(t[1] ?? 0) + 1}.0` : `${(t[0] ?? 0) + 1}.0.0`;
        const up = compareFabricVersions(installed, upper);
        return cmp >= 0 && up !== null && up < 0
          ? { status: "SATISFIED" }
          : { status: "INCOMPATIBLE" };
      }
      default:
        return { status: "UNKNOWN_VERSION_SEMANTICS", reason: `op:${op}` };
    }
  }

  // Wildcard form: 26.1.x / 26.101.x / 0.9.x
  if (/[xX*]/.test(p) && !/^[<>]=?/.test(p)) {
    return matchWildcardVersion(installed, p);
  }

  // Bare exact version
  const cmp = compareFabricVersions(installed, p);
  if (cmp === null) {
    return installed === p ? { status: "SATISFIED" } : { status: "INCOMPATIBLE" };
  }
  return cmp === 0 ? { status: "SATISFIED" } : { status: "INCOMPATIBLE" };
}

function matchWildcardVersion(installed: string, pattern: string): VersionEvalResult {
  const parts = pattern.split(".");
  const inst = parseNumericParts(installed);
  if (!inst) {
    return { status: "UNKNOWN_VERSION_SEMANTICS", reason: `wildcard-non-numeric-installed:${pattern}` };
  }
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (part === "x" || part === "X" || part === "*") continue;
    if (!/^\d+$/.test(part)) {
      return { status: "UNKNOWN_VERSION_SEMANTICS", reason: `wildcard-token:${pattern}` };
    }
    if ((inst[i] ?? 0) !== Number(part)) {
      return { status: "INCOMPATIBLE" };
    }
  }
  return { status: "SATISFIED" };
}

/**
 * Evaluate a Fabric depends value: string, or array of alternatives (OR).
 * Space-separated AND clauses in a string (e.g. ">=1.0 <=2.0") are supported when each token is an op-predicate.
 */
export function satisfiesFabricDependsValue(
  installed: string | null | undefined,
  raw: unknown
): VersionEvalResult {
  if (installed == null || installed === "") {
    return { status: "UNKNOWN_VERSION_SEMANTICS", reason: "no-installed-version" };
  }

  if (Array.isArray(raw)) {
    if (raw.length === 0) return { status: "SATISFIED" };
    let sawUnknown = false;
    for (const alt of raw) {
      const r = satisfiesFabricDependsValue(installed, alt);
      if (r.status === "SATISFIED") return r;
      if (r.status === "UNKNOWN_VERSION_SEMANTICS") sawUnknown = true;
    }
    return sawUnknown
      ? { status: "UNKNOWN_VERSION_SEMANTICS", reason: "or-array-unresolved" }
      : { status: "INCOMPATIBLE" };
  }

  if (typeof raw !== "string") {
    return { status: "UNKNOWN_VERSION_SEMANTICS", reason: `non-string-depends:${typeof raw}` };
  }

  const s = raw.trim();
  if (s.includes("||")) {
    let sawUnknown = false;
    for (const alt of s.split("||").map(x => x.trim()).filter(Boolean)) {
      const r = satisfiesFabricDependsValue(installed, alt);
      if (r.status === "SATISFIED") return r;
      if (r.status === "UNKNOWN_VERSION_SEMANTICS") sawUnknown = true;
    }
    return sawUnknown
      ? { status: "UNKNOWN_VERSION_SEMANTICS", reason: "or-pipe-unresolved" }
      : { status: "INCOMPATIBLE" };
  }

  // AND via spaces: ">=2.2.1 <=3.0.0"
  const tokens = s.split(/\s+/).filter(Boolean);
  if (tokens.length > 1 && tokens.every(t => /^(>=|<=|>|<|=|~|\^)/.test(t) || t === "*")) {
    for (const t of tokens) {
      const r = satisfiesFabricVersionPredicate(installed, t);
      if (r.status !== "SATISFIED") return r;
    }
    return { status: "SATISFIED" };
  }

  return satisfiesFabricVersionPredicate(installed, s);
}
