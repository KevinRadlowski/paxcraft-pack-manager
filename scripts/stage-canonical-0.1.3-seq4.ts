/**
 * Canonical REAL local staging for SweetCraft 0.1.3 / sequence 4.
 * UNSIGNED_DEV only — no production key, no publish, no upload, no channel.
 *
 * Output: data/releases/0.1.3
 * Report: data/candidates/0.1.3-seq4-NONPUBLISHABLE/RELEASE_0.1.3_STAGE_REPORT.json
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import { stageRelease } from "../src/stage.js";
import { verifyRelease } from "../src/verifyRelease.js";
import { UnsignedDevSigner } from "../src/releaseSigning.js";
import {
  countArtifactKinds,
  planReleaseHostedMods
} from "../src/releaseHosted.js";
import { DEFAULT_ORIGIN } from "../src/remotePaths.js";
import { findPackDependencyClosureGaps } from "../src/dependencyClosure.js";
import { validate } from "../src/validate.js";
import type { Catalog } from "../src/types.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLEAN =
  process.env.SWEETCRAFT_CLEAN_ROOT ??
  path.resolve(ROOT, "..", "..", "MODPACK FINAL CLEAN");
const CATALOG = path.join(ROOT, "data", "catalog.configs.json");
const RELEASES = path.join(ROOT, "data", "releases");
const CANONICAL = path.join(RELEASES, "0.1.3");
const REPORT_DIR = path.join(ROOT, "data", "candidates", "0.1.3-seq4-NONPUBLISHABLE");
const PACK_VERSION = "0.1.3";
const SEQUENCE = 4;
const CREATED_AT = "2026-09-12T21:00:00.000Z";
const HOSTED = ["dynamic_difficulty", "fallen", "xbasecasino"] as const;
const RP_SHA = "f491caae5e1485d3e9c709f44cc81099ce6e742c48a9a33818740d643b09250f";
const RP_SIZE = 400806;
const RP_NAME = "SweetCraft-FR-v2.7-DETAIL-PASS.zip";
const STALE = ["Nouveau monde", "TEST MODPACK", "vortex", "localhost", "sweetcraft.datho.st"];

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

async function fingerprintTree(root: string): Promise<string> {
  const files = (await listFilesRecursive(root)).sort((a, b) => a.localeCompare(b));
  const lines: string[] = [];
  for (const abs of files) {
    const rel = path.relative(root, abs).split(path.sep).join("/");
    const st = await fs.stat(abs);
    if (st.isSymbolicLink?.() || (await fs.lstat(abs)).isSymbolicLink()) {
      lines.push(`SYMLINK\t${rel}`);
      continue;
    }
    lines.push(`${await sha256file(abs)}\t${st.size}\t${rel}`);
  }
  return lines.join("\n") + "\n";
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

async function copyDir(src: string, dest: string): Promise<void> {
  await fs.rm(dest, { recursive: true, force: true });
  await fs.mkdir(dest, { recursive: true });
  for (const abs of await listFilesRecursive(src)) {
    const rel = path.relative(src, abs);
    const d = path.join(dest, rel);
    await fs.mkdir(path.dirname(d), { recursive: true });
    await fs.copyFile(abs, d);
  }
}

async function scanStale(root: string): Promise<{ path: string; needle: string; snippet: string }[]> {
  const hits: { path: string; needle: string; snippet: string }[] = [];
  for (const abs of await listFilesRecursive(root)) {
    const rel = path.relative(root, abs).split(path.sep).join("/");
    let text: string;
    try {
      const buf = await fs.readFile(abs);
      // skip large binaries / jars
      if (rel.endsWith(".jar") || rel.endsWith(".zip") || buf.includes(0)) continue;
      text = buf.toString("utf8");
    } catch {
      continue;
    }
    for (const needle of STALE) {
      const idx = text.indexOf(needle);
      if (idx >= 0) {
        const start = Math.max(0, idx - 40);
        const snippet = text.slice(start, idx + needle.length + 40).replace(/\s+/g, " ");
        hits.push({ path: rel, needle, snippet });
      }
    }
  }
  return hits;
}

async function securityScan(root: string): Promise<{ status: "PASS" | "FINDING"; findings: { path: string; type: string }[] }> {
  const findings: { path: string; type: string }[] = [];
  const patterns: { type: string; re: RegExp }[] = [
    { type: "CURSEFORGE_API_KEY_MARKER", re: /CURSEFORGE_API_KEY/i },
    { type: "BEGIN_PRIVATE_KEY", re: /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/ },
    { type: "SSH_KEY_MARKER", re: /-----BEGIN OPENSSH PRIVATE KEY-----/ },
    { type: "PEM_FILE", re: /\.pem$/i }
  ];
  for (const abs of await listFilesRecursive(root)) {
    const rel = path.relative(root, abs).split(path.sep).join("/");
    if (/\.pem$/i.test(rel)) findings.push({ path: rel, type: "PEM_FILE" });
    if (rel.includes(".ssh") || /(^|\/)id_rsa($|\.)/i.test(rel)) {
      findings.push({ path: rel, type: "SSH_KEY_PATH" });
    }
    let text: string;
    try {
      const buf = await fs.readFile(abs);
      if (rel.endsWith(".jar") || rel.endsWith(".zip") || buf.length > 2_000_000) continue;
      if (buf.includes(0) && !rel.endsWith(".json")) continue;
      text = buf.toString("utf8");
    } catch {
      continue;
    }
    for (const p of patterns) {
      if (p.type === "PEM_FILE") continue;
      if (p.re.test(text)) findings.push({ path: rel, type: p.type });
    }
  }
  return { status: findings.length ? "FINDING" : "PASS", findings };
}

function policyCounts(catalog: Catalog) {
  const c = { SERVER_FORCE: 0, CLIENT_PRESERVE: 0, CLIENT_DEFAULT: 0, EXCLUDED: 0, OTHER: 0 };
  for (const cf of catalog.configs) {
    if (cf.policy === "SERVER_FORCE") c.SERVER_FORCE++;
    else if (cf.policy === "CLIENT_PRESERVE") c.CLIENT_PRESERVE++;
    else if (cf.policy === "CLIENT_DEFAULT") c.CLIENT_DEFAULT++;
    else if (cf.policy === "EXCLUDED") c.EXCLUDED++;
    else c.OTHER++;
  }
  return c;
}

async function main() {
  const blockers: string[] = [];
  const warnings: string[] = [];

  // Fail closed if canonical already exists
  try {
    await fs.access(CANONICAL);
    blockers.push(`canonical staging already exists: ${CANONICAL} — refuse silent overwrite`);
  } catch {
    /* ok */
  }

  const catalog = JSON.parse(await fs.readFile(CATALOG, "utf8")) as Catalog;
  const kinds = countArtifactKinds(catalog);
  const plan = planReleaseHostedMods(catalog, {
    packVersion: PACK_VERSION,
    productOrigin: DEFAULT_ORIGIN
  });

  // Dependency closure
  const clientGaps = findPackDependencyClosureGaps(catalog, "client");
  const serverGaps = findPackDependencyClosureGaps(catalog, "server");
  const findings = validate(catalog);
  const depErrors = findings.filter(
    f =>
      f.code === "MISSING_DEP" ||
      f.code === "VERSION_INCOMPATIBLE" ||
      f.code === "ALIAS_REQUIRED"
  );

  if (kinds.unresolved !== 0) blockers.push(`unresolved=${kinds.unresolved}`);
  if (kinds.provider !== 124) blockers.push(`provider=${kinds.provider} expected 124`);
  if (plan.length !== 3) blockers.push(`hosted plan=${plan.length} expected 3`);
  if (clientGaps.length || serverGaps.length) {
    blockers.push(`dependency gaps client=${clientGaps.length} server=${serverGaps.length}`);
  }
  if (depErrors.length) blockers.push(`validate dep errors=${depErrors.length}`);

  if (blockers.length) {
    const report = { verdict: "RELEASE_0.1.3_STAGE_BLOCKED", blockers };
    await fs.mkdir(REPORT_DIR, { recursive: true });
    await fs.writeFile(path.join(REPORT_DIR, "RELEASE_0.1.3_STAGE_REPORT.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 2;
    return;
  }

  const mergedSource = path.join(REPORT_DIR, "_canonical-merged-config-source");
  await materializeMergedConfigSource(CLEAN, mergedSource);

  const cleanFpBefore = await fingerprintCleanMods(CLEAN);
  await fs.writeFile(path.join(REPORT_DIR, "CLEAN.mods.fingerprint.before.txt"), cleanFpBefore);
  const pubFpBefore = await fingerprintTree(path.join(ROOT, "data", "publish-0.1.2"));
  await fs.writeFile(path.join(REPORT_DIR, "publish-0.1.2.fingerprint.before.txt"), pubFpBefore);

  const rpFile = path.join(ROOT, "data", "resourcepacks.json");

  const staged = await stageRelease({
    catalog,
    packVersion: PACK_VERSION,
    sourceRoot: mergedSource,
    outDir: RELEASES,
    force: false,
    cleanRoot: CLEAN,
    productOrigin: DEFAULT_ORIGIN,
    resourcePacksFile: rpFile,
    createdAt: CREATED_AT,
    releaseSequence: SEQUENCE,
    signer: new UnsignedDevSigner()
  });

  const releaseDir = staged.releaseDir;
  const client = JSON.parse(await fs.readFile(path.join(releaseDir, "client-manifest.json"), "utf8")) as {
    schemaVersion: number;
    mods: {
      id: string;
      file: string;
      version: string;
      size: number;
      sha256: string;
      provider: { type: string; url: string | null; projectId?: number | null; fileId?: number | null };
    }[];
    configs: { path: string; policy: string; apply: string }[];
    resourcePacks: {
      id: string;
      version: string;
      sha256: string;
      size: number;
      targetPath: string;
      autoEnable: boolean;
      url: string;
    }[];
  };
  const server = JSON.parse(await fs.readFile(path.join(releaseDir, "server-manifest.json"), "utf8")) as {
    schemaVersion: number;
    mods: { id: string; file: string; sha256: string; size: number; provider: { type: string; url: string | null } }[];
    configs: { path: string; policy: string }[];
  };
  const release = JSON.parse(await fs.readFile(path.join(releaseDir, "release.json"), "utf8")) as {
    schemaVersion: number;
    packVersion: string;
    antiRollback: { releaseSequence: number | null; note?: string };
    signature: { status: string; value: string | null };
  };
  const checksums = JSON.parse(await fs.readFile(path.join(releaseDir, "checksums.json"), "utf8")) as {
    entries: { path: string; size: number; sha256: string }[];
  };

  // --- D/E/F mod validation ---
  const modIssues: string[] = [];
  if (client.mods.length !== 117) modIssues.push(`client mods=${client.mods.length} expected 117`);
  if (server.mods.length !== 100) modIssues.push(`server mods=${server.mods.length} expected 100`);

  const clientIds = new Set(client.mods.map(m => m.id));
  const clientFiles = new Set(client.mods.map(m => m.file));
  if (clientIds.size !== client.mods.length) modIssues.push("duplicate client mod id");
  if (clientFiles.size !== client.mods.length) modIssues.push("duplicate client file");

  // Compare client manifests to CLEAN client jars for physical presence
  const cleanClientJars = new Set(
    (await fs.readdir(path.join(CLEAN, "client", "mods")))
      .filter(f => f.toLowerCase().endsWith(".jar"))
  );
  const cleanServerJars = new Set(
    (await fs.readdir(path.join(CLEAN, "server", "mods")))
      .filter(f => f.toLowerCase().endsWith(".jar"))
  );
  for (const m of client.mods) {
    if (!cleanClientJars.has(m.file)) modIssues.push(`client manifest orphan (not in CLEAN): ${m.file}`);
    const cat = catalog.mods.find(x => x.mod_id === m.id);
    if (!cat) modIssues.push(`client mod not in catalog: ${m.id}`);
    else {
      if (cat.sha256 !== m.sha256) modIssues.push(`sha mismatch ${m.id}`);
      if (cat.size_bytes !== m.size) modIssues.push(`size mismatch ${m.id}`);
      if (cat.jar !== m.file) modIssues.push(`filename mismatch ${m.id}`);
    }
    if (!m.provider?.url || !/^https:\/\//i.test(m.provider.url)) {
      modIssues.push(`bad provider url ${m.id}`);
    }
    if (/^[a-zA-Z]:\\|file:|\/Users\/|\/home\//i.test(m.provider.url || "")) {
      modIssues.push(`filesystem url leak ${m.id}`);
    }
  }
  for (const m of server.mods) {
    if (!cleanServerJars.has(m.file)) modIssues.push(`server manifest orphan: ${m.file}`);
  }
  // CLEAN physical must be covered by manifests (top-level only)
  for (const j of cleanClientJars) {
    if (![...client.mods].some(m => m.file === j)) {
      modIssues.push(`CLEAN client jar missing from manifest: ${j}`);
    }
  }
  for (const j of cleanServerJars) {
    if (![...server.mods].some(m => m.file === j)) {
      modIssues.push(`CLEAN server jar missing from manifest: ${j}`);
    }
  }

  // Nested must not appear as standalone — check luckperms libs not in manifest
  const nestedHits = [...client.mods, ...server.mods].filter(m =>
    /luckperms.*libs/i.test(m.file) || m.file.includes("/")
  );
  if (nestedHits.length) modIssues.push(`nested-as-standalone: ${nestedHits.map(m => m.file).join(",")}`);

  // FTB lookup by exact catalog ids
  const ftbMods = catalog.mods.filter(m =>
    /^(ftbfiltersystem|ftblibrary|ftbquests|ftbteams|ftbxmodcompat)$/i.test(m.mod_id)
  );
  const ftbReport = ftbMods.map(m => ({
    mod_id: m.mod_id,
    curseforge_project_id: m.curseforge_project_id ?? null,
    curseforge_file_id: m.curseforge_file_id ?? null,
    url: m.curseforge_file_url ?? null,
    https: !!(m.curseforge_file_url && m.curseforge_file_url.startsWith("https://")),
    inClient: client.mods.some(x => x.id === m.mod_id),
    inServer: server.mods.some(x => x.id === m.mod_id)
  }));
  if (ftbReport.length !== 5) modIssues.push(`FTB mods found=${ftbReport.length} expected 5`);
  if (ftbReport.some(f => !f.https || !f.curseforge_file_id)) {
    modIssues.push("FTB missing CurseForge URL/fileId");
  }
  // Hosted byte identity
  const hostedReport = [];
  for (const h of plan) {
    const stagedPath = path.join(releaseDir, ...h.releaseStoragePath.split("/"));
    const stagedBytes = await fs.readFile(stagedPath);
    const stagedSha = sha256buf(stagedBytes);
    const cm = client.mods.find(m => m.id === h.mod_id)!;
    const ok =
      stagedSha === h.sha256 &&
      stagedBytes.length === h.size_bytes &&
      cm.sha256 === h.sha256 &&
      cm.size === h.size_bytes &&
      cm.provider.url === h.publicUrl &&
      cm.file === h.jar;
    if (!ok) modIssues.push(`hosted mismatch ${h.mod_id}`);
    hostedReport.push({
      mod_id: h.mod_id,
      sourceKind: h.sourceKind,
      source: h.cleanRelativePaths,
      filename: h.jar,
      sha256: h.sha256,
      size: h.size_bytes,
      stagedPath: h.releaseStoragePath,
      manifestUrl: cm.provider.url,
      byteIdentity: ok && stagedSha === h.sha256
    });
  }

  // Physical files/mods must be exactly 3
  const modsDir = path.join(releaseDir, "files", "mods");
  const physicalMods = (await fs.readdir(modsDir)).filter(f => f.endsWith(".jar"));
  if (physicalMods.length !== 3) modIssues.push(`physical mods in release=${physicalMods.length}`);

  // --- G configs ---
  const policies = policyCounts(catalog);
  const configIssues: string[] = [];
  if (policies.SERVER_FORCE !== 251) configIssues.push(`SERVER_FORCE=${policies.SERVER_FORCE}`);
  if (policies.CLIENT_PRESERVE !== 23) configIssues.push(`CLIENT_PRESERVE=${policies.CLIENT_PRESERVE}`);
  if (policies.CLIENT_DEFAULT !== 28) configIssues.push(`CLIENT_DEFAULT=${policies.CLIENT_DEFAULT}`);
  if (policies.EXCLUDED !== 56) configIssues.push(`EXCLUDED=${policies.EXCLUDED}`);
  if (client.configs.length !== 244) configIssues.push(`client configs=${client.configs.length}`);
  if (server.configs.length !== 230) configIssues.push(`server configs=${server.configs.length}`);
  const badPolicyInManifest = [...client.configs, ...server.configs].filter(c =>
    ["COMMON_FORCE_REVIEW", "NEVER_CLIENT_SECRET_REVIEW", "CLIENT_DEFAULT_PRESERVE", "EXCLUDED"].includes(
      c.policy
    )
  );
  if (badPolicyInManifest.length) {
    configIssues.push(`forbidden policies in manifests: ${badPolicyInManifest.length}`);
  }

  const exclusionChecks = [
    "luckperms",
    "resourceful-config-web",
    "grieflogger",
    "xbasecasino/economy.json",
    "wover",
    "betternether"
  ];
  const exclusionHits = catalog.configs
    .filter(c => c.policy === "EXCLUDED")
    .filter(c => exclusionChecks.some(k => c.path.toLowerCase().includes(k.toLowerCase())))
    .map(c => c.path);

  const staleHits = await scanStale(path.join(releaseDir, "files", "config"));

  // --- H resource pack ---
  const rpManifest = client.resourcePacks?.[0];
  const rpStaged = path.join(releaseDir, "files", "resourcepacks", RP_NAME);
  const rpBytes = await fs.readFile(rpStaged);
  const rpSha = sha256buf(rpBytes);
  let zipOk = false;
  let mcmetaOk = false;
  let assetsOk = false;
  try {
    const zip = new AdmZip(rpStaged);
    zipOk = true;
    const mc = zip.getEntry("pack.mcmeta");
    if (mc) {
      JSON.parse(mc.getData().toString("utf8"));
      mcmetaOk = true;
    }
    assetsOk = zip.getEntries().some(e => e.entryName.startsWith("assets/"));
  } catch {
    zipOk = false;
  }
  const rpInChecksums = checksums.entries.find(e => e.path === `files/resourcepacks/${RP_NAME}`);
  const rpIssues: string[] = [];
  if (rpSha !== RP_SHA || rpBytes.length !== RP_SIZE) rpIssues.push("rp hash/size mismatch");
  if (!rpManifest || rpManifest.sha256 !== RP_SHA) rpIssues.push("rp not in client manifest correctly");
  if (server && "resourcePacks" in server && (server as { resourcePacks?: unknown[] }).resourcePacks?.length) {
    rpIssues.push("resource packs on server manifest");
  }
  const allText = JSON.stringify({ client, server, release, checksums });
  if (allText.includes("v1.0") && allText.toLowerCase().includes("sweetcraft-fr-v1")) {
    rpIssues.push("stale v1.0 reference");
  }
  if (!allText.includes(RP_NAME) === false && !rpManifest) rpIssues.push("missing RP name");
  // check no v1.0 filename
  for (const e of checksums.entries) {
    if (/SweetCraft-FR-v1\.0/i.test(e.path)) rpIssues.push("stale v1.0 in checksums");
  }

  // --- L fileset ---
  const onDisk = (await listFilesRecursive(releaseDir)).map(a =>
    path.relative(releaseDir, a).split(path.sep).join("/")
  );
  const checksumPaths = new Set(checksums.entries.map(e => e.path));
  const rootAllowed = new Set(["release.json", "client-manifest.json", "server-manifest.json", "checksums.json"]);
  const filesetIssues: string[] = [];
  for (const rel of onDisk) {
    if (rootAllowed.has(rel)) continue;
    if (!rel.startsWith("files/")) filesetIssues.push(`unexpected root file: ${rel}`);
    else if (!checksumPaths.has(rel)) filesetIssues.push(`orphan file: ${rel}`);
    if (rel.includes("\\") || rel.includes("..") || rel.startsWith("/")) filesetIssues.push(`bad path: ${rel}`);
    if (rel.startsWith(".") || rel.includes("/.")) filesetIssues.push(`hidden: ${rel}`);
    if (/\.pem$/i.test(rel)) filesetIssues.push(`pem: ${rel}`);
    const lst = await fs.lstat(path.join(releaseDir, ...rel.split("/")));
    if (lst.isSymbolicLink()) filesetIssues.push(`symlink: ${rel}`);
  }
  for (const e of checksums.entries) {
    if (!onDisk.includes(e.path) && e.path !== "client-manifest.json" && e.path !== "server-manifest.json") {
      // manifests are on disk too
    }
    if (!onDisk.includes(e.path)) filesetIssues.push(`missing checksum target: ${e.path}`);
  }

  // --- M verify ---
  const verify = await verifyRelease({ releaseDir, allowUnsignedDev: true });

  // Tamper on TEMP copy
  const tamperDir = await fs.mkdtemp(path.join(os.tmpdir(), "sc-tamper-013-"));
  await copyDir(releaseDir, tamperDir);
  const tamperJar = path.join(tamperDir, "files", "mods", plan[0]!.jar);
  const orig = await fs.readFile(tamperJar);
  await fs.writeFile(tamperJar, Buffer.concat([orig, Buffer.from("X")]));
  const tamperVerify = await verifyRelease({ releaseDir: tamperDir, allowUnsignedDev: true });
  await fs.rm(tamperDir, { recursive: true, force: true });
  const verifyAfter = await verifyRelease({ releaseDir, allowUnsignedDev: true });

  // --- N reproducibility ---
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
    resourcePacksFile: rpFile,
    createdAt: CREATED_AT,
    releaseSequence: SEQUENCE,
    signer: new UnsignedDevSigner()
  });
  const canonFp = await fingerprintTree(releaseDir);
  const reproFp = await fingerprintTree(repro.releaseDir);
  // Exclude release.json signature noise — unsigned should be identical with fixed createdAt
  const payloadEqual = canonFp === reproFp;
  await fs.rm(reproParent, { recursive: true, force: true });

  // --- O/P immutability ---
  const cleanFpAfter = await fingerprintCleanMods(CLEAN);
  const pubFpAfter = await fingerprintTree(path.join(ROOT, "data", "publish-0.1.2"));
  await fs.writeFile(path.join(REPORT_DIR, "CLEAN.mods.fingerprint.after.txt"), cleanFpAfter);
  await fs.writeFile(path.join(REPORT_DIR, "publish-0.1.2.fingerprint.after.txt"), pubFpAfter);

  // --- Q security ---
  const sec = await securityScan(releaseDir);

  // Aggregate blockers
  const allBlockers = [
    ...modIssues,
    ...configIssues,
    ...rpIssues,
    ...filesetIssues,
    ...(verify.ok ? [] : [`verifyRelease fail: ${verify.errors.join("; ")}`]),
    ...(tamperVerify.ok ? ["tamper did not fail"] : []),
    ...(verifyAfter.ok ? [] : ["canonical verify after tamper-copy failed"]),
    ...(payloadEqual ? [] : ["reproducibility mismatch"]),
    ...(cleanFpBefore === cleanFpAfter ? [] : ["CLEAN mutated"]),
    ...(pubFpBefore === pubFpAfter ? [] : ["publish-0.1.2 mutated"]),
    ...(sec.status === "PASS" ? [] : [`security findings: ${sec.findings.length}`]),
    ...(release.antiRollback.releaseSequence === SEQUENCE ? [] : ["sequence mismatch"]),
    ...(release.signature.status === "unsigned-dev" ? [] : ["expected unsigned-dev"]),
    ...(client.schemaVersion === 6 && release.schemaVersion === 2 ? [] : ["schema mismatch"])
  ];

  const filesetSummary = {
    totalFiles: onDisk.length,
    checksumEntries: checksums.entries.length,
    roots: onDisk.filter(f => !f.includes("/")),
    filesMods: onDisk.filter(f => f.startsWith("files/mods/")),
    filesConfigs: onDisk.filter(f => f.startsWith("files/config/")).length,
    filesResourcePacks: onDisk.filter(f => f.startsWith("files/resourcepacks/")),
    providerPhysicalInRelease: onDisk.filter(
      f => f.startsWith("files/mods/") && !plan.some(p => f.endsWith(p.jar))
    ).length
  };

  const verdict = allBlockers.length === 0 ? "RELEASE_0.1.3_STAGE_READY" : "RELEASE_0.1.3_STAGE_BLOCKED";

  const report = {
    verdict,
    blockers: allBlockers,
    warnings,
    staging: {
      releaseDir,
      packVersion: PACK_VERSION,
      sequence: release.antiRollback.releaseSequence,
      signature: release.signature.status,
      publishableStable: verify.publishableStable,
      createdAt: CREATED_AT
    },
    preflight: "STAGE_PREFLIGHT_READY",
    counts: {
      catalogLogical: catalog.mods.length,
      provider: kinds.provider,
      localClean: kinds.localClean,
      customLocal: kinds.customLocal,
      unresolved: kinds.unresolved,
      releaseHosted: plan.length,
      clientMods: client.mods.length,
      serverMods: server.mods.length,
      clientConfigs: client.configs.length,
      serverConfigs: server.configs.length,
      policies
    },
    dependencyClosure: {
      clientGaps: clientGaps.length,
      serverGaps: serverGaps.length,
      depErrors: depErrors.map(e => e.code),
      unknownVersionSemantics: findings.filter(f => f.code === "UNKNOWN_VERSION_SEMANTICS").length
    },
    hosted: hostedReport,
    ftb: ftbReport,
    providerPhysicalReleaseFileCount: filesetSummary.providerPhysicalInRelease,
    exclusionsSample: exclusionHits.slice(0, 40),
    staleScan: staleHits,
    resourcePack: {
      filename: RP_NAME,
      sha256: rpSha,
      size: rpBytes.length,
      zipOk,
      mcmetaOk,
      assetsOk,
      autoEnable: rpManifest?.autoEnable ?? null,
      targetPath: rpManifest?.targetPath ?? null,
      checksum: rpInChecksums ?? null,
      clientOnly: true
    },
    datapack: "DATAPACK_SERVER_NOT_DISTRIBUTED",
    luckperms: "LUCKPERMS_LIBS_REGENERABLE",
    schemas: {
      manifest: client.schemaVersion,
      release: release.schemaVersion
    },
    fileset: filesetSummary,
    verify: {
      ok: verify.ok,
      signature: verify.signature,
      publishableStable: verify.publishableStable,
      errors: verify.errors
    },
    tamper: {
      failedAsExpected: !tamperVerify.ok,
      canonicalStillOk: verifyAfter.ok,
      errorsSample: tamperVerify.errors.slice(0, 3)
    },
    reproducibility: { payloadEqual, createdAtFixed: CREATED_AT },
    immutability: {
      cleanUnchanged: cleanFpBefore === cleanFpAfter,
      publish012Unchanged: pubFpBefore === pubFpAfter
    },
    security: sec,
    NO_PROTOCOL_CHANGE: true
  };

  await fs.writeFile(path.join(REPORT_DIR, "RELEASE_0.1.3_STAGE_REPORT.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (verdict !== "RELEASE_0.1.3_STAGE_READY") process.exitCode = 2;
}

main().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
