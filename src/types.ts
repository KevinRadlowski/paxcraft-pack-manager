export type SideClass =
  | "CLIENT_ONLY" | "SERVER_ONLY" | "BOTH_REQUIRED"
  | "CLIENT_REQUIRED_SERVER_OPTIONAL" | "SERVER_REQUIRED_CLIENT_OPTIONAL"
  | "BOTH_INDEPENDENT" | "INDEPENDENT" | "UNKNOWN";

export type DistributionPolicy =
  | "UPSTREAM_REQUIRED" | "UPSTREAM_PREFERRED" | "SWEETCRAFT_ALLOWED" | "BLOCKED" | "LEGAL_REVIEW";

export interface ModRecord {
  archive?: string;
  jar: string;
  mod_id: string;
  name: string;
  version: string;
  size_bytes: number;
  sha256: string;
  sha512?: string;
  sha1?: string;
  declared_environment?: string;
  side_class: SideClass;
  install_client: boolean;
  install_server: boolean;
  client_required_to_join?: boolean;
  server_required?: boolean;
  side_confidence?: string;
  side_web_verified?: boolean;
  license_declared?: string;
  license_class?: string;
  distribution_policy: DistributionPolicy;
  legal_note?: string;
  provider_preference?: "modrinth" | "curseforge" | "author" | "sweetcraft" | string;
  modrinth_url?: string | null;
  modrinth_project_id?: string | null;
  modrinth_version_id?: string | null;
  modrinth_file_url?: string | null;
  modrinth_filename?: string | null;
  modrinth_environment?: string | null;
  modrinth_game_versions?: string[];
  modrinth_loaders?: string[];
  provider_resolved_at?: string | null;
  side_upstream_relation?: "EXACT" | "COMPATIBLE" | "UPSTREAM_MORE_PRECISE" | "REAL_CONFLICT" | "UNKNOWN";
  provider_resolution_status?: string;
  curseforge_project_id?: number;
  curseforge_slug?: string;
  curseforge_file_id?: number;
  curseforge_file_url?: string | null;
  curseforge_filename?: string | null;
  curseforge_game_versions?: string[];
  author_provider?: string;
  author_project?: string;
  author_release_url?: string | null;
  author_file_url?: string | null;
  author_filename?: string | null;

  curseforge_url?: string | null;
  source_url?: string | null;
  homepage?: string | null;
  minecraft_constraint?: string | string[];
  fabricloader_constraint?: string;
  java_constraint?: string;
  depends?: Record<string, unknown>;
  /** Normalized Fabric provides (array entries use null version). */
  provides?: Record<string, string | null>;
  nested_jars?: unknown[];
  /**
   * Nested Fabric modules declared via jars[] (analysis only).
   * Never emitted as separate installable manifest entries.
   */
  nested_modules?: Array<{
    id: string;
    version: string;
    environment?: string;
    depends?: Record<string, unknown>;
    provides?: Record<string, string | null>;
    source: string;
    depth: number;
    parse_error?: string;
  }>;
  /** Nested extraction / path-safety errors (fail-closed diagnostics). */
  nested_errors?: string[];
  parse_error?: string | null;
  curation_note?: string;
}

/**
 * Apply / control policy (how SweetCraft treats the file on update).
 *
 * Note: `SERVER_FORCE` means "SweetCraft imposes this configuration" (pack-controlled).
 * It does NOT mean "server-only distribution". Distribution is `target`.
 * A future rename to PACK_FORCE is optional.
 */
export type ConfigPolicy =
  | "SERVER_FORCE"
  | "CLIENT_DEFAULT"
  | "CLIENT_PRESERVE"
  | "COMMON_FORCE_REVIEW"
  | "NEVER_CLIENT_SECRET_REVIEW"
  | "EXCLUDED"
  /** @deprecated Migrated by classify-configs to CLIENT_DEFAULT or overrides. */
  | "CLIENT_DEFAULT_PRESERVE";

/** Where the config file must be distributed (independent from apply policy). */
export type ConfigTarget = "CLIENT" | "SERVER" | "BOTH" | "NONE";

export type ConfigApplyMode =
  | "force"
  | "if_missing"
  | "never_overwrite"
  | "review"
  | "never_client"
  | "excluded";

export interface ConfigRecord {
  path: string;
  size_bytes: number;
  sha256: string;
  owner_mod_id?: string | null;
  policy: ConfigPolicy | string;
  /** Required after pnpm pack:configs (CLI classify-configs) — distribution target. */
  target?: ConfigTarget | string;
  sensitive_review?: boolean;
  /** Human-readable reason from override / auto / exclusion. */
  policy_reason?: string;
  target_reason?: string;
  exclusion_reason?: string;
}

export interface Catalog {
  /**
   * Catalogue schema version (Pack Manager inventory), NOT the launcher manifest schema.
   * v1 = baseline configs without target
   * v2 = ConfigRecord with independent policy + target (PHASE 0.6.1+)
   */
  schemaVersion: number;
  generatedFor: {
    product: string;
    minecraft: string;
    fabricLoader: string;
    server: string;
  };
  summary?: Record<string, unknown>;
  mods: ModRecord[];
  configs: ConfigRecord[];
  missingRequiredDependencies?: unknown[];
}

/** Current catalogue schema written by pnpm pack:configs (CLI: classify-configs). */
export const CATALOG_SCHEMA_VERSION = 2;

/**
 * Current client/server manifest schema written by pack:manifests / pack:stage.
 * v5 = configs + mods (production 0.1.0)
 * v6 = + resourcePacks[] (client); server uses resourcePacks: [] and optional serverDatapacks[]
 */
export const MANIFEST_SCHEMA_VERSION = 6;

/** Legacy manifests still accepted by verifyRelease. */
export const MANIFEST_SCHEMA_VERSION_LEGACY = 5;

/** Relative directory inside a staged release that holds pack files (configs today). */
export const RELEASE_FILES_BASE = "files/";

/**
 * Release descriptor schema (`release.json`), independent from catalogue/manifest.
 * v1 = staging PHASE 0.7 (legacy digest payload name)
 * v2 = PHASE 0.8+ canonical SWEETCRAFT-RELEASE-SIGNATURE-V1 payload
 */
export const RELEASE_SCHEMA_VERSION = 2;
