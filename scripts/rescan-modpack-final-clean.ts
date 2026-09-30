/**
 * Controlled dual rescan of MODPACK FINAL CLEAN → local catalogs.
 * Does NOT inherit side/install from the old baseline (avoids silent reintroduction).
 * Legal/provider fields may be enriched from prior catalogs ONLY by exact sha256 match.
 *
 * Usage: pnpm exec tsx scripts/rescan-modpack-final-clean.ts
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { applyCuration } from "../src/curation.js";
import {
  findClientDependencyClosureGaps,
  findServerDependencyClosureGaps,
  requiredDependencyIds,
  satisfyDependencyOnSide,
  type DependencySatisfyStatus,
  type ManifestSide
} from "../src/dependencyClosure.js";
import { readCatalog, writeJson } from "../src/io.js";
import { resolveCurseForge } from "../src/curseforge.js";
import { resolveGitHub } from "../src/github.js";
import { resolveModrinth } from "../src/modrinth.js";
import { classifyConfigs } from "../src/configPolicy.js";
import { scanConfigDir, scanModsDir } from "../src/scan.js";
import type { Catalog, ModRecord, ConfigRecord } from "../src/types.js";
import { CATALOG_SCHEMA_VERSION } from "../src/types.js";
import { validate } from "../src/validate.js";

const CLEAN_ROOT = "H:/Users/kevin/Downloads/Dev/XBase/MODPACK FINAL CLEAN";
const CLIENT_MODS = path.join(CLEAN_ROOT, "client", "mods");
const SERVER_MODS = path.join(CLEAN_ROOT, "server", "mods");
const CLIENT_CONFIG = path.join(CLEAN_ROOT, "client", "config");
const SERVER_CONFIG = path.join(CLEAN_ROOT, "server", "config");

const OUT_SCAN = "data/catalog.clean.scan.json";
const OUT_BASELINE = "data/catalog.baseline.json";
const OUT_CURATED = "data/catalog.curated.json";
const OUT_MODRINTH = "data/catalog.modrinth.json";
const OUT_PROVIDERS = "data/catalog.providers.json";
const OUT_CONFIGS = "data/catalog.configs.json";
const OUT_REPORT = "data/rescan-clean-report.json";

function emptyBase(): Catalog {
  return {
    schemaVersion: 1,
    generatedFor: {
      product: "SweetCraft Launcher",
      minecraft: "26.1.2",
      fabricLoader: "0.19.3",
      server: "sweetcraft.datho.st"
    },
    mods: [],
    configs: [],
    missingRequiredDependencies: []
  };
}

async function listTopLevelJarNames(modsDir: string): Promise<string[]> {
  const entries = await fs.readdir(modsDir, { withFileTypes: true });
  return entries
    .filter(e => e.isFile() && e.name.toLowerCase().endsWith(".jar"))
    .map(e => e.name)
    .sort((a, b) => a.localeCompare(b));
}

async function fileSha256(file: string): Promise<string> {
  const buf = await fs.readFile(file);
  return createHash("sha256").update(buf).digest("hex");
}

/** Merge dual scans by sha256; never keep mods absent from CLEAN. */
function mergeDualMods(
  clientMods: ModRecord[],
  serverMods: ModRecord[]
): {
  mods: ModRecord[];
  presence: { client: Set<string>; server: Set<string> };
  hashConflicts: Array<{ mod_id: string; clientSha: string; serverSha: string }>;
} {
  const clientById = new Map(clientMods.map(m => [m.mod_id, m]));
  const serverById = new Map(serverMods.map(m => [m.mod_id, m]));
  const allIds = new Set([...clientById.keys(), ...serverById.keys()]);
  const presence = {
    client: new Set(clientById.keys()),
    server: new Set(serverById.keys())
  };
  const hashConflicts: Array<{ mod_id: string; clientSha: string; serverSha: string }> = [];
  const mods: ModRecord[] = [];

  for (const id of [...allIds].sort()) {
    const c = clientById.get(id);
    const s = serverById.get(id);
    if (c && s) {
      if (c.sha256 !== s.sha256) {
        hashConflicts.push({ mod_id: id, clientSha: c.sha256, serverSha: s.sha256 });
      }
      // Prefer client record body; sides applied later via presence.
      mods.push({ ...c });
    } else if (c) {
      mods.push({ ...c });
    } else if (s) {
      mods.push({ ...s });
    }
  }
  return { mods, presence, hashConflicts };
}

