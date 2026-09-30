/**
 * Provider closure — merge resolved upstream metadata into release catalogues
 * without mutating authoritative sha256/size/jar identity.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { assertSafeCurseForgeDownloadUrl } from "./curseforge.js";
import { resolveAllArtifactSources, type ResolvedArtifactSource } from "./artifactSource.js";
import type { Catalog, ModRecord } from "./types.js";

/** Provider fields copied only when sha256 matches exactly. */
const PROVIDER_FIELDS = [
  "provider_preference",
  "modrinth_project_id",
  "modrinth_version_id",
  "modrinth_file_url",
  "modrinth_filename",
  "modrinth_environment",
  "modrinth_game_versions",
  "modrinth_loaders",
  "curseforge_project_id",
  "curseforge_slug",
  "curseforge_file_id",
  "curseforge_file_url",
  "curseforge_filename",
  "curseforge_game_versions",
  "author_provider",
  "author_project",
  "author_release_url",
  "author_file_url",
  "author_filename",
  "provider_resolution_status",
  "provider_resolved_at"
] as const;

type ProviderField = (typeof PROVIDER_FIELDS)[number];

function pickProviderFields(m: ModRecord): Partial<Pick<ModRecord, ProviderField>> {
  const out: Partial<Pick<ModRecord, ProviderField>> = {};
  for (const k of PROVIDER_FIELDS) {
    const v = m[k];
    if (v !== undefined && v !== null) {
      (out as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}

const PHYSICAL_SIDE_FIELDS = [
  "side_class",
  "install_client",
  "install_server",
  "client_required_to_join",
  "server_required",
  "side_confidence",
  "side_upstream_relation",
  "side_web_verified"
] as const;

/** Restore SYNC-04 physical side intent after upstream provider enrichment. */
export function restorePhysicalSideFields(source: Catalog, catalog: Catalog): Catalog {
  const byId = new Map(source.mods.map(m => [m.mod_id, m]));
  const mods = catalog.mods.map(m => {
    const s = byId.get(m.mod_id);
    if (!s || s.sha256 !== m.sha256) return m;
    const patch: Partial<ModRecord> = {};
    for (const k of PHYSICAL_SIDE_FIELDS) {
      (patch as Record<string, unknown>)[k] = s[k];
    }
    return { ...m, ...patch };
  });
  return { ...catalog, mods };
}

/** Merge provider metadata from `resolved` into `base` when sha256 matches. */
export function mergeProviderMetadata(base: Catalog, resolved: Catalog): Catalog {
  const byId = new Map(resolved.mods.map(m => [m.mod_id, m]));
  const mods = base.mods.map(m => {
    const r = byId.get(m.mod_id);
    if (!r || r.sha256 !== m.sha256) return m;
    return { ...m, ...pickProviderFields(r) };
  });
  return { ...base, mods };
}

export interface ValidatedCurseForgeEntry {
  mod_id: string;
  sha256: string;
  curseforge_project_id: number;
  curseforge_file_id: number;
  curseforge_file_url: string;
  source: string;
}

/** Tracked portable fixture — validated 0.1.3-seq4 CurseForge closure metadata. */
export const VALIDATED_CF_FIXTURE_0_1_3_SEQ4 =
  "data/fixtures/validated-curseforge-0.1.3-seq4.json";

interface ValidatedCurseForgeFixtureFile {
  schemaVersion: number;
  provenance: string;
  sourceRelease?: string;
  entries: Array<Omit<ValidatedCurseForgeEntry, "source">>;
}

function toValidatedEntries(
  rows: Array<Omit<ValidatedCurseForgeEntry, "source">>,
  source: string
): ValidatedCurseForgeEntry[] {
  const out: ValidatedCurseForgeEntry[] = [];
  for (const row of rows) {
    assertSafeCurseForgeDownloadUrl(row.curseforge_file_url);
    out.push({
      ...row,
      sha256: row.sha256.toLowerCase(),
      source
    });
  }
  return out;
}

/**
 * Load hash-gated CurseForge metadata from a tracked portable fixture.
 * Used by tests and may be passed explicitly by local repro scripts.
 */
export function loadValidatedCurseForgeFixture(fixturePath: string): ValidatedCurseForgeEntry[] {
  const abs = path.resolve(fixturePath);
  const raw = JSON.parse(readFileSync(abs, "utf8")) as ValidatedCurseForgeFixtureFile;
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.entries)) {
    throw new Error(`${fixturePath}: invalid validated CF fixture schema`);
  }
  return toValidatedEntries(raw.entries, fixturePath);
}

/**
 * Extract CurseForge entries from a staged client-manifest.json (local repro only).
 * Caller must pass an explicit manifest path — no default under data/candidates/.
 */
export function loadValidatedCurseForgeClosure(manifestPath: string): ValidatedCurseForgeEntry[] {
  const abs = path.resolve(manifestPath);
  const raw = JSON.parse(readFileSync(abs, "utf8")) as {
    mods: Array<{
      id: string;
      sha256: string;
      provider?: { type: string; projectId?: number; fileId?: number; url?: string };
    }>;
  };
  const rows: Array<Omit<ValidatedCurseForgeEntry, "source">> = [];
  for (const mod of raw.mods) {
    const p = mod.provider;
    if (p?.type !== "curseforge" || !p.url || !p.projectId || !p.fileId) continue;
    rows.push({
      mod_id: mod.id,
      sha256: mod.sha256.toLowerCase(),
      curseforge_project_id: p.projectId,
      curseforge_file_id: p.fileId,
      curseforge_file_url: p.url
    });
  }
  return toValidatedEntries(rows, manifestPath);
}

/** Apply hash-gated CurseForge URLs from prior validated release metadata. */
export function applyValidatedCurseForgeClosure(
  catalog: Catalog,
  entries: ValidatedCurseForgeEntry[]
): { catalog: Catalog; applied: string[]; skipped: string[] } {
  const byId = new Map(entries.map(e => [e.mod_id, e]));
  const applied: string[] = [];
  const skipped: string[] = [];
  const mods = catalog.mods.map(m => {
    if (m.modrinth_file_url || m.curseforge_file_url || m.author_file_url) return m;
    const entry = byId.get(m.mod_id);
    if (!entry) return m;
    if (m.sha256.toLowerCase() !== entry.sha256) {
      skipped.push(`${m.mod_id}:sha256_mismatch`);
      return m;
    }
    applied.push(m.mod_id);
    return {
      ...m,
      curseforge_project_id: entry.curseforge_project_id,
      curseforge_file_id: entry.curseforge_file_id,
      curseforge_file_url: entry.curseforge_file_url,
      curseforge_filename: m.jar,
      provider_preference: "curseforge",
      provider_resolution_status: "VALIDATED_PRIOR_RELEASE_CF",
      provider_resolved_at: new Date().toISOString()
    };
  });
  return { catalog: { ...catalog, mods }, applied, skipped };
}

export interface ProviderClosureSummary {
  catalogMods: number;
  clientInstall: number;
  serverInstall: number;
  artifactSources: {
    provider: number;
    localClean: number;
    customLocal: number;
    unresolved: number;
  };
  withoutUpstreamUrl: number;
  releaseHostedWithoutUrl: number;
  stagingUnresolved: ResolvedArtifactSource[];
}

export function summarizeProviderClosure(catalog: Catalog): ProviderClosureSummary {
  const sources = resolveAllArtifactSources(catalog.mods);
  let provider = 0;
  let localClean = 0;
  let customLocal = 0;
  let unresolved = 0;
  const stagingUnresolved: ResolvedArtifactSource[] = [];
  for (const s of sources) {
    if (s.kind === "PROVIDER") provider++;
    else if (s.kind === "LOCAL_CLEAN") localClean++;
    else if (s.kind === "CUSTOM_LOCAL") customLocal++;
    else {
      unresolved++;
      stagingUnresolved.push(s);
    }
  }
  const withoutUrl = catalog.mods.filter(
    m => !(m.modrinth_file_url || m.curseforge_file_url || m.author_file_url)
  );
  const releaseHostedWithoutUrl = withoutUrl.filter(m => {
    const s = sources.find(x => x.mod_id === m.mod_id);
    return s?.kind === "LOCAL_CLEAN" || s?.kind === "CUSTOM_LOCAL";
  }).length;

  return {
    catalogMods: catalog.mods.length,
    clientInstall: catalog.mods.filter(m => m.install_client).length,
    serverInstall: catalog.mods.filter(m => m.install_server).length,
    artifactSources: { provider, localClean, customLocal, unresolved },
    withoutUpstreamUrl: withoutUrl.length,
    releaseHostedWithoutUrl,
    stagingUnresolved
  };
}
