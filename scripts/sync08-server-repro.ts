/**
 * PACK-10.1SYNC-08 — server datapack reproducibility + candidate regen/validate.
 * NO publish / deploy / commit / push.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashFile } from "../src/io.js";
import { readCatalog } from "../src/io.js";
import { DEFAULT_ORIGIN } from "../src/remotePaths.js";
import { UnsignedDevSigner } from "../src/releaseSigning.js";
import { stageRelease } from "../src/stage.js";
import { verifyRelease } from "../src/verifyRelease.js";
import { prepareServerDatapacksFromConfig } from "../src/serverDatapack.js";
import type { ManifestServerDatapack } from "../src/serverDatapackTypes.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLEAN =
  process.env.SWEETCRAFT_CLEAN_ROOT ??
  path.resolve(ROOT, "..", "..", "MODPACK FINAL CLEAN");
const REPORT_DIR = path.join(ROOT, "data", "candidates", "0.1.4-seq5-NONPUBLISHABLE");
const CANONICAL = path.join(ROOT, "data", "releases", "0.1.4");
const CREATED_AT = "2026-09-15T20:00:00.000Z";
const SDP_FILE = path.join(ROOT, "data", "serverDatapacks.json");
const RP_FILE = path.join(ROOT, "data", "resourcepacks.json");
const QUEST_TREE_FP = "9e145a9c7b33d2f1c797a96ad64e6a405d0b7e62cc138d39c7abf304bf8d0692";

/** Pre-SYNC-08 client-manifest sha256 (post-JEI, pre-datapack). */
const PRE_SYNC08_CLIENT_MANIFEST_SHA = process.env.SYNC08_PRE_CLIENT_MANIFEST_SHA ?? "";

type DiffCategory =
  | "EXPECTED_EXCLUDE"
  | "MISSING_MANAGED"
  | "UNEXPECTED_EXTRA"
  | "HASH_MISMATCH"
  | "UNKNOWN";

