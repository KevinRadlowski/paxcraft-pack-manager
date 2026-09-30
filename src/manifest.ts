import type { Catalog, ConfigApplyMode, ConfigPolicy, ConfigRecord, ConfigTarget, ModRecord } from "./types.js";
import { MANIFEST_SCHEMA_VERSION, RELEASE_FILES_BASE } from "./types.js";
import { KNOWN_TARGETS } from "./configPolicyRules.js";
import type { ManifestResourcePack } from "./resourcePackTypes.js";
import type { ManifestServerDatapack } from "./serverDatapackTypes.js";
import { configMigrationsForManifest } from "./configMigrations.js";
import type { ManifestConfigMigration } from "./configMigrationTypes.js";

function provider(m: ModRecord) {
  if (m.modrinth_file_url) return { type: "modrinth", projectId: m.modrinth_project_id ?? null, versionId: m.modrinth_version_id ?? null, url: m.modrinth_file_url };
  if (m.curseforge_file_url) return { type: "curseforge", projectId: m.curseforge_project_id ?? null, fileId: m.curseforge_file_id ?? null, url: m.curseforge_file_url };
  if (m.author_file_url) return { type: m.author_provider ?? "author", project: m.author_project ?? null, url: m.author_file_url };
  return { type: "pending", url: null };
}

function mod(m: ModRecord) {
  return {
    id: m.mod_id,
    name: m.name,
    version: m.version,
    file: m.jar,
    size: m.size_bytes,
    sha256: m.sha256,
    sha512: m.sha512 ?? null,
    provider: provider(m),
    distribution: m.distribution_policy
  };
}

function base(c: Catalog, packVersion: string, target: "client" | "server", generatedAt?: string) {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    product: "SweetCraft",
    target,
    packVersion,
    minecraft: c.generatedFor.minecraft,
    fabricLoader: c.generatedFor.fabricLoader,
    server: c.generatedFor.server,
    /**
     * Relative base inside the staged release. Launcher resolves:
     * releaseBaseUrl + configBase + config.path
     * e.g. .../files/ + config/alexsmobs/x.json
     * Resource packs use the same base: files/ + resourcepacks/...
     * Minecraft install path remains resourcePack.targetPath (no files/ prefix).
     */
    configBase: RELEASE_FILES_BASE,
    generatedAt: generatedAt ?? new Date().toISOString()
  };
}

export function applyModeForPolicy(policy: string): ConfigApplyMode {
  switch (policy as ConfigPolicy) {
    case "SERVER_FORCE": return "force";
    case "CLIENT_DEFAULT": return "if_missing";
    case "CLIENT_PRESERVE": return "never_overwrite";
    case "COMMON_FORCE_REVIEW": return "review";
    case "NEVER_CLIENT_SECRET_REVIEW": return "never_client";
    case "EXCLUDED": return "excluded";
    case "CLIENT_DEFAULT_PRESERVE": return "never_overwrite";
    default: return "review";
  }
}

function requireTarget(cf: ConfigRecord): ConfigTarget {
  if (!cf.target) {
    throw new Error(
      `Config sans target: ${cf.path}. Exécuter \`pnpm pack:configs\` (CLI: classify-configs) pour migrer le catalogue (PHASE 0.6.1).`
    );
  }
  if (!KNOWN_TARGETS.has(String(cf.target))) {
    throw new Error(`Config target inconnu: ${cf.path} target=${cf.target}`);
  }
  return cf.target as ConfigTarget;
}

function configEntry(cf: ConfigRecord) {
  const target = requireTarget(cf);
  return {
    path: cf.path,
    sha256: cf.sha256,
    policy: cf.policy,
    apply: applyModeForPolicy(cf.policy),
    target
  };
}

/**
 * Defense-in-depth: these policies never enter any launcher manifest,
 * regardless of target. validate() separately blocks RELEASE_READY.
 */
