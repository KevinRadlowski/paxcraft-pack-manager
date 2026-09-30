import AdmZip from "adm-zip";
import path from "node:path";
import { promises as fs } from "node:fs";
import { hashFile, walk } from "./io.js";
import type { Catalog, ModRecord, ConfigRecord, SideClass } from "./types.js";
import {
  extractNestedFabricModules,
  parseFabricModJsonBytes,
  parseFabricModJsonCompatible
} from "./fabricMeta.js";

function sideFromEnv(env: unknown): SideClass {
  if (env === "client") return "CLIENT_ONLY";
  if (env === "server") return "SERVER_ONLY";
  return "UNKNOWN"; // Never infer BOTH_REQUIRED solely from Fabric '*'.
}
function boolSide(side: SideClass) {
  return {
    install_client: !["SERVER_ONLY"].includes(side),
    install_server: !["CLIENT_ONLY"].includes(side)
  };
}
function normalizeLicense(v: unknown): string {
  if (Array.isArray(v)) return v.join(", ");
  return typeof v === "string" ? v : "UNKNOWN";
}

/**
 * Top-level pack mods only: `<modsDir>/*.jar`.
 * Subdirectories (e.g. luckperms/libs) are NEVER scanned as installable mods.
 * Nested Fabric jars are discovered later from fabric.mod.json `jars[]`, not from the filesystem tree.
 */
export async function listTopLevelModJars(modsDir: string): Promise<string[]> {
  const entries = await fs.readdir(modsDir, { withFileTypes: true });
  return entries
    .filter(e => e.isFile() && e.name.toLowerCase().endsWith(".jar"))
    .map(e => path.join(modsDir, e.name))
    .sort((a, b) => a.localeCompare(b));
}

export async function scanModsDir(modsDir: string): Promise<ModRecord[]> {
  const files = await listTopLevelModJars(modsDir);
  const mods: ModRecord[] = [];
  for (const file of files) {
    const stat = await fs.stat(file);
    const sha256 = await hashFile(file, "sha256");
    const sha512 = await hashFile(file, "sha512");
    const sha1 = await hashFile(file, "sha1");
    const jarBytes = await fs.readFile(file);
    let parse_error: string | null = null;
    let meta = parseFabricModJsonBytes(Buffer.from("{}"));
    try {
      const zip = new AdmZip(jarBytes);
      const entry = zip.getEntry("fabric.mod.json");
      if (!entry) throw new Error("fabric.mod.json absent");
      meta = parseFabricModJsonBytes(entry.getData());
      if (meta.parse_error) parse_error = meta.parse_error;
      if (!meta.id && !parse_error) parse_error = "fabric.mod.json missing id";
    } catch (e) {
      parse_error = e instanceof Error ? e.message : String(e);
    }

    const nested = extractNestedFabricModules(jarBytes);
    const side = sideFromEnv(meta.environment);
    const rec: ModRecord = {
      jar: path.basename(file),
      mod_id: meta.id ?? path.basename(file, ".jar"),
      name: meta.name ?? path.basename(file, ".jar"),
      version: String(meta.version ?? "UNKNOWN"),
      size_bytes: stat.size,
      sha256,
      sha512,
      sha1,
      declared_environment: meta.environment ?? "*",
      side_class: side,
      ...boolSide(side),
      side_confidence: side === "UNKNOWN" ? "REVIEW_REQUIRED" : "HIGH_METADATA",
      side_web_verified: false,
      license_declared: normalizeLicense(undefined),
      distribution_policy: "LEGAL_REVIEW",
      provider_preference: "modrinth",
      homepage: null,
      source_url: null,
      depends: meta.depends ?? {},
      provides: meta.provides ?? {},
      nested_jars: meta.nestedJarPaths.map(file => ({ file })),
      nested_modules: nested.modules.map(m => ({
        id: m.id,
        version: m.version,
        environment: m.environment,
        depends: m.depends,
        provides: m.provides,
        source: m.source,
        depth: m.depth,
        ...(m.parse_error ? { parse_error: m.parse_error } : {})
      })),
      ...(nested.errors.length ? { nested_errors: nested.errors } : {}),
      parse_error
    };

    // Prefer contact fields when FMJ parsed cleanly
    if (!parse_error) {
      try {
        const zip = new AdmZip(jarBytes);
        const entry = zip.getEntry("fabric.mod.json");
        if (entry) {
          const raw = parseFabricModJsonCompatible(entry.getData().toString("utf8")) as Record<
            string,
            unknown
          >;
          const contact = raw.contact;
          if (contact && typeof contact === "object" && !Array.isArray(contact)) {
            const c = contact as Record<string, unknown>;
            rec.homepage = typeof c.homepage === "string" ? c.homepage : null;
            rec.source_url =
              typeof c.sources === "string"
                ? c.sources
                : typeof c.source === "string"
                  ? c.source
                  : null;
          }
          rec.license_declared = normalizeLicense(raw.license);
        }
      } catch {
        /* keep defaults */
      }
    }

    mods.push(rec);
  }
  return mods;
}

export async function scanConfigDir(configDir: string): Promise<ConfigRecord[]> {
  const files = (await walk(configDir)).sort();
  const out: ConfigRecord[] = [];
  for (const file of files) {
    const rel = path.relative(configDir, file).replaceAll("\\", "/");
    const stat = await fs.stat(file);
    const lower = rel.toLowerCase();
    const sensitive = /(token|secret|password|credential|apikey|api_key|private|luckperms|database)/.test(
      lower
    );
    out.push({
      path: `config/${rel}`,
      size_bytes: stat.size,
      sha256: await hashFile(file),
      owner_mod_id: rel.split("/")[0]!.replace(/\.(json|json5|jsonc|toml|conf|properties|yaml|yml)$/i, ""),
      policy: sensitive ? "NEVER_CLIENT_SECRET_REVIEW" : "COMMON_FORCE_REVIEW",
      sensitive_review: sensitive
    });
  }
  return out;
}

export async function scanInstance(
  modsDir: string,
  configDir: string | undefined,
  base: Catalog
): Promise<Catalog> {
  return {
    schemaVersion: base.schemaVersion,
    generatedFor: base.generatedFor,
    mods: await scanModsDir(modsDir),
    configs: configDir ? await scanConfigDir(configDir) : [],
    missingRequiredDependencies: []
  };
}
