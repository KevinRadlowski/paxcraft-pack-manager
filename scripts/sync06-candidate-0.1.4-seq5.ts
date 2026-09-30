/**
 * PACK-10.1SYNC-06 — local non-published candidate 0.1.4 / seq5
 * Stage, validate, materialize, projection compare, determinism, delta 0.1.3→0.1.4.
 * NO publish / deploy / commit / push.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyModeForPolicy, buildClientManifest, buildServerManifest } from "../src/manifest.js";
import { findExclusion } from "../src/configPolicyRules.js";
import { readCatalog } from "../src/io.js";
import { countArtifactKinds, planReleaseHostedMods } from "../src/releaseHosted.js";
import { UnsignedDevSigner } from "../src/releaseSigning.js";
import { DEFAULT_ORIGIN } from "../src/remotePaths.js";
import { stageRelease } from "../src/stage.js";
import { runStagePreflight } from "../src/stagePreflight.js";
import { verifyRelease } from "../src/verifyRelease.js";
import { validate, releaseReady } from "../src/validate.js";
import { findPackDependencyClosureGaps } from "../src/dependencyClosure.js";
import { configMigrationsForManifest } from "../src/configMigrations.js";
import type { Catalog } from "../src/types.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLEAN =
  process.env.SWEETCRAFT_CLEAN_ROOT ??
  path.resolve(ROOT, "..", "..", "MODPACK FINAL CLEAN");
const CATALOG = path.join(ROOT, "data", "catalog.configs.json");
const RELEASES = path.join(ROOT, "data", "releases");
const PRIOR_RELEASE = path.join(RELEASES, "0.1.3");
const CANONICAL = path.join(RELEASES, "0.1.4");
const REPORT_DIR = path.join(ROOT, "data", "candidates", "0.1.4-seq5-NONPUBLISHABLE");
const PACK_VERSION = "0.1.4";
const SEQUENCE = 5;
const CREATED_AT = "2026-09-15T20:00:00.000Z";
const RP_FILE = path.join(ROOT, "data", "resourcepacks.json");
const SDP_FILE = path.join(ROOT, "data", "serverDatapacks.json");

const CASINO_JAR_SHA = "750128c35b68443e5cf3e760cc29781a79229c60473681dedb91b40acf7e269c";
const DD_SYNC_SHA = "f6e72109408f1343fdd748e828e9094ad8e52609a34da9f98114e2d8c8c05205";
const RP_FR_SHA = "f491caae5e1485d3e9c709f44cc81099ce6e742c48a9a33818740d643b09250f";

const REMOVED_MOD_IDS = [
  "armoredfoes",
  "bettercombat",
  "distanthorizons",
  "player_animation_library",
  "uselessreptile",
  "visualworkbench",
  "yet_another_config_lib_v3"
] as const;

type DiffCategory =
  | "EXPECTED_EXCLUDE"
  | "EXPECTED_SCOPE_DIFFERENCE"
  | "EXPECTED_POLICY/SEED"
  | "MISSING_MANAGED"
  | "UNEXPECTED_EXTRA"
  | "HASH_MISMATCH"
  | "UNKNOWN";

interface FileRecord {
  path: string;
  size: number;
  sha256: string;
  source?: string;
  policy?: string;
  scope?: string;
}

interface CompareDiff {
  path: string;
  category: DiffCategory;
  side: "client" | "server";
  detail: string;
}

function sha256buf(b: Buffer): string {
  return createHash("sha256").update(b).digest("hex");
}

async function sha256file(p: string): Promise<string> {
  return sha256buf(await fs.readFile(p));
}

async function listFilesRecursive(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string) {
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (e.isFile()) out.push(abs);
    }
  }
  await walk(dir);
  return out;
}

async function materializeMergedConfigSource(cleanRoot: string, destRoot: string): Promise<void> {
  await fs.rm(destRoot, { recursive: true, force: true });
  await fs.mkdir(path.join(destRoot, "config"), { recursive: true });
  for (const side of ["client", "server"] as const) {
    const cfgRoot = path.join(cleanRoot, side, "config");
    for (const abs of await listFilesRecursive(cfgRoot)) {
      const rel = path.relative(cfgRoot, abs).split(path.sep).join("/");
      const dest = path.join(destRoot, "config", ...rel.split("/"));
      await fs.mkdir(path.dirname(dest), { recursive: true });
      try {
        await fs.access(dest);
      } catch {
        await fs.copyFile(abs, dest);
      }
    }
  }
}

async function fingerprintCleanMods(cleanRoot: string): Promise<string> {
  const lines: string[] = [];
  for (const side of ["client", "server"] as const) {
    const dir = path.join(cleanRoot, side, "mods");
    const jars = (await fs.readdir(dir)).filter(f => f.toLowerCase().endsWith(".jar")).sort();
    for (const j of jars) {
      const abs = path.join(dir, j);
      const st = await fs.stat(abs);
      lines.push(`${side}\t${j}\t${st.size}\t${await sha256file(abs)}`);
    }
  }
  return lines.join("\n") + "\n";
}

async function fingerprintPayloadTree(releaseDir: string): Promise<string> {
  const files = (await listFilesRecursive(releaseDir))
    .map(a => path.relative(releaseDir, a).split(path.sep).join("/"))
    .filter(r => r.startsWith("files/") || r.endsWith("-manifest.json") || r === "checksums.json")
    .sort();
  const lines: string[] = [];
  for (const rel of files) {
    const abs = path.join(releaseDir, ...rel.split("/"));
    const st = await fs.stat(abs);
    lines.push(`${await sha256file(abs)}\t${st.size}\t${rel}`);
  }
  return lines.join("\n") + "\n";
}

async function buildProjectionInventory(
  side: "client" | "server",
  catalog: Catalog,
  mergedSource: string,
  cleanRoot: string,
  manifest: {
    mods: { id: string; file: string; sha256: string; size: number }[];
    configs: { path: string; sha256: string; policy: string }[];
    resourcePacks?: { targetPath: string; sha256: string; size: number }[];
    serverDatapacks?: { files: { path: string; sha256: string; size: number }[] }[];
  }
): Promise<Map<string, FileRecord>> {
  const out = new Map<string, FileRecord>();

  for (const m of manifest.mods) {
    const modDir = side === "client" ? path.join(cleanRoot, "client", "mods") : path.join(cleanRoot, "server", "mods");
    const abs = path.join(modDir, m.file);
    let sha = m.sha256;
    let size = m.size;
    try {
      const st = await fs.stat(abs);
      sha = await sha256file(abs);
      size = st.size;
    } catch {
      /* manifest hash is authoritative for provider mods */
    }
    out.set(`mods/${m.file}`, {
      path: `mods/${m.file}`,
      size,
      sha256: sha,
      source: `CLEAN/${side}/mods/${m.file}`,
      scope: side
    });
  }

  for (const cf of manifest.configs) {
    // Staging reads all managed configs from merged source (client wins on path collision).
    const srcAbs = path.join(mergedSource, cf.path);
    try {
      const data = await fs.readFile(srcAbs);
      out.set(cf.path, {
        path: cf.path,
        size: data.length,
        sha256: sha256buf(data),
        source: srcAbs.replace(/\\/g, "/"),
        policy: cf.policy,
        scope: side
      });
    } catch {
      out.set(cf.path, {
        path: cf.path,
        size: 0,
        sha256: cf.sha256,
        source: "MISSING_ON_MERGED_SOURCE",
        policy: cf.policy,
        scope: side
      });
    }
  }

  if (side === "client" && manifest.resourcePacks) {
    for (const rp of manifest.resourcePacks) {
      const abs = path.join(cleanRoot, "client", rp.targetPath);
      try {
        const data = await fs.readFile(abs);
        out.set(rp.targetPath, {
          path: rp.targetPath,
          size: data.length,
          sha256: sha256buf(data),
          source: abs.replace(/\\/g, "/"),
          scope: "client"
        });
      } catch {
        out.set(rp.targetPath, {
          path: rp.targetPath,
          size: rp.size,
          sha256: rp.sha256,
          source: "MISSING_ON_CLEAN",
          scope: "client"
        });
      }
    }
  }

  if (side === "server" && manifest.serverDatapacks) {
    for (const dp of manifest.serverDatapacks) {
      for (const f of dp.files) {
        const abs = path.join(cleanRoot, "server", ...f.path.split("/"));
        const data = await fs.readFile(abs);
        out.set(f.path, {
          path: f.path,
          size: data.length,
          sha256: sha256buf(data),
          source: abs.replace(/\\/g, "/"),
          scope: "server"
        });
      }
    }
  }

  return out;
}

