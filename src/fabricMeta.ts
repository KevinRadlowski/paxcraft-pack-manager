/**
 * Fabric fabric.mod.json parsing helpers (provides, nested jars).
 * Nested analysis is bounded and path-safe; nested mods never become installable ModRecords.
 */
import { createHash } from "node:crypto";
import AdmZip from "adm-zip";

export const MAX_NESTED_JAR_DEPTH = 8;
/** Distant Horizons and similar fat jars embed many Fabric modules; 64 was too low. */
export const MAX_NESTED_JAR_NODES = 256;

export type ProvidesMap = Record<string, string | null>;

export interface NestedFabricModule {
  id: string;
  version: string;
  environment: string;
  depends: Record<string, unknown>;
  provides: ProvidesMap;
  /** Logical path inside parent archive(s), e.g. META-INF/jars/foo.jar */
  source: string;
  depth: number;
  parse_error?: string;
}

export interface FabricModJsonMeta {
  id: string | null;
  version: string | null;
  name: string | null;
  environment: string;
  depends: Record<string, unknown>;
  recommends: Record<string, unknown>;
  suggests: Record<string, unknown>;
  conflicts: Record<string, unknown>;
  breaks: Record<string, unknown>;
  provides: ProvidesMap;
  /** Declared nested jar relative paths (from jars[].file). */
  nestedJarPaths: string[];
  parse_error?: string;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Normalize Fabric `provides` (object map or string[]). Array entries have null version. */
export function normalizeProvides(raw: unknown): ProvidesMap {
  const out: ProvidesMap = {};
  if (raw == null) return out;
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === "string" && item.length > 0) out[item] = null;
    }
    return out;
  }
  if (isObj(raw)) {
    for (const [k, v] of Object.entries(raw)) {
      if (!k) continue;
      out[k] = v == null ? null : String(v);
    }
  }
  return out;
}

export function parseFabricModJsonObject(meta: unknown): FabricModJsonMeta {
  if (!isObj(meta)) {
    return emptyMeta("fabric.mod.json root must be object");
  }
  const jarsRaw = meta.jars;
  const nestedJarPaths: string[] = [];
  if (Array.isArray(jarsRaw)) {
    for (const j of jarsRaw) {
      if (typeof j === "string") nestedJarPaths.push(j);
      else if (isObj(j) && typeof j.file === "string") nestedJarPaths.push(j.file);
    }
  }
  return {
    id: typeof meta.id === "string" ? meta.id : null,
    version: meta.version != null ? String(meta.version) : null,
    name: typeof meta.name === "string" ? meta.name : null,
    environment: typeof meta.environment === "string" ? meta.environment : "*",
    depends: isObj(meta.depends) ? meta.depends : {},
    recommends: isObj(meta.recommends) ? meta.recommends : {},
    suggests: isObj(meta.suggests) ? meta.suggests : {},
    conflicts: isObj(meta.conflicts) ? meta.conflicts : {},
    breaks: isObj(meta.breaks) ? meta.breaks : {},
    provides: normalizeProvides(meta.provides),
    nestedJarPaths
  };
}

function emptyMeta(err: string): FabricModJsonMeta {
  return {
    id: null,
    version: null,
    name: null,
    environment: "*",
    depends: {},
    recommends: {},
    suggests: {},
    conflicts: {},
    breaks: {},
    provides: {},
    nestedJarPaths: [],
    parse_error: err
  };
}

/**
 * Fabric Loader 0.19.3 (shaded Gson JsonReader) accepts raw U+000A / U+000D inside
 * JSON strings. Node JSON.parse (RFC 8259) does not.
 *
 * Deterministic preprocessing for fabric.mod.json only: escape raw LF/CR that appear
 * unescaped inside strings. No other controls, no out-of-string changes, no global
 * lax JSON. Stateful (insideString / escaped) — not a regex.
 */