interface CompareDiff {
  path: string;
  category: DiffCategory;
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

async function buildServerProjection(
  cleanRoot: string,
  mergedSource: string,
  server: {
    mods: { file: string; sha256: string; size: number }[];
    configs: { path: string; sha256: string }[];
    serverDatapacks?: ManifestServerDatapack[];
  }
): Promise<Map<string, { sha256: string; size: number }>> {
  const out = new Map<string, { sha256: string; size: number }>();
  for (const m of server.mods) {
    const abs = path.join(cleanRoot, "server", "mods", m.file);
    try {
      const data = await fs.readFile(abs);
      out.set(`mods/${m.file}`, { sha256: sha256buf(data), size: data.length });
    } catch {
      out.set(`mods/${m.file}`, { sha256: m.sha256, size: m.size });
    }
  }
  for (const cf of server.configs) {
    const srcAbs = path.join(mergedSource, cf.path);
    const data = await fs.readFile(srcAbs);
    out.set(cf.path, { sha256: sha256buf(data), size: data.length });
  }
  for (const dp of server.serverDatapacks ?? []) {
    for (const f of dp.files) {
      const abs = path.join(cleanRoot, "server", ...f.path.split("/"));
      const data = await fs.readFile(abs);
      out.set(f.path, { sha256: sha256buf(data), size: data.length });
    }
  }
  return out;
}

async function buildServerCandidate(
  releaseDir: string,
  server: {
    mods: { file: string; sha256: string; size: number }[];
    configs: { path: string; sha256: string }[];
    serverDatapacks?: ManifestServerDatapack[];
  }
): Promise<Map<string, { sha256: string; size: number }>> {
  const out = new Map<string, { sha256: string; size: number }>();
  for (const m of server.mods) {
    const hosted = path.join(releaseDir, "files", "mods", m.file);
    try {
      const data = await fs.readFile(hosted);
      out.set(`mods/${m.file}`, { sha256: sha256buf(data), size: data.length });
    } catch {
      out.set(`mods/${m.file}`, { sha256: m.sha256, size: m.size });
    }
  }
  for (const cf of server.configs) {
    const staged = path.join(releaseDir, "files", cf.path);
    const data = await fs.readFile(staged);
    out.set(cf.path, { sha256: sha256buf(data), size: data.length });
  }
  for (const dp of server.serverDatapacks ?? []) {
    for (const f of dp.files) {
      const staged = path.join(releaseDir, "files", ...f.path.split("/"));
      const data = await fs.readFile(staged);
      out.set(f.path, { sha256: sha256buf(data), size: data.length });
    }
  }
  return out;
}

function compareMaps(
  expected: Map<string, { sha256: string; size: number }>,
  actual: Map<string, { sha256: string; size: number }>
): CompareDiff[] {
  const diffs: CompareDiff[] = [];
  const all = new Set([...expected.keys(), ...actual.keys()]);
  for (const p of [...all].sort()) {
    const e = expected.get(p);
    const a = actual.get(p);
    if (e && !a) diffs.push({ path: p, category: "MISSING_MANAGED", detail: "projection only" });
    else if (!e && a) diffs.push({ path: p, category: "UNEXPECTED_EXTRA", detail: "candidate only" });
    else if (e && a && e.sha256 !== a.sha256) {
      diffs.push({ path: p, category: "HASH_MISMATCH", detail: `${e.sha256} vs ${a.sha256}` });
    }
  }
  return diffs;
}

/** Server distributable leak scan — world/runtime only (client resourcepacks are expected). */
async function scanServerRuntimeLeaks(releaseDir: string): Promise<string[]> {
  const leaks: string[] = [];
  const files = (await listFilesRecursive(releaseDir))
    .map(a => path.relative(releaseDir, a).split(path.sep).join("/"))
    .filter(r => r.startsWith("files/world/"));
  for (const rel of files) {
    const after = rel.slice("files/".length);
    if (
      after.includes("world/region/") ||
      after.includes("world/playerdata/") ||
      after.includes("world/advancements/") ||
      after.includes("world/stats/") ||
      after.includes("luckperms/")
    ) {
      leaks.push(rel);
    }
    if (after.startsWith("world/") && !after.startsWith("world/datapacks/")) {
      leaks.push(rel);
    }
  }
  const lpLibs = (await listFilesRecursive(releaseDir))
    .map(a => path.relative(releaseDir, a).split(path.sep).join("/"))
    .filter(r => r.includes("luckperms/libs/"));
  leaks.push(...lpLibs);
  return [...new Set(leaks)].sort();
}

async function main() {
  await fs.mkdir(REPORT_DIR, { recursive: true });
  const blockers: string[] = [];

  let preClientManifestSha = PRE_SYNC08_CLIENT_MANIFEST_SHA;
  try {
    if (!preClientManifestSha) {
      preClientManifestSha = await hashFile(path.join(CANONICAL, "client-manifest.json"), "sha256");
    }
  } catch {
    preClientManifestSha = "";
  }

  const prepared = await prepareServerDatapacksFromConfig(SDP_FILE);
  const quest = prepared.find(p => p.id === "sweetcraft-quest-support");
  if (!quest) blockers.push("sweetcraft-quest-support not prepared");
  if (quest && quest.treeSha256 !== QUEST_TREE_FP) {
    blockers.push(`Quest Support treeSha256 mismatch: ${quest.treeSha256} != ${QUEST_TREE_FP}`);
  }
  if (quest && quest.fileCount !== 7) blockers.push(`Quest Support fileCount=${quest.fileCount} expected 7`);
  if (quest && quest.totalBytes !== 3242) blockers.push(`Quest Support bytes=${quest.totalBytes} expected 3242`);

  const mergedSource = path.join(REPORT_DIR, "_canonical-merged-config-source");
  const catalog = await readCatalog(path.join(ROOT, "data/catalog.configs.json"));

  const staged = await stageRelease({
    catalog,
    packVersion: "0.1.4",
    sourceRoot: mergedSource,
    outDir: path.join(ROOT, "data/releases"),
    force: true,
    cleanRoot: CLEAN,
    productOrigin: DEFAULT_ORIGIN,
    resourcePacksFile: RP_FILE,
    serverDatapacksFile: SDP_FILE,
    createdAt: CREATED_AT,
    releaseSequence: 5,
    signer: new UnsignedDevSigner()
  });
  const releaseDir = staged.releaseDir;

  await verifyRelease({ releaseDir, allowUnsignedDev: true });

  const client = JSON.parse(await fs.readFile(path.join(releaseDir, "client-manifest.json"), "utf8"));
  const server = JSON.parse(await fs.readFile(path.join(releaseDir, "server-manifest.json"), "utf8")) as {
    mods: { file: string; sha256: string; size: number }[];
    configs: { path: string; sha256: string }[];
    serverDatapacks?: ManifestServerDatapack[];
  };

  if (client.serverDatapacks !== undefined) blockers.push("client manifest must not have serverDatapacks");
  if (!server.serverDatapacks?.length) blockers.push("server manifest missing serverDatapacks");
  if (server.mods.length !== 94) blockers.push(`server mods=${server.mods.length} expected 94`);

  const clientManifestSha = await hashFile(path.join(releaseDir, "client-manifest.json"), "sha256");
  const clientUnchanged =
    !preClientManifestSha || clientManifestSha.toLowerCase() === preClientManifestSha.toLowerCase();
  if (preClientManifestSha && !clientUnchanged) {
    blockers.push(`client manifest changed: was ${preClientManifestSha} now ${clientManifestSha}`);
  }

  const proj = await buildServerProjection(CLEAN, mergedSource, server);
  const cand = await buildServerCandidate(releaseDir, server);
  const serverDiffs = compareMaps(proj, cand);
  const unexplained = serverDiffs.filter(d => d.category !== "EXPECTED_EXCLUDE");

  const leaks = await scanServerRuntimeLeaks(releaseDir);
  if (leaks.length) blockers.push(`server runtime leaks in release: ${leaks.join(", ")}`);

  const reproParent = path.join(REPORT_DIR, "_repro-stage-sync08");
  await fs.rm(reproParent, { recursive: true, force: true });
  const repro = await stageRelease({
    catalog,
    packVersion: "0.1.4",
    sourceRoot: mergedSource,
    outDir: reproParent,
    force: true,
    cleanRoot: CLEAN,
    productOrigin: DEFAULT_ORIGIN,
    resourcePacksFile: RP_FILE,
    serverDatapacksFile: SDP_FILE,
    createdAt: CREATED_AT,
    releaseSequence: 5,
    signer: new UnsignedDevSigner()
  });
  const canonFp = await fingerprintPayloadTree(releaseDir);
  const reproFp = await fingerprintPayloadTree(repro.releaseDir);
  const payloadEqual = canonFp === reproFp;
  await fs.rm(reproParent, { recursive: true, force: true });

  const releaseSha = await hashFile(path.join(releaseDir, "release.json"), "sha256");
  const checksumsSha = await hashFile(path.join(releaseDir, "checksums.json"), "sha256");

  const auditPath = path.join(REPORT_DIR, "SYNC08_SERVER_AUDIT.json");
  const auditBuf = await fs.readFile(auditPath);
  const auditSha = sha256buf(auditBuf);

  const report = {
    marker: blockers.length === 0 && unexplained.length === 0 && payloadEqual && clientUnchanged
      ? "PACK_10_1SYNC_08_SERVER_REPRO_PASS"
      : undefined,
    verdict:
      blockers.length === 0 && unexplained.length === 0 && payloadEqual && clientUnchanged
        ? "SYNC08_PASS"
        : blockers.length
          ? "SYNC08_BLOCKED"
          : "SYNC08_PARTIAL",
    blockers,
    questSupport: quest
      ? {
          fileCount: quest.fileCount,
          totalBytes: quest.totalBytes,
          treeSha256: quest.treeSha256
        }
      : null,
    serverRepro: {
      projectionPaths: proj.size,
      candidatePaths: cand.size,
      diffs: serverDiffs.length,
      unexplained: unexplained.length,
      diffSample: unexplained.slice(0, 20)
    },
    clientRegression: {
      preSync08ClientManifestSha: preClientManifestSha || null,
      postSync08ClientManifestSha: clientManifestSha,
      unchanged: clientUnchanged,
      sync07RerunRequired: !clientUnchanged
    },
    determinism: { payloadEqual, createdAtFixed: CREATED_AT },
    candidateHashes: {
      releaseJson: releaseSha,
      checksumsJson: checksumsSha,
      clientManifest: clientManifestSha,
      serverManifest: await hashFile(path.join(releaseDir, "server-manifest.json"), "sha256")
    },
    artifacts: {
      audit: { path: auditPath, sha256: auditSha },
      report: path.join(REPORT_DIR, "SYNC08_REPORT.json")
    },
    deploymentSemantics: {
      pmRole: "build staged server payload only; no DatHost deploy in repo",
      overwriteOnDeploy: ["files/config/**", "provider mod jars", "files/world/datapacks/**"],
      preserveOnDeploy: ["world/region/**", "world/playerdata/**", "world/advancements/**", "world/stats/**", "logs/**"],
      datapackApply: "force replace world/datapacks/SweetCraft_Quest_Support/**",
      rollback: "prior release tree or serverDatapacks[].treeSha256 snapshot; world backup separate"
    },
    gitOps: { commit: false, push: false, tag: false, publish: false, deploy: false }
  };

  await fs.writeFile(path.join(REPORT_DIR, "SYNC08_REPORT.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (report.verdict !== "SYNC08_PASS") process.exitCode = 2;
}

main().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