async function buildCandidateInventory(
  side: "client" | "server",
  releaseDir: string,
  manifest: {
    mods: { id: string; file: string; sha256: string; size: number; provider?: { type: string; url: string | null } }[];
    configs: { path: string; sha256: string; policy: string }[];
    resourcePacks?: { targetPath: string; sha256: string; size: number }[];
    serverDatapacks?: { files: { path: string; sha256: string; size: number }[] }[];
  }
): Promise<Map<string, FileRecord>> {
  const out = new Map<string, FileRecord>();

  for (const m of manifest.mods) {
    const hosted = path.join(releaseDir, "files", "mods", m.file);
    let sha = m.sha256;
    let size = m.size;
    let source = m.provider?.url ?? "PROVIDER";
    try {
      await fs.access(hosted);
      sha = await sha256file(hosted);
      size = (await fs.stat(hosted)).size;
      source = `RELEASE_HOSTED:${hosted}`;
    } catch {
      /* provider-only mod */
    }
    out.set(`mods/${m.file}`, {
      path: `mods/${m.file}`,
      size,
      sha256: sha,
      source,
      scope: side
    });
  }

  for (const cf of manifest.configs) {
    const staged = path.join(releaseDir, "files", cf.path);
    try {
      const data = await fs.readFile(staged);
      out.set(cf.path, {
        path: cf.path,
        size: data.length,
        sha256: sha256buf(data),
        source: staged.replace(/\\/g, "/"),
        policy: cf.policy,
        scope: side
      });
    } catch {
      out.set(cf.path, {
        path: cf.path,
        size: 0,
        sha256: cf.sha256,
        source: "MISSING_STAGED",
        policy: cf.policy,
        scope: side
      });
    }
  }

  if (side === "client" && manifest.resourcePacks) {
    for (const rp of manifest.resourcePacks) {
      const base = path.basename(rp.targetPath);
      const staged = path.join(releaseDir, "files", "resourcepacks", base);
      try {
        const data = await fs.readFile(staged);
        out.set(rp.targetPath, {
          path: rp.targetPath,
          size: data.length,
          sha256: sha256buf(data),
          source: staged.replace(/\\/g, "/"),
          scope: "client"
        });
      } catch {
        out.set(rp.targetPath, {
          path: rp.targetPath,
          size: rp.size,
          sha256: rp.sha256,
          source: "MISSING_STAGED",
          scope: "client"
        });
      }
    }
  }

  if (side === "server" && manifest.serverDatapacks) {
    for (const dp of manifest.serverDatapacks) {
      for (const f of dp.files) {
        const staged = path.join(releaseDir, "files", ...f.path.split("/"));
        const data = await fs.readFile(staged);
        out.set(f.path, {
          path: f.path,
          size: data.length,
          sha256: sha256buf(data),
          source: staged.replace(/\\/g, "/"),
          scope: "server"
        });
      }
    }
  }

  return out;
}

