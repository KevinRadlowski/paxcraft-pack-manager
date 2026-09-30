import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  findClientDependencyClosureGaps,
  findServerDependencyClosureGaps,
  requiredDependencyIds,
  satisfyDependencyOnSide,
  type DependencySatisfyStatus,
  type ManifestSide
} from "../src/dependencyClosure.js";
import { readCatalog, writeJson } from "../src/io.js";
import { validate } from "../src/validate.js";
import type { Catalog } from "../src/types.js";

const CLEAN = "H:/Users/kevin/Downloads/Dev/XBase/MODPACK FINAL CLEAN";
const CLIENT_MODS = path.join(CLEAN, "client", "mods");
const SERVER_MODS = path.join(CLEAN, "server", "mods");

async function listJars(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter(e => e.isFile() && e.name.toLowerCase().endsWith(".jar"))
    .map(e => e.name)
    .sort((a, b) => a.localeCompare(b));
}

async function sha256(file: string): Promise<string> {
  return createHash("sha256").update(await fs.readFile(file)).digest("hex");
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
        ["MISSING", "VERSION_INCOMPATIBLE", "UNKNOWN_VERSION_SEMANTICS", "ALIAS_REQUIRED"].includes(
          r.status
        )
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

const catalog = await readCatalog("data/catalog.configs.json");

// Sync sibling catalogs to the validated CLEAN baseline (mods+configs).
for (const out of [
  "data/catalog.baseline.json",
  "data/catalog.curated.json",
  "data/catalog.modrinth.json",
  "data/catalog.providers.json"
]) {
  await writeJson(out, catalog);
}

const clientJars = await listJars(CLIENT_MODS);
const serverJars = await listJars(SERVER_MODS);
const byJar = new Map(catalog.mods.map(m => [m.jar, m]));
const comparison = {
  clientJarCount: clientJars.length,
  serverJarCount: serverJars.length,
  commonJarCount: clientJars.filter(j => serverJars.includes(j)).length,
  clientOnlyJarCount: clientJars.filter(j => !serverJars.includes(j)).length,
  serverOnlyJarCount: serverJars.filter(j => !clientJars.includes(j)).length,
  clientMissingInCatalog: clientJars.filter(j => !byJar.has(j)),
  serverMissingInCatalog: serverJars.filter(j => !byJar.has(j)),
  catalogOrphans: catalog.mods
    .filter(m => !clientJars.includes(m.jar) && !serverJars.includes(m.jar))
    .map(m => m.jar),
  hashMismatch: [] as Array<{ jar: string; side: string; disk: string; catalog: string }>,
  sideMismatch: [] as Array<{ jar: string; issue: string }>
};

for (const jar of clientJars) {
  const m = byJar.get(jar)!;
  if (!m.install_client) comparison.sideMismatch.push({ jar, issue: "install_client=false" });
  const disk = await sha256(path.join(CLIENT_MODS, jar));
  if (disk !== m.sha256) comparison.hashMismatch.push({ jar, side: "client", disk, catalog: m.sha256 });
}
for (const jar of serverJars) {
  const m = byJar.get(jar)!;
  if (!m.install_server) comparison.sideMismatch.push({ jar, issue: "install_server=false" });
  const disk = await sha256(path.join(SERVER_MODS, jar));
  if (disk !== m.sha256) comparison.hashMismatch.push({ jar, side: "server", disk, catalog: m.sha256 });
}

const findings = validate(catalog);
const errors = findings.filter(f => f.severity === "ERROR");
const warns = findings.filter(f => f.severity === "WARN");
const excludedPaths = catalog.configs.filter(c => c.policy === "EXCLUDED").map(c => c.path).sort();
const nestedCount = catalog.mods.reduce((n, m) => n + (m.nested_modules?.length ?? 0), 0);
const providesCount = catalog.mods.reduce((n, m) => n + Object.keys(m.provides ?? {}).length, 0);

const pick = (...ids: string[]) =>
  catalog.mods
    .filter(m => ids.includes(m.mod_id))
    .map(m => ({
      mod_id: m.mod_id,
      jar: m.jar,
      version: m.version,
      side_class: m.side_class,
      sha256: m.sha256,
      parse_error: m.parse_error ?? null
    }));

const report = {
  verdict:
    errors.length === 0 &&
    comparison.clientMissingInCatalog.length === 0 &&
    comparison.serverMissingInCatalog.length === 0 &&
    comparison.catalogOrphans.length === 0 &&
    comparison.hashMismatch.length === 0 &&
    comparison.sideMismatch.length === 0
      ? "CATALOG_BASELINE_READY"
      : "CATALOG_BASELINE_NOT_READY",
  source: { cleanRoot: CLEAN, minecraft: "26.1.2", fabricLoader: "0.19.3" },
  counts: {
    clientTopLevel: comparison.clientJarCount,
    serverTopLevel: comparison.serverJarCount,
    commonFilenames: comparison.commonJarCount,
    clientOnlyFilenames: comparison.clientOnlyJarCount,
    serverOnlyFilenames: comparison.serverOnlyJarCount,
    catalogMods: catalog.mods.length,
    nestedModules: nestedCount,
    provides: providesCount,
    configs: catalog.configs.length,
    clientInstall: catalog.mods.filter(m => m.install_client).length,
    serverInstall: catalog.mods.filter(m => m.install_server).length,
    sideClasses: Object.fromEntries(
      [...new Set(catalog.mods.map(m => m.side_class))].map(s => [
        s,
        catalog.mods.filter(m => m.side_class === s).length
      ])
    )
  },
  providers: {
    withFileUrl: catalog.mods.filter(
      m => m.modrinth_file_url || m.curseforge_file_url || m.author_file_url
    ).length,
    unresolvedFileUrl: catalog.mods
      .filter(m => !(m.modrinth_file_url || m.curseforge_file_url || m.author_file_url))
      .map(m => m.jar)
  },
  dependencyClosure: {
    client: depAudit(catalog, "client"),
    server: depAudit(catalog, "server"),
    clientGaps: findClientDependencyClosureGaps(catalog),
    serverGaps: findServerDependencyClosureGaps(catalog)
  },
  configs: {
    policies: Object.fromEntries(
      [...new Set(catalog.configs.map(c => c.policy))].map(p => [
        p,
        catalog.configs.filter(c => c.policy === p).length
      ])
    ),
    excludedPaths,
    requiredExclusionsPresent: {
      luckperms: excludedPaths.some(p => p.includes("luckperms")),
      resourcefulWeb: excludedPaths.includes("config/resourceful-config-web.json"),
      grieflogger: excludedPaths.some(p => p.includes("grieflogger")),
      casinoEconomy: excludedPaths.some(p => p.includes("xbasecasino/economy")),
      woverCached: excludedPaths.some(p => p.includes("wover/cached")),
      betternetherWorld: excludedPaths.some(p => p.includes("betternether/world")),
      minetracerDb: excludedPaths.some(p => p.includes("minetracer/database"))
    }
  },
  validation: { errorCount: errors.length, warnCount: warns.length, errors, warnings: warns },
  comparison,
  spotChecks: {
    alexsmobs_codxlib: pick("alexsmobs", "codxlib"),
    fallen_graves: {
      fallen: pick("fallen"),
      gravesInCatalog: catalog.mods.filter(m => m.mod_id === "universal-graves").length
    },
    betterend: pick("betterend"),
    worldgen: pick("terralith", "lithostitched", "structory", "cristellib", "t_and_t"),
    yung: catalog.mods
      .filter(m => /yung/i.test(m.mod_id) || /yung/i.test(m.jar))
      .map(m => ({ id: m.mod_id, side: m.side_class })),
    fabricApi: pick("fabric-api")
  }
};

await writeJson("data/rescan-clean-report.json", report);
console.log(JSON.stringify({ verdict: report.verdict, counts: report.counts, errors: errors.length, warns: warns.length, compare: {
  missingC: comparison.clientMissingInCatalog.length,
  missingS: comparison.serverMissingInCatalog.length,
  orphans: comparison.catalogOrphans.length,
  hash: comparison.hashMismatch.length,
  side: comparison.sideMismatch.length
}, depGaps: { c: report.dependencyClosure.clientGaps.length, s: report.dependencyClosure.serverGaps.length }, unresolved: report.providers.unresolvedFileUrl }, null, 2));