function mergeConfigs(client: ConfigRecord[], server: ConfigRecord[]): ConfigRecord[] {
  const map = new Map<string, ConfigRecord>();
  for (const cf of [...client, ...server]) {
    const prev = map.get(cf.path);
    if (!prev) {
      map.set(cf.path, cf);
      continue;
    }
    // Same path on both: keep first, note hash mismatch in sensitive flag only if needed.
    if (prev.sha256 !== cf.sha256) {
      map.set(cf.path, {
        ...prev,
        policy_reason: `dual-scan hash differs client/server; kept first sha=${prev.sha256}`
      });
    }
  }
  return [...map.values()].sort((a, b) => a.path.localeCompare(b.path));
}

type PriorMeta = Pick<
  ModRecord,
  | "distribution_policy"
  | "license_class"
  | "license_declared"
  | "legal_note"
  | "provider_preference"
  | "modrinth_url"
  | "curseforge_url"
  | "curseforge_project_id"
  | "author_provider"
  | "author_project"
  | "homepage"
  | "source_url"
>;

/** Enrich ONLY by exact sha256 — never import absent mods or side_class. */
function enrichLegalByExactHash(mods: ModRecord[], priors: Catalog[]): ModRecord[] {
  const bySha = new Map<string, PriorMeta>();
  for (const cat of priors) {
    for (const m of cat.mods) {
      if (!m.sha256 || m.sha256.length !== 64) continue;
      if (!bySha.has(m.sha256)) {
        bySha.set(m.sha256, {
          distribution_policy: m.distribution_policy,
          license_class: m.license_class,
          license_declared: m.license_declared,
          legal_note: m.legal_note,
          provider_preference: m.provider_preference,
          modrinth_url: m.modrinth_url,
          curseforge_url: m.curseforge_url,
          curseforge_project_id: m.curseforge_project_id,
          author_provider: m.author_provider,
          author_project: m.author_project,
          homepage: m.homepage,
          source_url: m.source_url
        });
      }
    }
  }
  return mods.map(m => {
    const p = bySha.get(m.sha256);
    if (!p) return m;
    return {
      ...m,
      distribution_policy: p.distribution_policy ?? m.distribution_policy,
      license_class: p.license_class ?? m.license_class,
      license_declared: p.license_declared ?? m.license_declared,
      legal_note: p.legal_note ?? m.legal_note,
      provider_preference: p.provider_preference ?? m.provider_preference,
      modrinth_url: p.modrinth_url ?? m.modrinth_url,
      curseforge_url: p.curseforge_url ?? m.curseforge_url,
      curseforge_project_id: p.curseforge_project_id ?? m.curseforge_project_id,
      author_provider: p.author_provider ?? m.author_provider,
      author_project: p.author_project ?? m.author_project,
      homepage: p.homepage ?? m.homepage,
      source_url: p.source_url ?? m.source_url
    };
  });
}

/** Modrinth-resolved CLEAN jars: treat as UPSTREAM_PREFERRED for catalog baseline. */
function clearLegalReviewWhenUpstreamResolved(mods: ModRecord[]): ModRecord[] {
  return mods.map(m => {
    if (m.distribution_policy !== "LEGAL_REVIEW") return m;
    if (!(m.modrinth_file_url || m.curseforge_file_url || m.author_file_url)) return m;
    return {
      ...m,
      distribution_policy: "UPSTREAM_PREFERRED",
      legal_note:
        (m.legal_note ? m.legal_note + " | " : "") +
        "CLEAN rescan: upstream file URL resolved → UPSTREAM_PREFERRED (detailed license class may follow)"
    };
  });
}

function buildSummary(c: Catalog) {
  const nested = c.mods.reduce((n, m) => n + (m.nested_modules?.length ?? 0), 0);
  const provides = c.mods.reduce((n, m) => n + Object.keys(m.provides ?? {}).length, 0);
  return {
    topLevelJarCount: c.mods.length,
    nestedJarCount: nested,
    providesCount: provides,
    configFileCount: c.configs.length,
    clientInstallCount: c.mods.filter(m => m.install_client).length,
    serverInstallCount: c.mods.filter(m => m.install_server).length,
    serverOnlyCount: c.mods.filter(m => m.side_class === "SERVER_ONLY").length,
    clientOnlyCount: c.mods.filter(m => m.side_class === "CLIENT_ONLY").length,
    bothRequiredCount: c.mods.filter(m => m.side_class === "BOTH_REQUIRED").length,
    otherSideCount: c.mods.filter(
      m => !["SERVER_ONLY", "CLIENT_ONLY", "BOTH_REQUIRED"].includes(m.side_class)
    ).length
  };
}