function classifyCleanOnlyPath(relPath: string, side: "client" | "server"): DiffCategory {
  if (findExclusion(relPath)) return "EXPECTED_EXCLUDE";
  if (relPath === "config/DistantHorizons.toml") return "EXPECTED_EXCLUDE";
  if (relPath.startsWith("config/inventoryprofilesnext/sweetcraft.datho.st/")) return "EXPECTED_EXCLUDE";
  if (relPath.startsWith("config/inventoryprofilesnext/localhost/")) return "EXPECTED_EXCLUDE";
  if (relPath.startsWith("config/inventoryprofilesnext/Nouveau monde/")) return "EXPECTED_EXCLUDE";
  if (relPath.startsWith("config/inventoryprofilesnext/integrationHints/")) return "EXPECTED_EXCLUDE";
  if (relPath.startsWith("config/inventoryprofilesnext/vortex")) return "EXPECTED_EXCLUDE";
  if (relPath.includes("luckperms") && relPath.includes("/libs/")) return "EXPECTED_EXCLUDE";
  if (side === "client" && relPath.startsWith("config/ftbquests/quests/")) return "EXPECTED_SCOPE_DIFFERENCE";
  if (side === "server" && relPath.startsWith("config/jei/")) return "EXPECTED_SCOPE_DIFFERENCE";
  return "UNKNOWN";
}