export function escapeRawLfCrInsideJsonStrings(text: string): string {
  let out = "";
  let insideString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (!insideString) {
      if (c === '"') {
        insideString = true;
      }
      out += c;
      continue;
    }
    if (escaped) {
      out += c;
      escaped = false;
      continue;
    }
    if (c === "\\") {
      out += c;
      escaped = true;
      continue;
    }
    if (c === '"') {
      insideString = false;
      out += c;
      continue;
    }
    if (c === "\n") {
      out += "\\n";
      continue;
    }
    if (c === "\r") {
      out += "\\r";
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * Parse fabric.mod.json text with minimal Fabric Loader string LF/CR compatibility,
 * then standard JSON.parse (still fail-closed for other malformations).
 */
export function parseFabricModJsonCompatible(text: string): unknown {
  return JSON.parse(escapeRawLfCrInsideJsonStrings(text));
}

export function parseFabricModJsonBytes(bytes: Buffer): FabricModJsonMeta {
  let text: string;
  try {
    text = bytes.toString("utf8");
  } catch (e) {
    return emptyMeta(e instanceof Error ? e.message : String(e));
  }
  try {
    return parseFabricModJsonObject(parseFabricModJsonCompatible(text));
  } catch (e) {
    return emptyMeta(e instanceof Error ? e.message : String(e));
  }
}

/** Reject zip-slip / absolute / parent traversal in nested jar paths. */
export function assertSafeNestedJarPath(rel: string): void {
  const n = rel.replace(/\\/g, "/");
  if (!n || n.startsWith("/") || /^[a-zA-Z]:/.test(n)) {
    throw new Error(`unsafe nested jar path: ${rel}`);
  }
  const parts = n.split("/");
  if (parts.some(p => p === ".." || p === "")) {
    throw new Error(`unsafe nested jar path: ${rel}`);
  }
}

export interface ExtractNestedOptions {
  maxDepth?: number;
  maxNodes?: number;
}

/**
 * Recursively extract nested Fabric modules declared via jars[].
 * Dedupes by content sha256; bounds depth/nodes; fails closed on declared-but-missing.
 */
export function extractNestedFabricModules(
  jarBytes: Buffer,
  opts: ExtractNestedOptions = {}
): { modules: NestedFabricModule[]; errors: string[] } {
  const maxDepth = opts.maxDepth ?? MAX_NESTED_JAR_DEPTH;
  const maxNodes = opts.maxNodes ?? MAX_NESTED_JAR_NODES;
  const modules: NestedFabricModule[] = [];
  const errors: string[] = [];
  const seenContent = new Set<string>();

  function walk(buf: Buffer, logicalPath: string, depth: number) {
    if (modules.length >= maxNodes) {
      errors.push(`nested jar node limit (${maxNodes}) exceeded at ${logicalPath}`);
      return;
    }
    if (depth > maxDepth) {
      errors.push(`nested jar depth limit (${maxDepth}) exceeded at ${logicalPath}`);
      return;
    }
    const sha = createHash("sha256").update(buf).digest("hex");
    if (seenContent.has(sha)) return;
    seenContent.add(sha);

    let zip: AdmZip;
    try {
      zip = new AdmZip(buf);
    } catch (e) {
      errors.push(`corrupt nested jar ${logicalPath}: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    // Only parse FMJ for nested (depth>=1); top-level handled by scan.
    if (depth >= 1) {
      const entry = zip.getEntry("fabric.mod.json");
      if (!entry) {
        errors.push(`nested jar missing fabric.mod.json: ${logicalPath}`);
        return;
      }
      const meta = parseFabricModJsonBytes(entry.getData());
      if (meta.parse_error) {
        errors.push(`nested fabric.mod.json parse failed (${logicalPath}): ${meta.parse_error}`);
        modules.push({
          id: meta.id ?? pathBasename(logicalPath),
          version: meta.version ?? "UNKNOWN",
          environment: meta.environment,
          depends: meta.depends,
          provides: meta.provides,
          source: logicalPath,
          depth,
          parse_error: meta.parse_error
        });
        return;
      }
      if (!meta.id) {
        errors.push(`nested fabric.mod.json missing id: ${logicalPath}`);
        return;
      }
      modules.push({
        id: meta.id,
        version: meta.version ?? "UNKNOWN",
        environment: meta.environment,
        depends: meta.depends,
        provides: meta.provides,
        source: logicalPath,
        depth
      });
      for (const rel of meta.nestedJarPaths) {
        openNested(zip, logicalPath, rel, depth);
      }
      return;
    }

    // depth 0: only follow declared jars from root FMJ
    const rootEntry = zip.getEntry("fabric.mod.json");
    if (!rootEntry) return;
    const rootMeta = parseFabricModJsonBytes(rootEntry.getData());
    if (rootMeta.parse_error) return;
    for (const rel of rootMeta.nestedJarPaths) {
      openNested(zip, logicalPath, rel, depth);
    }
  }

  function openNested(zip: AdmZip, parentLogical: string, rel: string, parentDepth: number) {
    try {
      assertSafeNestedJarPath(rel);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
      return;
    }
    const norm = rel.replace(/\\/g, "/");
    const entry = zip.getEntry(norm);
    if (!entry) {
      errors.push(`declared nested jar missing: ${parentLogical}!${norm}`);
      return;
    }
    let nestedBuf: Buffer;
    try {
      nestedBuf = entry.getData();
    } catch (e) {
      errors.push(
        `cannot read nested jar ${parentLogical}!${norm}: ${e instanceof Error ? e.message : String(e)}`
      );
      return;
    }
    walk(nestedBuf, `${parentLogical}!${norm}`, parentDepth + 1);
  }

  walk(jarBytes, "<root>", 0);
  return { modules, errors };
}

function pathBasename(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || p;
}

/**
 * Yumi / Fabric mod IDs: hyphen and underscore are DISTINCT per Fabric id rules.
 * Do NOT equate yumi-commons-core with yumi_commons_core for satisfaction.
 * Near-miss detection is diagnostic only.
 */
export function hyphenUnderscoreNearMiss(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/-/g, "_");
  return a !== b && norm(a) === norm(b);
}
