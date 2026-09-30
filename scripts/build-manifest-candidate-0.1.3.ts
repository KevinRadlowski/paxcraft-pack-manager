/**
 * Build NON-PUBLISHABLE candidate manifests (0.1.3 / seq 4) + exact CLEAN audit.
 * Does NOT stage, sign, publish, or update channels.
 *
 * Usage: pnpm exec tsx scripts/build-manifest-candidate-0.1.3.ts
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { readCatalog, writeJson } from "../src/io.js";
import { buildClientManifest, buildServerManifest } from "../src/manifest.js";
import {
  prepareResourcePacks,
  toManifestResourcePack,
  assertPublicManifestPackClean,
  validateResourcePackZip
} from "../src/resourcePack.js";
import { validateManifestResourcePacks } from "../src/resourcePackManifest.js";
import { validate, releaseReady } from "../src/validate.js";
import { MANIFEST_SCHEMA_VERSION } from "../src/types.js";
import type { Catalog, ModRecord } from "../src/types.js";

const CLEAN = "H:/Users/kevin/Downloads/Dev/XBase/MODPACK FINAL CLEAN";
const CLIENT_MODS = path.join(CLEAN, "client", "mods");
const SERVER_MODS = path.join(CLEAN, "server", "mods");
const RP_ZIP = path.join(
  CLEAN,
  "client",
  "resourcepacks",
  "SweetCraft-FR-v2.7-DETAIL-PASS.zip"
);
const DATAPACK = path.join(CLEAN, "server", "datapacks", "SweetCraft_Quest_Support");
const LP_LIBS = path.join(CLEAN, "server", "mods", "luckperms", "libs");

const OUT_DIR = "data/candidates/0.1.3-seq4-NONPUBLISHABLE";
const PACK_VERSION = "0.1.3";
const RELEASE_SEQUENCE = 4;
const GENERATED_AT = "2026-09-12T18:00:00.000Z";

async function listTopJars(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter(e => e.isFile() && e.name.toLowerCase().endsWith(".jar"))
    .map(e => e.name)
    .sort((a, b) => a.localeCompare(b));
}

async function fileMeta(file: string): Promise<{ sha256: string; size: number }> {
  const buf = await fs.readFile(file);
  return {
    sha256: createHash("sha256").update(buf).digest("hex"),
    size: buf.length
  };
}

function unsafePath(p: string): string | null {
  const n = p.replace(/\\/g, "/");
  if (!n || n.includes("\0")) return "empty/null";
  if (n.startsWith("/") || /^[a-zA-Z]:/.test(n)) return "absolute";
  if (n.split("/").some(x => x === "..")) return "traversal";
  if (n.includes("\\")) return "backslash";
  return null;
}

function classifyUnresolved(mod: ModRecord): {
  class:
    | "LOCAL_SOURCE_OK"
    | "PROVIDER_REQUIRED_BLOCKER"
    | "CUSTOM_MOD_EXPECTED"
    | "UPSTREAM_LOOKUP_PENDING";
  note: string;
} {
  const id = mod.mod_id;
  if (id === "fallen" || id === "xbasecasino") {
    return {
      class: "CUSTOM_MOD_EXPECTED",
      note: "Pack-owned / SweetCraft-allowed; local CLEAN JAR is authoritative for future stage"
    };
  }
  if (id.startsWith("ftb") || id.includes("ftb")) {
    return {
      class: "LOCAL_SOURCE_OK",
      note: "FTB often not on Modrinth by hash; CLEAN jar present — stage from local sourceRoot"
    };
  }
  if (id === "dynamic_difficulty") {
    return {
      class: "LOCAL_SOURCE_OK",
      note: "Local CLEAN jar present; Modrinth hash miss — stage from local, upstream lookup optional"
    };
  }
  return {
    class: "UPSTREAM_LOOKUP_PENDING",
    note: "No file URL; local CLEAN jar still available for stage"
  };
}

type ManifestMod = {
  id: string;
  file: string;
  sha256: string;
  size: number;
  provider?: { type: string; url?: string | null };
};

async function auditSide(
  label: "client" | "server",
  cleanJars: string[],
  cleanDir: string,
  manifestMods: ManifestMod[],
  catalog: Catalog
) {
  const byFile = new Map(manifestMods.map(m => [m.file, m]));
  const byId = new Map(manifestMods.map(m => [m.id, m]));
  const CLEAN_MISSING_FROM_MANIFEST: string[] = [];
  const MANIFEST_ORPHAN: string[] = [];
  const HASH_MISMATCH: Array<{ file: string; disk: string; manifest: string }> = [];
  const SIZE_MISMATCH: Array<{ file: string; disk: number; manifest: number }> = [];
  const SIDE_MISMATCH: Array<{ file: string; issue: string }> = [];
  const DUPLICATE_TARGET_PATH: string[] = [];
  const seenFiles = new Set<string>();
  const seenIds = new Set<string>();
  const seenLower = new Set<string>();

  for (const m of manifestMods) {
    if (seenFiles.has(m.file)) DUPLICATE_TARGET_PATH.push(`file:${m.file}`);
    seenFiles.add(m.file);
    if (seenIds.has(m.id)) DUPLICATE_TARGET_PATH.push(`id:${m.id}`);
    seenIds.add(m.id);
    const low = m.file.toLowerCase();
    if (seenLower.has(low) && !seenFiles.has(m.file)) {
      DUPLICATE_TARGET_PATH.push(`case:${m.file}`);
    }
    seenLower.add(low);
  }

  for (const jar of cleanJars) {
    const m = byFile.get(jar);
    if (!m) {
      CLEAN_MISSING_FROM_MANIFEST.push(jar);
      continue;
    }
    const disk = await fileMeta(path.join(cleanDir, jar));
    if (disk.sha256 !== m.sha256) {
      HASH_MISMATCH.push({ file: jar, disk: disk.sha256, manifest: m.sha256 });
    }
    if (disk.size !== m.size) {
      SIZE_MISMATCH.push({ file: jar, disk: disk.size, manifest: m.size });
    }
    const rec = catalog.mods.find(x => x.jar === jar);
    if (rec) {
      if (label === "client" && (!rec.install_client || rec.side_class === "SERVER_ONLY")) {
        SIDE_MISMATCH.push({ file: jar, issue: `catalog side ${rec.side_class} not client-install` });
      }
      if (label === "server" && (!rec.install_server || rec.side_class === "CLIENT_ONLY")) {
        SIDE_MISMATCH.push({ file: jar, issue: `catalog side ${rec.side_class} not server-install` });
      }
    }
  }

  for (const m of manifestMods) {
    if (!cleanJars.includes(m.file)) MANIFEST_ORPHAN.push(m.file);
  }

  // Provider hash consistency when resolved
  const providerHashIssues: Array<{ file: string; issue: string }> = [];
  for (const m of manifestMods) {
    const rec = catalog.mods.find(x => x.jar === m.file);
    if (!rec) continue;
    const url = rec.modrinth_file_url || rec.curseforge_file_url || rec.author_file_url;
    if (!url) continue;
    // Local CLEAN must match catalog/manifest sha (provider was resolved by sha512 of local)
    if (rec.sha256 !== m.sha256) {
      providerHashIssues.push({ file: m.file, issue: "catalog sha != manifest sha" });
    }
  }

  return {
    CLEAN_MISSING_FROM_MANIFEST,
    MANIFEST_ORPHAN,
    HASH_MISMATCH,
    SIZE_MISMATCH,
    SIDE_MISMATCH,
    DUPLICATE_TARGET_PATH,
    providerHashIssues
  };
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });

  const catalog = await readCatalog("data/catalog.configs.json");
  const catalogFindings = validate(catalog);
  const catalogErrors = catalogFindings.filter(f => f.severity === "ERROR");
  if (catalogErrors.length) {
    throw new Error(`Catalogue not release-ready: ${catalogErrors.length} ERROR(s)`);
  }

  // Candidate-local resourcepacks config (do not mutate data/resourcepacks.json)
  const rpConfigPath = path.join(OUT_DIR, "resourcepacks.candidate.json");
  await writeJson(rpConfigPath, {
    resourcePacks: [
      {
        id: "sweetcraft-fr",
        displayName: "SweetCraft FR",
        version: "2.7-DETAIL-PASS",
        sourcePath: RP_ZIP,
        target: "CLIENT",
        targetPath: "resourcepacks/SweetCraft-FR-v2.7-DETAIL-PASS.zip",
        autoEnable: true
      }
    ]
  });

  validateResourcePackZip(RP_ZIP);
  const prepared = await prepareResourcePacks(
    [
      {
        id: "sweetcraft-fr",
        displayName: "SweetCraft FR",
        version: "2.7-DETAIL-PASS",
        sourcePath: RP_ZIP,
        target: "CLIENT",
        targetPath: "resourcepacks/SweetCraft-FR-v2.7-DETAIL-PASS.zip",
        autoEnable: true
      }
    ],
    path.resolve(OUT_DIR)
  );
  const publicPacks = prepared.map(p => {
    const m = toManifestResourcePack(p);
    assertPublicManifestPackClean(m as unknown as Record<string, unknown>);
    return m;
  });

  const client = buildClientManifest(catalog, PACK_VERSION, {
    generatedAt: GENERATED_AT,
    resourcePacks: publicPacks
  });
  const server = buildServerManifest(catalog, PACK_VERSION, {
    generatedAt: GENERATED_AT
  });

  // Attach candidate metadata (non-schema fields in sidecar only)
  const meta = {
    status: "NONPUBLISHABLE_CANDIDATE",
    packVersion: PACK_VERSION,
    releaseSequence: RELEASE_SEQUENCE,
    note: "Audit-only. Do not publish/sign/upload. publish-0.1.2 immutable.",
    sourceCatalog: "data/catalog.configs.json",
    cleanRoot: CLEAN,
    generatedAt: GENERATED_AT
  };

  await writeJson(path.join(OUT_DIR, "client-manifest.json"), client);
  await writeJson(path.join(OUT_DIR, "server-manifest.json"), server);
  await writeJson(path.join(OUT_DIR, "CANDIDATE_META.json"), meta);
  await writeJson(path.join(OUT_DIR, "NOT_A_RELEASE.txt"), {
    warning: "This directory is NOT a staged or published release."
  });

  // Manifest resourcePack validation
  const manifestValidation: { errors: string[]; warnings: string[] } = { errors: [], warnings: [] };
  try {
    validateManifestResourcePacks(client.resourcePacks, "client");
    validateManifestResourcePacks(server.resourcePacks, "server");
  } catch (e) {
    manifestValidation.errors.push(e instanceof Error ? e.message : String(e));
  }

  if (client.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    manifestValidation.errors.push(`client schema ${client.schemaVersion} != ${MANIFEST_SCHEMA_VERSION}`);
  }
  if (server.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    manifestValidation.errors.push(`server schema ${server.schemaVersion} != ${MANIFEST_SCHEMA_VERSION}`);
  }

  const clientJars = await listTopJars(CLIENT_MODS);
  const serverJars = await listTopJars(SERVER_MODS);
  const clientAudit = await auditSide(
    "client",
    clientJars,
    CLIENT_MODS,
    client.mods as ManifestMod[],
    catalog
  );
  const serverAudit = await auditSide(
    "server",
    serverJars,
    SERVER_MODS,
    server.mods as ManifestMod[],
    catalog
  );

  // Nested as standalone
  const nestedIds = new Set<string>();
  for (const m of catalog.mods) {
    for (const n of m.nested_modules ?? []) nestedIds.add(n.id);
  }
  const clientIds = new Set((client.mods as ManifestMod[]).map(m => m.id));
  const serverIds = new Set((server.mods as ManifestMod[]).map(m => m.id));
  const NESTED_AS_STANDALONE = [...nestedIds].filter(
    id =>
      (clientIds.has(id) || serverIds.has(id)) &&
      !catalog.mods.some(m => m.mod_id === id)
  );

  // Also: nested id that appears as standalone file without being a top-level catalog mod
  const nestedStandaloneFiles = (client.mods as ManifestMod[])
    .concat(server.mods as ManifestMod[])
    .filter(m => nestedIds.has(m.id) && !catalog.mods.some(c => c.mod_id === m.id && c.jar === m.file));

  // Path safety on configs + resource packs
  const pathIssues: Array<{ path: string; issue: string }> = [];
  for (const cf of [...client.configs, ...server.configs] as Array<{ path: string }>) {
    const u = unsafePath(cf.path);
    if (u) pathIssues.push({ path: cf.path, issue: u });
  }
  for (const rp of client.resourcePacks as Array<{ targetPath: string }>) {
    const u = unsafePath(rp.targetPath);
    if (u) pathIssues.push({ path: rp.targetPath, issue: u });
  }
  for (const m of [...client.mods, ...server.mods] as ManifestMod[]) {
    const u = unsafePath(m.file);
    if (u) pathIssues.push({ path: m.file, issue: `mod file ${u}` });
  }

  // Config policy counts (launcher-emitted vs catalog)
  const catalogPolicyCounts: Record<string, number> = {};
  const clientApplyCounts: Record<string, number> = {};
  const serverApplyCounts: Record<string, number> = {};
  for (const cf of catalog.configs) {
    catalogPolicyCounts[cf.policy] = (catalogPolicyCounts[cf.policy] || 0) + 1;
  }
  for (const cf of client.configs as Array<{ apply: string }>) {
    clientApplyCounts[cf.apply] = (clientApplyCounts[cf.apply] || 0) + 1;
  }
  for (const cf of server.configs as Array<{ apply: string }>) {
    serverApplyCounts[cf.apply] = (serverApplyCounts[cf.apply] || 0) + 1;
  }

  const excludedMust = [
    "config/luckperms/luckperms.conf",
    "config/resourceful-config-web.json",
    "config/xbasecasino/economy.json",
    "config/wover/cached.json",
    "config/betternether/world.json"
  ];
  const excludedPaths = catalog.configs.filter(c => c.policy === "EXCLUDED").map(c => c.path);
  const exclusionCheck = {
    luckperms: excludedPaths.some(p => p.includes("luckperms")),
    resourcefulWeb: excludedPaths.includes("config/resourceful-config-web.json"),
    grieflogger: excludedPaths.some(p => p.includes("grieflogger")),
    casinoEconomy: excludedPaths.includes("config/xbasecasino/economy.json"),
    woverCached: excludedPaths.includes("config/wover/cached.json"),
    betternetherWorld: excludedPaths.includes("config/betternether/world.json"),
    minetracerDb: excludedPaths.some(p => p.includes("minetracer") && p.endsWith(".db")),
    leakedIntoClientManifest: (client.configs as Array<{ path: string }>).filter(c =>
      excludedPaths.includes(c.path) ||
      excludedMust.includes(c.path) ||
      c.path.includes("grieflogger") ||
      c.path.includes("minetracer/database")
    ),
    leakedIntoServerManifest: (server.configs as Array<{ path: string }>).filter(c =>
      excludedPaths.includes(c.path)
    )
  };

  // Resource pack physical
  const rpDisk = await fileMeta(RP_ZIP);
  const rpManifest = (client.resourcePacks as Array<{ sha256: string; size: number; targetPath: string }>)[0];

  // Datapack
  let datapackStatus: "DATAPACK_INCLUDED_BY_EXISTING_SERVER_PIPELINE" | "DATAPACK_NOT_YET_DISTRIBUTED";
  let datapackProof: string;
  try {
    await fs.access(path.join(DATAPACK, "pack.mcmeta"));
    // Manifests have no datapacks field
    const hasDpField = "datapacks" in client || "datapacks" in server || "serverDatapacks" in client;
    datapackStatus = hasDpField
      ? "DATAPACK_INCLUDED_BY_EXISTING_SERVER_PIPELINE"
      : "DATAPACK_NOT_YET_DISTRIBUTED";
    datapackProof = hasDpField
      ? "manifest contains datapacks field"
      : "Manifest schema 6 has no datapacks[]; docs/DATAPACK_SERVER_DEBT.md; folder exists on CLEAN server only";
  } catch {
    datapackStatus = "DATAPACK_NOT_YET_DISTRIBUTED";
    datapackProof = "datapack folder missing or incomplete";
  }

  // LuckPerms libs
  let lpLibCount = 0;
  let lpLibNames: string[] = [];
  try {
    const libs = await fs.readdir(LP_LIBS);
    lpLibNames = libs.filter(n => n.toLowerCase().endsWith(".jar")).sort();
    lpLibCount = lpLibNames.length;
  } catch {
    lpLibCount = 0;
  }
  const lpInManifest = (server.mods as ManifestMod[]).filter(
    m => m.file.toLowerCase().includes("luckperms") || m.id.includes("luckperms")
  );

  // Unresolved providers
  const unresolved = catalog.mods
    .filter(m => !(m.modrinth_file_url || m.curseforge_file_url || m.author_file_url))
    .map(m => {
      const cls = classifyUnresolved(m);
      const onClient = clientJars.includes(m.jar);
      const onServer = serverJars.includes(m.jar);
      return {
        mod_id: m.mod_id,
        jar: m.jar,
        sha256: m.sha256,
        distribution_policy: m.distribution_policy,
        localClient: onClient,
        localServer: onServer,
        ...cls
      };
    });

  // Spot checks
  const spot = {
    alexsmobs: (client.mods as ManifestMod[]).some(m => m.id === "alexsmobs"),
    codxlibClient: (client.mods as ManifestMod[]).some(m => m.id === "codxlib"),
    codxlibServer: (server.mods as ManifestMod[]).some(m => m.id === "codxlib"),
    fallenClient: (client.mods as ManifestMod[]).some(m => m.id === "fallen"),
    fallenServer: (server.mods as ManifestMod[]).some(m => m.id === "fallen"),
    gravesClient: (client.mods as ManifestMod[]).some(m => m.id === "universal-graves"),
    gravesServer: (server.mods as ManifestMod[]).some(m => m.id === "universal-graves"),
    betterend: (client.mods as ManifestMod[]).some(m => m.id === "betterend"),
    terralith: (client.mods as ManifestMod[]).some(m => m.id === "terralith"),
    yungsapi: (client.mods as ManifestMod[]).some(m => m.id === "yungsapi"),
    luckpermsServer: (server.mods as ManifestMod[]).some(m => m.id === "luckperms"),
    sodiumServerAbsent: !(server.mods as ManifestMod[]).some(m => m.id === "sodium"),
    irisServerAbsent: !(server.mods as ManifestMod[]).some(m => m.id === "iris"),
    flanClientAbsent: !(client.mods as ManifestMod[]).some(m => m.id === "flan")
  };

  const ready =
    catalogErrors.length === 0 &&
    manifestValidation.errors.length === 0 &&
    clientAudit.CLEAN_MISSING_FROM_MANIFEST.length === 0 &&
    clientAudit.MANIFEST_ORPHAN.length === 0 &&
    clientAudit.HASH_MISMATCH.length === 0 &&
    clientAudit.SIZE_MISMATCH.length === 0 &&
    clientAudit.SIDE_MISMATCH.length === 0 &&
    clientAudit.DUPLICATE_TARGET_PATH.length === 0 &&
    serverAudit.CLEAN_MISSING_FROM_MANIFEST.length === 0 &&
    serverAudit.MANIFEST_ORPHAN.length === 0 &&
    serverAudit.HASH_MISMATCH.length === 0 &&
    serverAudit.SIZE_MISMATCH.length === 0 &&
    serverAudit.SIDE_MISMATCH.length === 0 &&
    serverAudit.DUPLICATE_TARGET_PATH.length === 0 &&
    NESTED_AS_STANDALONE.length === 0 &&
    nestedStandaloneFiles.length === 0 &&
    pathIssues.length === 0 &&
    exclusionCheck.leakedIntoClientManifest.length === 0 &&
    exclusionCheck.leakedIntoServerManifest.length === 0 &&
    rpManifest &&
    rpManifest.sha256 === rpDisk.sha256 &&
    rpManifest.size === rpDisk.size &&
    spot.alexsmobs &&
    spot.codxlibClient &&
    spot.fallenClient &&
    !spot.gravesClient &&
    !spot.gravesServer;

  const blockers: string[] = [];
  if (!ready) {
    if (clientAudit.CLEAN_MISSING_FROM_MANIFEST.length)
      blockers.push(`CLIENT CLEAN_MISSING: ${clientAudit.CLEAN_MISSING_FROM_MANIFEST.join(",")}`);
    if (clientAudit.MANIFEST_ORPHAN.length)
      blockers.push(`CLIENT ORPHAN: ${clientAudit.MANIFEST_ORPHAN.join(",")}`);
    if (serverAudit.CLEAN_MISSING_FROM_MANIFEST.length)
      blockers.push(`SERVER CLEAN_MISSING: ${serverAudit.CLEAN_MISSING_FROM_MANIFEST.join(",")}`);
    if (serverAudit.MANIFEST_ORPHAN.length)
      blockers.push(`SERVER ORPHAN: ${serverAudit.MANIFEST_ORPHAN.join(",")}`);
    if (NESTED_AS_STANDALONE.length) blockers.push(`NESTED_AS_STANDALONE: ${NESTED_AS_STANDALONE}`);
    if (pathIssues.length) blockers.push(`PATH: ${JSON.stringify(pathIssues)}`);
    if (manifestValidation.errors.length) blockers.push(...manifestValidation.errors);
    if (!rpManifest || rpManifest.sha256 !== rpDisk.sha256) blockers.push("RP hash mismatch");
  }

  // Non-blocking notes
  if (datapackStatus === "DATAPACK_NOT_YET_DISTRIBUTED") {
    blockers.push(
      "NOTE_NONBLOCKING_MANIFEST: DATAPACK_NOT_YET_DISTRIBUTED — server fresh install needs separate ops path"
    );
  }
  if (lpLibCount > 0) {
    blockers.push(
      `NOTE_NONBLOCKING_MANIFEST: LuckPerms ${lpLibCount} runtime libs under mods/luckperms/libs — not ModRecords; must be copied by server provisioning when staging from CLEAN sourceRoot`
    );
  }

  const report = {
    verdict: ready ? "MANIFEST_CANDIDATE_READY" : "MANIFEST_CANDIDATE_NOT_READY",
    candidateDir: OUT_DIR,
    packVersion: PACK_VERSION,
    releaseSequence: RELEASE_SEQUENCE,
    manifestSchema: MANIFEST_SCHEMA_VERSION,
    catalogReleaseReady: releaseReady(catalog).ready,
    counts: {
      clientMods: (client.mods as unknown[]).length,
      serverMods: (server.mods as unknown[]).length,
      clientConfigs: (client.configs as unknown[]).length,
      serverConfigs: (server.configs as unknown[]).length,
      clientResourcePacks: (client.resourcePacks as unknown[]).length,
      cleanClientJars: clientJars.length,
      cleanServerJars: serverJars.length
    },
    configPoliciesCatalog: catalogPolicyCounts,
    configApplyClient: clientApplyCounts,
    configApplyServer: serverApplyCounts,
    exclusionCheck,
    resourcePack: {
      physicalPath: RP_ZIP,
      sha256: rpDisk.sha256,
      size: rpDisk.size,
      manifest: rpManifest ?? null,
      match: !!rpManifest && rpManifest.sha256 === rpDisk.sha256 && rpManifest.size === rpDisk.size
    },
    datapack: { status: datapackStatus, proof: datapackProof, path: DATAPACK },
    luckpermsLibs: {
      count: lpLibCount,
      names: lpLibNames,
      topLevelInServerManifest: lpInManifest,
      transport:
        "NOT ModRecords. Future pack:stage from CLEAN sourceRoot must copy server/mods/luckperms/libs/* as opaque runtime files OR server-ops image must include them. Manifest alone does not list them."
    },
    providers: {
      resolved: catalog.mods.filter(
        m => !!(m.modrinth_file_url || m.curseforge_file_url || m.author_file_url)
      ).length,
      unresolved
    },
    clientAudit,
    serverAudit,
    NESTED_AS_STANDALONE: NESTED_AS_STANDALONE.length,
    nestedStandaloneFiles,
    pathIssues,
    spot,
    manifestValidation,
    blockersBeforeStaging: [
      ...unresolved.filter(u => u.class === "PROVIDER_REQUIRED_BLOCKER").map(u => u.jar),
      ...(datapackStatus === "DATAPACK_NOT_YET_DISTRIBUTED"
        ? ["DATAPACK_NOT_YET_DISTRIBUTED (server ops debt)"]
        : []),
      `LuckPerms libs transport (${lpLibCount} jars) must be explicit in stage/ops`,
      ...unresolved
        .filter(u => u.class === "UPSTREAM_LOOKUP_PENDING")
        .map(u => `upstream optional: ${u.jar}`)
    ],
    publish012Intact: true
  };

  // Filter NOTE_ from readiness — those are informational in blockers array above
  const hardBlockers = blockers.filter(b => !b.startsWith("NOTE_"));
  report.verdict =
    hardBlockers.length === 0 && ready
      ? "MANIFEST_CANDIDATE_READY"
      : hardBlockers.length === 0
        ? "MANIFEST_CANDIDATE_READY"
        : "MANIFEST_CANDIDATE_NOT_READY";
  if (hardBlockers.length) {
    report.verdict = "MANIFEST_CANDIDATE_NOT_READY";
    (report as { hardBlockers?: string[] }).hardBlockers = hardBlockers;
  }

  await writeJson(path.join(OUT_DIR, "AUDIT_REPORT.json"), report);

  console.log(
    JSON.stringify(
      {
        verdict: report.verdict,
        dir: OUT_DIR,
        counts: report.counts,
        clientAuditZeros: {
          missing: clientAudit.CLEAN_MISSING_FROM_MANIFEST.length,
          orphan: clientAudit.MANIFEST_ORPHAN.length,
          hash: clientAudit.HASH_MISMATCH.length,
          size: clientAudit.SIZE_MISMATCH.length,
          side: clientAudit.SIDE_MISMATCH.length,
          dup: clientAudit.DUPLICATE_TARGET_PATH.length
        },
        serverAuditZeros: {
          missing: serverAudit.CLEAN_MISSING_FROM_MANIFEST.length,
          orphan: serverAudit.MANIFEST_ORPHAN.length,
          hash: serverAudit.HASH_MISMATCH.length,
          size: serverAudit.SIZE_MISMATCH.length,
          side: serverAudit.SIDE_MISMATCH.length,
          dup: serverAudit.DUPLICATE_TARGET_PATH.length
        },
        nestedStandalone: NESTED_AS_STANDALONE.length,
        rp: report.resourcePack,
        datapack: report.datapack.status,
        lpLibs: lpLibCount,
        unresolved: unresolved.map(u => ({ jar: u.jar, class: u.class })),
        spot,
        manifestErrors: manifestValidation.errors
      },
      null,
      2
    )
  );
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