function compareInventories(
  side: "client" | "server",
  expected: Map<string, FileRecord>,
  actual: Map<string, FileRecord>
): CompareDiff[] {
  const diffs: CompareDiff[] = [];
  const allPaths = new Set([...expected.keys(), ...actual.keys()]);
  for (const p of [...allPaths].sort()) {
    const e = expected.get(p);
    const a = actual.get(p);
    if (e && !a) {
      diffs.push({ path: p, category: "MISSING_MANAGED", side, detail: "in projection, absent from candidate" });
    } else if (!e && a) {
      diffs.push({ path: p, category: "UNEXPECTED_EXTRA", side, detail: "in candidate, absent from projection" });
    } else if (e && a && e.sha256 !== a.sha256) {
      diffs.push({
        path: p,
        category: "HASH_MISMATCH",
        side,
        detail: `expected=${e.sha256} actual=${a.sha256}`
      });
    }
  }
  return diffs;
}

async function materializeAuditTree(
  side: "client" | "server",
  releaseDir: string,
  manifest: Parameters<typeof buildCandidateInventory>[2],
  destRoot: string
): Promise<void> {
  await fs.rm(destRoot, { recursive: true, force: true });
  for (const m of manifest.mods) {
    const hosted = path.join(releaseDir, "files", "mods", m.file);
    const dest = path.join(destRoot, "mods", m.file);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    try {
      await fs.copyFile(hosted, dest);
    } catch {
      /* provider mod — not physically in release */
    }
  }
  for (const cf of manifest.configs) {
    const src = path.join(releaseDir, "files", cf.path);
    const dest = path.join(destRoot, cf.path);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(src, dest);
  }
  if (side === "client" && manifest.resourcePacks) {
    for (const rp of manifest.resourcePacks) {
      const base = path.basename(rp.targetPath);
      const src = path.join(releaseDir, "files", "resourcepacks", base);
      const dest = path.join(destRoot, rp.targetPath);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(src, dest);
    }
  }
  if (side === "server" && manifest.serverDatapacks) {
    for (const dp of manifest.serverDatapacks) {
      for (const f of dp.files) {
        const src = path.join(releaseDir, "files", ...f.path.split("/"));
        const dest = path.join(destRoot, f.path);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.copyFile(src, dest);
      }
    }
  }
}

interface ManifestMod {
  id: string;
  file: string;
  version?: string;
  sha256: string;
  size: number;
  provider?: { type: string; url: string | null };
}

interface ManifestConfig {
  path: string;
  sha256: string;
  policy: string;
  apply?: string;
}

interface ClientManifest {
  schemaVersion: number;
  mods: ManifestMod[];
  configs: ManifestConfig[];
  resourcePacks?: { id: string; version: string; sha256: string; size: number; targetPath: string; autoEnable: boolean; url: string }[];
  configMigrations?: unknown[];
}

interface ServerManifest {
  schemaVersion: number;
  mods: ManifestMod[];
  configs: ManifestConfig[];
  resourcePacks?: unknown[];
  serverDatapacks?: { id: string; files: { path: string; sha256: string; size: number }[] }[];
}