function depAudit(catalog: Catalog, side: ManifestSide) {
  const counts: Record<DependencySatisfyStatus, number> = {
    SATISFIED_TOP_LEVEL: 0,
    SATISFIED_PROVIDES: 0,
    SATISFIED_NESTED: 0,
    SATISFIED_FABRIC_MODULE: 0,
    BUILTIN: 0,
    MISSING: 0,
    VERSION_INCOMPATIBLE: 0,
    UNKNOWN_VERSION_SEMANTICS: 0,
    ALIAS_REQUIRED: 0
  };
  const details: Array<{
    dependent: string;
    dependency: string;
    status: DependencySatisfyStatus;
    detail?: string;
  }> = [];
  for (const m of catalog.mods) {
    const onSide =
      side === "client"
        ? !!m.install_client && m.side_class !== "SERVER_ONLY"
        : !!m.install_server && m.side_class !== "CLIENT_ONLY";
    if (!onSide) continue;
    for (const depId of requiredDependencyIds(m)) {
      const pred = m.depends?.[depId];
      const r = satisfyDependencyOnSide(depId, pred, catalog, side);
      counts[r.status]++;
      if (
        r.status === "MISSING" ||
        r.status === "VERSION_INCOMPATIBLE" ||
        r.status === "UNKNOWN_VERSION_SEMANTICS" ||
        r.status === "ALIAS_REQUIRED"
      ) {
        details.push({
          dependent: m.mod_id,
          dependency: depId,
          status: r.status,
          detail: r.detail
        });
      }
    }
  }
  return { counts, details };
}

async function compareCleanToCatalog(catalog: Catalog) {
  const clientJars = await listTopLevelJarNames(CLIENT_MODS);
  const serverJars = await listTopLevelJarNames(SERVER_MODS);
  const byJar = new Map(catalog.mods.map(m => [m.jar, m]));

  const clientMissingInCatalog: string[] = [];
  const serverMissingInCatalog: string[] = [];
  const hashMismatch: Array<{ jar: string; side: string; disk: string; catalog: string }> = [];
  const sideMismatch: Array<{ jar: string; issue: string }> = [];

  for (const jar of clientJars) {
    const m = byJar.get(jar);
    if (!m) {
      clientMissingInCatalog.push(jar);
      continue;
    }
    if (!m.install_client) sideMismatch.push({ jar, issue: "on CLEAN client but install_client=false" });
    const disk = await fileSha256(path.join(CLIENT_MODS, jar));
    if (disk !== m.sha256) hashMismatch.push({ jar, side: "client", disk, catalog: m.sha256 });
  }
  for (const jar of serverJars) {
    const m = byJar.get(jar);
    if (!m) {
      serverMissingInCatalog.push(jar);
      continue;
    }
    if (!m.install_server) sideMismatch.push({ jar, issue: "on CLEAN server but install_server=false" });
    const disk = await fileSha256(path.join(SERVER_MODS, jar));
    if (disk !== m.sha256) hashMismatch.push({ jar, side: "server", disk, catalog: m.sha256 });
  }

  const catalogNotOnClient = catalog.mods
    .filter(m => m.install_client && !clientJars.includes(m.jar))
    .map(m => m.jar);
  const catalogNotOnServer = catalog.mods
    .filter(m => m.install_server && !serverJars.includes(m.jar))
    .map(m => m.jar);
  const catalogOrphans = catalog.mods
    .filter(m => !clientJars.includes(m.jar) && !serverJars.includes(m.jar))
    .map(m => m.jar);

  return {
    clientJarCount: clientJars.length,
    serverJarCount: serverJars.length,
    commonJarCount: clientJars.filter(j => serverJars.includes(j)).length,
    clientOnlyJarCount: clientJars.filter(j => !serverJars.includes(j)).length,
    serverOnlyJarCount: serverJars.filter(j => !clientJars.includes(j)).length,
    clientMissingInCatalog,
    serverMissingInCatalog,
    catalogNotOnClient,
    catalogNotOnServer,
    catalogOrphans,
    hashMismatch,
    sideMismatch
  };
}