export function isManifestBlockedPolicy(policy: string): boolean {
  return policy === "EXCLUDED"
    || policy === "COMMON_FORCE_REVIEW"
    || policy === "NEVER_CLIENT_SECRET_REVIEW"
    || policy === "CLIENT_DEFAULT_PRESERVE";
}

function sortMods<T extends { id: string }>(mods: T[]): T[] {
  return [...mods].sort((a, b) => a.id.localeCompare(b.id));
}

function sortConfigs<T extends { path: string }>(configs: T[]): T[] {
  return [...configs].sort((a, b) => a.path.localeCompare(b.path));
}

function sortResourcePacks(packs: ManifestResourcePack[]): ManifestResourcePack[] {
  return [...packs].sort((a, b) => a.id.localeCompare(b.id));
}

export interface BuildManifestOptions {
  generatedAt?: string;
  /** Client-only resource packs (schema 6). Never include sourcePath. */
  resourcePacks?: ManifestResourcePack[];
  /** Server-only folder datapacks (schema 6 extension). Never include sourcePath. */
  serverDatapacks?: ManifestServerDatapack[];
}

/**
 * Client manifest: target CLIENT|BOTH, excluding all REVIEW/NEVER/EXCLUDED policies.
 * Schema 6 includes resourcePacks[] (CLIENT packs only).
 */
export function buildClientManifest(c: Catalog, packVersion: string, generatedAtOrOpts?: string | BuildManifestOptions) {
  const opts: BuildManifestOptions =
    typeof generatedAtOrOpts === "string" || generatedAtOrOpts === undefined
      ? { generatedAt: generatedAtOrOpts }
      : generatedAtOrOpts;
  const resourcePacks = sortResourcePacks(opts.resourcePacks ?? []);
  const configMigrations: ManifestConfigMigration[] = configMigrationsForManifest(packVersion);
  return {
    ...base(c, packVersion, "client", opts.generatedAt),
    mods: sortMods(
      c.mods.filter(m => m.install_client && m.side_class !== "SERVER_ONLY").map(mod)
    ),
    configs: sortConfigs(
      c.configs
        .filter(x => {
          if (isManifestBlockedPolicy(x.policy)) return false;
          const t = requireTarget(x);
          return t === "CLIENT" || t === "BOTH";
        })
        .map(configEntry)
    ),
    resourcePacks,
    ...(configMigrations.length > 0 ? { configMigrations } : {})
  };
}

function sortServerDatapacks(packs: ManifestServerDatapack[]): ManifestServerDatapack[] {
  return [...packs].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Server manifest: target SERVER|BOTH, excluding REVIEW/NEVER/EXCLUDED and client prefs.
 * Schema 6 always has resourcePacks: [] (client-only distribution).
 * Optional serverDatapacks[] carries pack-owned world/datapacks/* trees.
 */
export function buildServerManifest(c: Catalog, packVersion: string, generatedAtOrOpts?: string | BuildManifestOptions) {
  const opts: BuildManifestOptions =
    typeof generatedAtOrOpts === "string" || generatedAtOrOpts === undefined
      ? { generatedAt: generatedAtOrOpts }
      : generatedAtOrOpts;
  const serverDatapacks = sortServerDatapacks(opts.serverDatapacks ?? []);
  return {
    ...base(c, packVersion, "server", opts.generatedAt),
    mods: sortMods(
      c.mods.filter(m => m.install_server && m.side_class !== "CLIENT_ONLY").map(mod)
    ),
    configs: sortConfigs(
      c.configs
        .filter(x => {
          if (isManifestBlockedPolicy(x.policy)) return false;
          if (x.policy === "CLIENT_DEFAULT" || x.policy === "CLIENT_PRESERVE") return false;
          const t = requireTarget(x);
          return t === "SERVER" || t === "BOTH";
        })
        .map(configEntry)
    ),
    resourcePacks: [] as ManifestResourcePack[],
    ...(serverDatapacks.length > 0 ? { serverDatapacks } : {})
  };
}