async function buildReleaseDelta(
  priorClient: ClientManifest,
  priorServer: ServerManifest,
  nextClient: ClientManifest,
  nextServer: ServerManifest
) {
  const priorModIds = new Set([...priorClient.mods, ...priorServer.mods].map(m => m.id));
  const nextModIds = new Set([...nextClient.mods, ...nextServer.mods].map(m => m.id));

  const ADD = nextClient.mods
    .filter(m => !priorModIds.has(m.id))
    .map(m => ({ id: m.id, file: m.file, sha256: m.sha256 }));
  const DELETE_MANAGED = [...priorModIds].filter(id => !nextModIds.has(id)).sort();

  const REPLACE: { id: string; from: { file: string; sha256: string }; to: { file: string; sha256: string } }[] = [];
  const priorById = new Map(priorClient.mods.map(m => [m.id, m]));
  for (const m of priorServer.mods) priorById.set(m.id, m);
  const nextById = new Map(nextClient.mods.map(m => [m.id, m]));
  for (const m of nextServer.mods) nextById.set(m.id, m);
  for (const id of nextModIds) {
    const p = priorById.get(id);
    const n = nextById.get(id);
    if (p && n && (p.sha256 !== n.sha256 || p.file !== n.file)) {
      REPLACE.push({ id, from: { file: p.file, sha256: p.sha256 }, to: { file: n.file, sha256: n.sha256 } });
    }
  }

  const priorCfg = new Map([...priorClient.configs, ...priorServer.configs].map(c => [c.path, c]));
  const nextCfg = new Map([...nextClient.configs, ...nextServer.configs].map(c => [c.path, c]));
  const configAdd = [...nextCfg.keys()].filter(k => !priorCfg.has(k)).sort();
  const configDelete = [...priorCfg.keys()].filter(k => !nextCfg.has(k)).sort();
  const configReplace = [...nextCfg.keys()]
    .filter(k => priorCfg.has(k) && priorCfg.get(k)!.sha256 !== nextCfg.get(k)!.sha256)
    .map(k => ({ path: k, from: priorCfg.get(k)!.sha256, to: nextCfg.get(k)!.sha256 }));

  const priorRp = new Map((priorClient.resourcePacks ?? []).map(r => [r.id, r]));
  const nextRp = new Map((nextClient.resourcePacks ?? []).map(r => [r.id, r]));
  const resourcepackChanges = {
    ADD: [...nextRp.keys()].filter(k => !priorRp.has(k)),
    DELETE: [...priorRp.keys()].filter(k => !nextRp.has(k)),
    REPLACE: [...nextRp.keys()]
      .filter(k => priorRp.has(k) && priorRp.get(k)!.sha256 !== nextRp.get(k)!.sha256)
      .map(k => ({ id: k, from: priorRp.get(k)!.sha256, to: nextRp.get(k)!.sha256 }))
  };

  return {
    from: { packVersion: "0.1.3", sequence: 4 },
    to: { packVersion: PACK_VERSION, sequence: SEQUENCE },
    mods: { ADD, REPLACE, DELETE_MANAGED },
    configs: { ADD: configAdd, DELETE_MANAGED: configDelete, REPLACE: configReplace },
    resourcePacks: resourcepackChanges,
    configMigrations: configMigrationsForManifest(PACK_VERSION),
    totals: {
      modAdd: ADD.length,
      modReplace: REPLACE.length,
      modDelete: DELETE_MANAGED.length,
      configAdd: configAdd.length,
      configReplace: configReplace.length,
      configDelete: configDelete.length
    }
  };
}