async function main() {
  console.log("=== RESCAN MODPACK FINAL CLEAN ===");
  console.log("CLIENT_MODS", CLIENT_MODS);
  console.log("SERVER_MODS", SERVER_MODS);

  const clientJarNames = await listTopLevelJarNames(CLIENT_MODS);
  const serverJarNames = await listTopLevelJarNames(SERVER_MODS);
  console.log(
    `top-level jars: client=${clientJarNames.length} server=${serverJarNames.length}`
  );

  console.log("Scanning client mods…");
  const clientMods = await scanModsDir(CLIENT_MODS);
  console.log("Scanning server mods…");
  const serverMods = await scanModsDir(SERVER_MODS);
  console.log("Scanning configs…");
  const clientConfigs = await scanConfigDir(CLIENT_CONFIG);
  const serverConfigs = await scanConfigDir(SERVER_CONFIG);

  const { mods: mergedMods, presence, hashConflicts } = mergeDualMods(clientMods, serverMods);
  const configs = mergeConfigs(clientConfigs, serverConfigs);

  // Prior catalogs for legal enrichment only (sha256 exact).
  const priors: Catalog[] = [];
  for (const p of [
    "data/catalog.providers.json",
    "data/catalog.modrinth.json",
    "data/catalog.curated.json",
    "data/catalog.baseline.json"
  ]) {
    try {
      priors.push(await readCatalog(p));
    } catch {
      /* optional */
    }
  }
  const enriched = enrichLegalByExactHash(mergedMods, priors);

  let catalog: Catalog = {
    ...emptyBase(),
    mods: enriched,
    configs,
    summary: {}
  };

  await writeJson(OUT_SCAN, { ...catalog, summary: buildSummary(catalog) });
  console.log(`Wrote raw dual scan: ${OUT_SCAN} (${catalog.mods.length} mods)`);

  const curated = applyCuration(catalog, {
    presence: { client: presence.client, server: presence.server }
  });
  catalog = curated.catalog;
  console.log(
    `Curation: changed=${curated.changed} presence=${curated.presenceChanged} closure=${curated.closurePromoted}`
  );

  await writeJson(OUT_BASELINE, { ...catalog, summary: buildSummary(catalog) });
  console.log(`Wrote ${OUT_BASELINE}`);

  console.log("Resolving Modrinth…");
  const mr = await resolveModrinth(catalog, "data/cache/modrinth");
  catalog = mr.catalog;
  await writeJson(OUT_MODRINTH, { ...catalog, summary: buildSummary(catalog) });
  console.log(
    `Modrinth: found=${mr.found} missing=${mr.missing} conflicts=${mr.realConflicts} compatibleDiff=${mr.compatibleDifferences}`
  );

  console.log("Resolving CurseForge + GitHub…");
  const cf = await resolveCurseForge(catalog);
  catalog = cf.catalog;
  const gh = await resolveGitHub(catalog);
  catalog = gh.catalog;
  catalog = {
    ...catalog,
    mods: clearLegalReviewWhenUpstreamResolved(catalog.mods)
  };
  await writeJson(OUT_PROVIDERS, { ...catalog, summary: buildSummary(catalog) });
  console.log(
    `Providers: CF+${cf.found} GH+${gh.found}; unresolved files=${catalog.mods.filter(m => !(m.modrinth_file_url || m.curseforge_file_url || m.author_file_url)).length}`
  );

  // Re-apply presence + closure AFTER Modrinth so REAL_CONFLICT from upstream
  // environment labels is cleared when CLEAN physical presence is authoritative.
  const curated2 = applyCuration(catalog, {
    presence: { client: presence.client, server: presence.server }
  });
  catalog = curated2.catalog;
  await writeJson(OUT_CURATED, { ...catalog, summary: buildSummary(catalog) });

  console.log("Classifying configs…");
  const cfg = classifyConfigs(catalog);
  catalog = cfg.catalog;
  catalog = { ...catalog, schemaVersion: CATALOG_SCHEMA_VERSION, summary: buildSummary(catalog) };
  await writeJson(OUT_CONFIGS, catalog);
  console.log(
    `Configs: changed=${cfg.changed} mapped=${cfg.mapped} excluded=${cfg.excluded} orphans=${cfg.orphans.length}`
  );

  const findings = validate(catalog);
  const errors = findings.filter(f => f.severity === "ERROR");
  const warns = findings.filter(f => f.severity === "WARN");

  const clientDep = depAudit(catalog, "client");
  const serverDep = depAudit(catalog, "server");
  const clientGaps = findClientDependencyClosureGaps(catalog);
  const serverGaps = findServerDependencyClosureGaps(catalog);
  const comparison = await compareCleanToCatalog(catalog);

  const pick = (...ids: string[]) =>
    catalog.mods
      .filter(m => ids.includes(m.mod_id) || ids.some(i => m.jar.toLowerCase().includes(i)))
      .map(m => ({
        mod_id: m.mod_id,
        jar: m.jar,
        version: m.version,
        side_class: m.side_class,
        install_client: m.install_client,
        install_server: m.install_server,
        sha256: m.sha256,
        parse_error: m.parse_error ?? null,
        nested: m.nested_modules?.length ?? 0,
        provides: Object.keys(m.provides ?? {}).length
      }));

  const excludedPaths = catalog.configs
    .filter(c => c.policy === "EXCLUDED")
    .map(c => c.path)
    .sort();

  const report = {
    source: {
      cleanRoot: CLEAN_ROOT,
      clientMods: CLIENT_MODS,
      serverMods: SERVER_MODS,
      minecraft: "26.1.2",
      fabricLoader: "0.19.3"
    },
    counts: {
      clientTopLevel: comparison.clientJarCount,
      serverTopLevel: comparison.serverJarCount,
      commonFilenames: comparison.commonJarCount,
      clientOnlyFilenames: comparison.clientOnlyJarCount,
      serverOnlyFilenames: comparison.serverOnlyJarCount,
      catalogMods: catalog.mods.length,
      ...buildSummary(catalog)
    },
    hashConflictsBetweenSides: hashConflicts,
    curation: {
      presenceChanged: curated.presenceChanged + curated2.presenceChanged,
      closurePromoted: curated.closurePromoted + curated2.closurePromoted,
      sideCounts: Object.fromEntries(
        [...new Set(catalog.mods.map(m => m.side_class))].map(s => [
          s,
          catalog.mods.filter(m => m.side_class === s).length
        ])
      )
    },
    providers: {
      modrinthFound: mr.found,
      modrinthMissing: mr.missing,
      realConflicts: mr.realConflicts,
      curseforgeFound: cf.found,
      githubFound: gh.found,
      unresolvedFileUrl: catalog.mods.filter(
        m => !(m.modrinth_file_url || m.curseforge_file_url || m.author_file_url)
      ).length
    },
    dependencyClosure: {
      client: clientDep,
      server: serverDep,
      clientGaps,
      serverGaps
    },
    configs: {
      total: catalog.configs.length,
      excluded: cfg.excluded,
      excludedPaths,
      orphans: cfg.orphans,
      requiredExclusionsPresent: {
        "config/luckperms.conf": excludedPaths.includes("config/luckperms.conf"),
        "config/resourceful-config-web.json": excludedPaths.includes(
          "config/resourceful-config-web.json"
        ),
        grieflogger: excludedPaths.some(p => p.includes("grieflogger")),
        "xbasecasino/economy": excludedPaths.some(p => p.includes("xbasecasino/economy")),
        "wover/cached": excludedPaths.some(p => p.includes("wover/cached")),
        "betternether/world": excludedPaths.some(p => p.includes("betternether/world"))
      }
    },
    validation: {
      errorCount: errors.length,
      warnCount: warns.length,
      errors,
      warnings: warns.slice(0, 200)
    },
    comparison,
    spotChecks: {
      alexsmobs_codxlib: pick("alexsmobs", "codxlib"),
      fallen_graves: pick("fallen", "universal-graves"),
      betterend: pick("betterend"),
      worldgen: pick(
        "terralith",
        "lithostitched",
        "structory",
        "cristellib",
        "t_and_t"
      ),
      yung: catalog.mods
        .filter(m => /yung/i.test(m.mod_id) || /yung/i.test(m.jar))
        .map(m => ({ id: m.mod_id, jar: m.jar, side: m.side_class })),
      fabricApi: pick("fabric-api")
    },
    catalogsWritten: [
      OUT_SCAN,
      OUT_BASELINE,
      OUT_CURATED,
      OUT_MODRINTH,
      OUT_PROVIDERS,
      OUT_CONFIGS
    ]
  };

  await writeJson(OUT_REPORT, report);

  console.log("\n=== VALIDATION ===");
  for (const e of errors.slice(0, 50)) {
    console.log(`ERROR ${e.code} ${e.subject} — ${e.message}`);
  }
  if (errors.length > 50) console.log(`... ${errors.length - 50} more errors`);
  console.log(`errors=${errors.length} warns=${warns.length}`);
  console.log(`Report: ${OUT_REPORT}`);

  const blockingCompare =
    comparison.clientMissingInCatalog.length +
      comparison.serverMissingInCatalog.length +
      comparison.catalogOrphans.length +
      comparison.hashMismatch.length +
      comparison.sideMismatch.length >
    0;

  if (errors.length === 0 && !blockingCompare) {
    console.log("CATALOG_BASELINE_READY");
  } else {
    console.log("CATALOG_BASELINE_NOT_READY");
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