async function main() {
  const blockers: string[] = [];
  await fs.mkdir(REPORT_DIR, { recursive: true });

  const catalog = await readCatalog(CATALOG);
  const kinds = countArtifactKinds(catalog);
  const plan = planReleaseHostedMods(catalog, { packVersion: PACK_VERSION, productOrigin: DEFAULT_ORIGIN });
  const ready = releaseReady(catalog);
  const findings = validate(catalog);
  const depErrors = findings.filter(
    f => f.code === "MISSING_DEP" || f.code === "VERSION_INCOMPATIBLE" || f.code === "ALIAS_REQUIRED"
  );
  const clientGaps = findPackDependencyClosureGaps(catalog, "client");
  const serverGaps = findPackDependencyClosureGaps(catalog, "server");

  const cleanClientCount = (await fs.readdir(path.join(CLEAN, "client", "mods"))).filter(f =>
    f.toLowerCase().endsWith(".jar")
  ).length;
  const cleanServerCount = (await fs.readdir(path.join(CLEAN, "server", "mods"))).filter(f =>
    f.toLowerCase().endsWith(".jar")
  ).length;
  const installClient = catalog.mods.filter(m => m.install_client).length;
  const installServer = catalog.mods.filter(m => m.install_server).length;

  if (kinds.unresolved !== 0) blockers.push(`unresolved=${kinds.unresolved}`);
  if (!ready.ready) blockers.push(`RELEASE_READY=NO (${ready.blocking.length} errors)`);
  if (depErrors.length) blockers.push(`depErrors=${depErrors.length}`);
  if (clientGaps.length || serverGaps.length) {
    blockers.push(`dependency gaps client=${clientGaps.length} server=${serverGaps.length}`);
  }
  if (cleanClientCount !== 110 || installClient !== 110) {
    blockers.push(`client count clean=${cleanClientCount} catalog=${installClient} expected 110`);
  }
  if (cleanServerCount !== 94 || installServer !== 94) {
    blockers.push(`server count clean=${cleanServerCount} catalog=${installServer} expected 94`);
  }
  if (catalog.mods.length !== 120) blockers.push(`catalog mods=${catalog.mods.length} expected 120`);

  const casino = catalog.mods.find(m => m.mod_id === "xbasecasino");
  if (!casino || casino.sha256 !== CASINO_JAR_SHA) blockers.push("Casino sha mismatch");
  const dd = catalog.configs.find(c => c.path === "config/dynamic_difficulty/sync.toml");
  if (!dd || dd.sha256 !== DD_SYNC_SHA) blockers.push("DD sync.toml sha mismatch");

  const compareOnly = process.env.SYNC06_COMPARE_ONLY === "1";
  let existingRelease = false;
  try {
    await fs.access(CANONICAL);
    existingRelease = true;
    if (!compareOnly) blockers.push(`candidate already exists: ${CANONICAL} (set SYNC06_COMPARE_ONLY=1 to re-compare)`);
  } catch {
    /* ok */
  }

  const preflight = await runStagePreflight({
    catalog,
    cleanRoot: CLEAN,
    configSourceRoot: path.join(CLEAN, "client"),
    resourcePacksFile: RP_FILE,
    serverDatapacksFile: SDP_FILE,
    packVersion: PACK_VERSION
  });
  if (preflight.verdict !== "STAGE_PREFLIGHT_READY") {
    blockers.push(`preflight=${preflight.verdict}`);
  }

  const cleanFpBefore = await fingerprintCleanMods(CLEAN);
  let priorReleaseFpBefore = "";
  try {
    priorReleaseFpBefore = await fingerprintPayloadTree(PRIOR_RELEASE);
  } catch {
    /* optional */
  }

  if (blockers.length) {
    const report = { verdict: "SYNC06_BLOCKED", blockers, preflight: preflight.verdict };
    await fs.writeFile(path.join(REPORT_DIR, "SYNC06_REPORT.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 2;
    return;
  }

  const mergedSource = path.join(REPORT_DIR, "_canonical-merged-config-source");
  await materializeMergedConfigSource(CLEAN, mergedSource);

  let releaseDir: string;
  if (existingRelease && compareOnly) {
    releaseDir = CANONICAL;
  } else {
    const staged = await stageRelease({
      catalog,
      packVersion: PACK_VERSION,
      sourceRoot: mergedSource,
      outDir: RELEASES,
      force: false,
      cleanRoot: CLEAN,
      productOrigin: DEFAULT_ORIGIN,
    resourcePacksFile: RP_FILE,
    serverDatapacksFile: SDP_FILE,
    createdAt: CREATED_AT,
    releaseSequence: SEQUENCE,
    signer: new UnsignedDevSigner()
  });
    releaseDir = staged.releaseDir;
  }
  const client = JSON.parse(await fs.readFile(path.join(releaseDir, "client-manifest.json"), "utf8")) as ClientManifest;
  const server = JSON.parse(await fs.readFile(path.join(releaseDir, "server-manifest.json"), "utf8")) as ServerManifest;
  const release = JSON.parse(await fs.readFile(path.join(releaseDir, "release.json"), "utf8")) as {
    packVersion: string;
    antiRollback: { releaseSequence: number | null };
    signature: { status: string };
    schemaVersion: number;
  };
  const checksums = JSON.parse(await fs.readFile(path.join(releaseDir, "checksums.json"), "utf8")) as {
    entries: { path: string; size: number; sha256: string }[];
  };

  const manifestIssues: string[] = [];
  if (client.mods.length !== 110) manifestIssues.push(`client mods=${client.mods.length}`);
  if (server.mods.length !== 94) manifestIssues.push(`server mods=${server.mods.length}`);
  if (release.antiRollback.releaseSequence !== SEQUENCE) manifestIssues.push("sequence mismatch");
  if (release.packVersion !== PACK_VERSION) manifestIssues.push("packVersion mismatch");
  if (release.signature.status !== "unsigned-dev") manifestIssues.push("expected unsigned-dev");

  const casinoM = client.mods.find(m => m.id === "xbasecasino");
  if (!casinoM || casinoM.sha256 !== CASINO_JAR_SHA) manifestIssues.push("Casino manifest sha");
  if (!casinoM?.file.includes("0.9.17")) manifestIssues.push("Casino version");

  for (const id of REMOVED_MOD_IDS) {
    if (client.mods.some(m => m.id === id) || server.mods.some(m => m.id === id)) {
      manifestIssues.push(`removed mod present: ${id}`);
    }
  }

  const ipn = client.configs.find(c => c.path === "config/inventoryprofilesnext/inventoryprofiles.json");
  if (!ipn || ipn.apply !== "if_missing") manifestIssues.push("IPN apply mode");
  const migrations = client.configMigrations ?? [];
  if (migrations.length !== 1) manifestIssues.push(`configMigrations count=${migrations.length}`);
  const mig = migrations[0] as { id?: string; fromPackVersions?: string[] } | undefined;
  if (mig?.id !== "ipn-autorefill-false-from-0.1.3") manifestIssues.push("configMigration id");
  if (!mig?.fromPackVersions?.includes("0.1.3")) manifestIssues.push("configMigration fromPackVersions");

  const fr = client.resourcePacks?.find(r => r.id === "sweetcraft-fr");
  const faithful = client.resourcePacks?.find(r => r.id === "faithful-64x-r13");
  if (!fr?.autoEnable) manifestIssues.push("SweetCraft-FR autoEnable");
  if (faithful?.autoEnable !== false) manifestIssues.push("Faithful autoEnable");
  if (fr?.sha256 !== RP_FR_SHA) manifestIssues.push("SweetCraft-FR sha");

  if (client.configs.some(c => c.path === "config/DistantHorizons.toml")) manifestIssues.push("DH in client");
  if (server.resourcePacks?.length) manifestIssues.push("RP on server manifest");

  const verify = await verifyRelease({ releaseDir, allowUnsignedDev: true });

  const auditClient = path.join(REPORT_DIR, "audit-materialize-client");
  const auditServer = path.join(REPORT_DIR, "audit-materialize-server");
  await materializeAuditTree("client", releaseDir, client, auditClient);
  await materializeAuditTree("server", releaseDir, server, auditServer);

  const projClient = await buildProjectionInventory("client", catalog, mergedSource, CLEAN, client);
  const projServer = await buildProjectionInventory("server", catalog, mergedSource, CLEAN, server);
  const candClient = await buildCandidateInventory("client", releaseDir, client);
  const candServer = await buildCandidateInventory("server", releaseDir, server);

  const clientDiffs = compareInventories("client", projClient, candClient);
  const serverDiffs = compareInventories("server", projServer, candServer);
  const unexplained = [...clientDiffs, ...serverDiffs].filter(
    d => !["EXPECTED_EXCLUDE", "EXPECTED_SCOPE_DIFFERENCE", "EXPECTED_POLICY/SEED"].includes(d.category)
  );

  const diffTotals: Record<DiffCategory, number> = {
    "EXPECTED_EXCLUDE": 0,
    "EXPECTED_SCOPE_DIFFERENCE": 0,
    "EXPECTED_POLICY/SEED": 0,
    MISSING_MANAGED: 0,
    UNEXPECTED_EXTRA: 0,
    HASH_MISMATCH: 0,
    UNKNOWN: 0
  };
  for (const d of [...clientDiffs, ...serverDiffs]) diffTotals[d.category]++;

  let payloadEqual = false;
  if (existingRelease && compareOnly) {
    const reproReport = path.join(REPORT_DIR, "DETERMINISM_REPORT.json");
    try {
      const repro = JSON.parse(await fs.readFile(reproReport, "utf8")) as { payloadEqual?: boolean };
      payloadEqual = repro.payloadEqual === true;
    } catch {
      payloadEqual = false;
    }
  } else {
    const reproParent = path.join(REPORT_DIR, "_repro-stage");
    await fs.rm(reproParent, { recursive: true, force: true });
    const repro = await stageRelease({
      catalog,
      packVersion: PACK_VERSION,
      sourceRoot: mergedSource,
      outDir: reproParent,
      force: true,
      cleanRoot: CLEAN,
      productOrigin: DEFAULT_ORIGIN,
      resourcePacksFile: RP_FILE,
      serverDatapacksFile: SDP_FILE,
      createdAt: CREATED_AT,
      releaseSequence: SEQUENCE,
      signer: new UnsignedDevSigner()
    });
    const canonFp = await fingerprintPayloadTree(releaseDir);
    const reproFp = await fingerprintPayloadTree(repro.releaseDir);
    payloadEqual = canonFp === reproFp;
    await fs.writeFile(path.join(REPORT_DIR, "DETERMINISM_PAYLOAD.fingerprint.txt"), canonFp);
    await fs.rm(reproParent, { recursive: true, force: true });
  }

  const priorClient = JSON.parse(
    await fs.readFile(path.join(PRIOR_RELEASE, "client-manifest.json"), "utf8")
  ) as ClientManifest;
  const priorServer = JSON.parse(
    await fs.readFile(path.join(PRIOR_RELEASE, "server-manifest.json"), "utf8")
  ) as ServerManifest;
  const delta = await buildReleaseDelta(priorClient, priorServer, client, server);
  await fs.writeFile(path.join(REPORT_DIR, "SYNC07_DELTA_0.1.3_to_0.1.4.json"), JSON.stringify(delta, null, 2));

  const cleanFpAfter = await fingerprintCleanMods(CLEAN);
  let priorReleaseFpAfter = "";
  try {
    priorReleaseFpAfter = await fingerprintPayloadTree(PRIOR_RELEASE);
  } catch {
    /* optional */
  }

  const releaseJsonSha = await sha256file(path.join(releaseDir, "release.json"));
  const clientManifestSha = await sha256file(path.join(releaseDir, "client-manifest.json"));
  const serverManifestSha = await sha256file(path.join(releaseDir, "server-manifest.json"));
  const checksumsSha = await sha256file(path.join(releaseDir, "checksums.json"));

  const allBlockers = [
    ...manifestIssues.map(x => `manifest: ${x}`),
    ...(verify.ok ? [] : [`verify: ${verify.errors.join("; ")}`]),
    ...unexplained.map(d => `${d.category} ${d.side} ${d.path}`),
    ...(payloadEqual ? [] : ["determinism mismatch"]),
    ...(cleanFpBefore === cleanFpAfter ? [] : ["FINAL CLEAN mutated"]),
    ...(priorReleaseFpBefore === priorReleaseFpAfter || !priorReleaseFpBefore ? [] : ["0.1.3 release mutated"])
  ];

  const stagedFiles = (await listFilesRecursive(path.join(releaseDir, "files"))).length;
  let stagedBytes = 0;
  for (const abs of await listFilesRecursive(path.join(releaseDir, "files"))) {
    stagedBytes += (await fs.stat(abs)).size;
  }

  const verdict =
    allBlockers.length === 0 ? "PACK_10_1SYNC_06_CANDIDATE_REPRO_PASS" : "SYNC06_BLOCKED";

  const report = {
    verdict,
    blockers: allBlockers,
    candidate: {
      packVersion: PACK_VERSION,
      sequence: SEQUENCE,
      releaseDir,
      signature: release.signature.status,
      createdAt: CREATED_AT
    },
    hashes: {
      releaseJson: releaseJsonSha,
      clientManifest: clientManifestSha,
      serverManifest: serverManifestSha,
      checksums: checksumsSha,
      casino: casinoM?.sha256 ?? null,
      ddSyncToml: dd?.sha256 ?? null,
      sweetcraftFrRp: fr?.sha256 ?? null
    },
    counts: {
      clientMods: client.mods.length,
      serverMods: server.mods.length,
      clientConfigs: client.configs.length,
      serverConfigs: server.configs.length,
      releaseHosted: plan.length,
      stagedFiles,
      stagedBytes,
      catalogMods: catalog.mods.length,
      unresolved: kinds.unresolved
    },
    projectionComparison: {
      clientDiffs: clientDiffs.length,
      serverDiffs: serverDiffs.length,
      totals: diffTotals,
      unexplained: unexplained.length
    },
    verify: { ok: verify.ok, signature: verify.signature, publishableStable: verify.publishableStable },
    determinism: { payloadEqual, createdAtFixed: CREATED_AT, varyingFields: ["release.json.signature", "release.json.createdAt if unset"] },
    deltaTotals: delta.totals,
    immutability: {
      finalCleanUnchanged: cleanFpBefore === cleanFpAfter,
      prior013Unchanged: priorReleaseFpBefore === priorReleaseFpAfter || !priorReleaseFpBefore
    },
    auditArtifacts: {
      report: path.join(REPORT_DIR, "SYNC06_REPORT.json"),
      delta: path.join(REPORT_DIR, "SYNC07_DELTA_0.1.3_to_0.1.4.json"),
      materializeClient: auditClient,
      materializeServer: auditServer,
      preflight: path.join(REPORT_DIR, "STAGE_PREFLIGHT.json")
    },
    NO_PUBLISH: true,
    NO_DEPLOY: true,
    NO_GIT_OPS: true
  };

  await fs.writeFile(path.join(REPORT_DIR, "SYNC06_REPORT.json"), JSON.stringify(report, null, 2));
  await fs.writeFile(
    path.join(REPORT_DIR, "PROJECTION_DIFFS.json"),
    JSON.stringify({ client: clientDiffs, server: serverDiffs }, null, 2)
  );

  console.log(JSON.stringify(report, null, 2));
  if (verdict !== "PACK_10_1SYNC_06_CANDIDATE_REPRO_PASS") process.exitCode = 2;
}

main().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
