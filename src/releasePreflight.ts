/**
 * STEP-4.6-M7 — READ-ONLY Pack Manager release preflight.
 * Invokes Content sync-to-mfc / pack-rp CHECK contracts; never applies.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import AdmZip from "adm-zip";
import { readCatalog } from "./io.js";
import type { Catalog } from "./types.js";
import {
  APPROVED_FR_RP_ZIP_SHA256,
  CASINO_MOD_ID,
  PREFLIGHT_EXIT,
  PREFLIGHT_SCHEMA_VERSION,
  type CasinoGateEvidence,
  type CasinoProvenanceProof,
  type GateResult,
  type PreflightStatus,
  type ReleaseBomCandidate,
  type ReleasePreflightOptions,
  type ReleasePreflightReport
} from "./releasePreflightTypes.js";

const ALLOWED_POLICIES = new Set<string>([
  "SERVER_FORCE",
  "CLIENT_DEFAULT",
  "CLIENT_PRESERVE",
  "EXCLUDED"
]);

const BLOCKED_STAGED_POLICIES = new Set(["EXCLUDED", "NEVER_CLIENT_SECRET_REVIEW", "COMMON_FORCE_REVIEW"]);

function worstStatus(statuses: PreflightStatus[]): PreflightStatus {
  if (statuses.includes("ERROR")) return "ERROR";
  if (statuses.includes("BLOCKED")) return "BLOCKED";
  if (statuses.includes("EXTERNAL_VERIFY")) return "EXTERNAL_VERIFY";
  return "PASS";
}

function sha256Hex(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

async function sha256File(abs: string): Promise<string> {
  return sha256Hex(await fs.readFile(abs));
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function gitIdentity(repoRoot: string | null | undefined): Promise<string> {
  if (!repoRoot || !(await pathExists(repoRoot))) return "UNKNOWN";
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const { stdout: head } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      windowsHide: true
    });
    const { stdout: dirty } = await execFileAsync("git", ["status", "--porcelain=v1"], {
      cwd: repoRoot,
      windowsHide: true
    });
    const h = head.trim();
    const dirtyFlag = dirty.trim().length > 0 ? "+WIP" : "";
    return `${h}${dirtyFlag}`;
  } catch {
    return "UNKNOWN";
  }
}

async function treeHashDir(root: string): Promise<string> {
  const files: string[] = [];
  async function walk(d: string) {
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      const abs = path.join(d, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (e.isFile()) files.push(abs);
    }
  }
  await walk(root);
  files.sort((a, b) => a.replace(/\\/g, "/").localeCompare(b.replace(/\\/g, "/")));
  const h = createHash("sha256");
  for (const f of files) {
    const rel = path.relative(root, f).split(path.sep).join("/");
    h.update(rel);
    h.update("\0");
    h.update(await fs.readFile(f));
    h.update("\0");
  }
  return h.digest("hex");
}

async function loadSyncLib(contentRoot: string) {
  const lib = path.join(contentRoot, "tools", "sync-to-mfc", "lib.mjs");
  if (!(await pathExists(lib))) {
    throw Object.assign(new Error(`sync-to-mfc lib missing: ${lib}`), { code: "MISSING_TOOL" });
  }
  return import(pathToFileURL(lib).href);
}

async function loadPackRpLib(contentRoot: string) {
  const lib = path.join(contentRoot, "tools", "pack-rp", "lib.mjs");
  if (!(await pathExists(lib))) {
    throw Object.assign(new Error(`pack-rp lib missing: ${lib}`), { code: "MISSING_TOOL" });
  }
  return import(pathToFileURL(lib).href);
}

export async function gateQuests(
  contentRoot: string,
  mfcRoot: string
): Promise<GateResult> {
  try {
    const sync = await loadSyncLib(contentRoot);
    sync.validateRoots(contentRoot, mfcRoot);
    const plan = sync.planQuests(contentRoot, mfcRoot);
    const ops = (plan.ops ?? plan.actions ?? []) as Array<{ op: string }>;
    const pending = ops.filter(a => a.op === "COPY" || a.op === "UPDATE" || a.op === "DELETE");
    const managed = ops.filter(a => a.op !== "PRESERVE");
    if (!plan.parity || pending.length > 0) {
      return {
        id: "QUEST_PARITY",
        status: "BLOCKED",
        detail: `quest drift pending=${pending.length} managed=${managed.length}`,
        evidence: {
          parity: plan.parity,
          counts: plan.counts,
          managedExpected: managed.length,
          pendingOps: pending.map(p => p.op)
        }
      };
    }
    return {
      id: "QUEST_PARITY",
      status: "PASS",
      detail: `quests parity managed=${managed.length} KEEP=${plan.counts.KEEP}`,
      evidence: { parity: true, counts: plan.counts, managedExpected: managed.length }
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = (e as { code?: string }).code;
    return {
      id: "QUEST_PARITY",
      status: code === "PATH_ESCAPE" || code === "MISSING_TOOL" ? "ERROR" : "ERROR",
      detail: msg,
      evidence: { code }
    };
  }
}

export async function gateDatapack(
  contentRoot: string,
  mfcRoot: string
): Promise<GateResult> {
  try {
    const sync = await loadSyncLib(contentRoot);
    sync.validateRoots(contentRoot, mfcRoot);
    const plan = sync.planDatapack(contentRoot, mfcRoot);
    const ops = (plan.ops ?? plan.actions ?? []) as Array<{ op: string }>;
    const pending = ops.filter(a => a.op === "COPY" || a.op === "UPDATE" || a.op === "DELETE");
    // World boundary: dest must remain under server/world/datapacks/SweetCraft_Quest_Support
    const destRel = String(sync.DP_DEST_REL).split(path.sep).join("/");
    if (!destRel.includes("world/datapacks") && !destRel.includes("world\\datapacks")) {
      return {
        id: "DATAPACK_PARITY",
        status: "ERROR",
        detail: `unsafe datapack dest boundary: ${destRel}`
      };
    }
    if (!plan.parity || pending.length > 0) {
      return {
        id: "DATAPACK_PARITY",
        status: "BLOCKED",
        detail: `datapack drift pending=${pending.length}`,
        evidence: { parity: plan.parity, counts: plan.counts }
      };
    }
    return {
      id: "DATAPACK_PARITY",
      status: "PASS",
      detail: `datapack parity KEEP=${plan.counts.KEEP}`,
      evidence: { parity: true, counts: plan.counts, destRel }
    };
  } catch (e) {
    return {
      id: "DATAPACK_PARITY",
      status: "ERROR",
      detail: e instanceof Error ? e.message : String(e)
    };
  }
}

export async function gateFrRp(
  contentRoot: string,
  mfcRoot: string,
  approvedSha: string = APPROVED_FR_RP_ZIP_SHA256
): Promise<GateResult> {
  try {
    const pack = await loadPackRpLib(contentRoot);
    const sourceRoot = pack.resolveStrict(contentRoot, ...String(pack.RP_SOURCE_REL).split(path.sep));
    const mfcZip = pack.resolveStrict(mfcRoot, ...String(pack.MFC_FR_ZIP_REL).split(path.sep));
    if (!(await pathExists(sourceRoot))) {
      return { id: "FR_RP", status: "ERROR", detail: `RP source missing: ${sourceRoot}` };
    }
    if (!(await pathExists(mfcZip))) {
      return { id: "FR_RP", status: "BLOCKED", detail: `MFC FR ZIP missing: ${mfcZip}` };
    }
    const cmp = pack.compareSourceToZip(sourceRoot, mfcZip) as {
      contentParity: boolean;
      zipSha256: string;
      entryCount: number;
      sourceCount: number;
    };
    const mfcSha = await sha256File(mfcZip);
    const issues: string[] = [];
    if (!cmp.contentParity) {
      issues.push(
        `source↔ZIP contentParity=false entries=${cmp.entryCount} source=${cmp.sourceCount}`
      );
    }
    if (mfcSha.toLowerCase() !== approvedSha.toLowerCase()) {
      issues.push(`MFC ZIP SHA ${mfcSha} != approved ${approvedSha}`);
    }
    const built = pack.buildZipBuffer(sourceRoot) as { buffer: Buffer; sha256: string };
    const builtSha = built.sha256;
    if (builtSha.toLowerCase() !== approvedSha.toLowerCase()) {
      issues.push(`deterministic rebuild SHA ${builtSha} != approved ${approvedSha}`);
    }
    if (builtSha.toLowerCase() !== mfcSha.toLowerCase()) {
      issues.push(`MFC ZIP != rebuild (${mfcSha} vs ${builtSha})`);
    }
    if (issues.length) {
      return {
        id: "FR_RP",
        status: "BLOCKED",
        detail: issues.join("; "),
        evidence: {
          mfcSha,
          builtSha,
          approvedSha,
          contentParity: cmp.contentParity,
          entryCount: cmp.entryCount,
          sourceCount: cmp.sourceCount
        }
      };
    }
    return {
      id: "FR_RP",
      status: "PASS",
      detail: `FR RP SHA match ${mfcSha} entries=${cmp.entryCount}`,
      evidence: { mfcSha, builtSha, approvedSha, entryCount: cmp.entryCount }
    };
  } catch (e) {
    return {
      id: "FR_RP",
      status: "ERROR",
      detail: e instanceof Error ? e.message : String(e)
    };
  }
}

export function gateConfigPolicy(catalog: Catalog): GateResult {
  const policies = new Map<string, number>();
  const badSchema: string[] = [];
  const unsafe: string[] = [];
  const dualAuth: string[] = [];
  const stagedExcluded: string[] = [];

  for (const cf of catalog.configs) {
    const pol = String(cf.policy);
    policies.set(pol, (policies.get(pol) || 0) + 1);
    if (!ALLOWED_POLICIES.has(pol) && pol !== "NEVER_CLIENT_SECRET_REVIEW" && pol !== "COMMON_FORCE_REVIEW") {
      badSchema.push(`${cf.path}:${pol}`);
    }
    if (pol === "NEVER_CLIENT_SECRET_REVIEW" || pol === "COMMON_FORCE_REVIEW") {
      badSchema.push(`${cf.path}:unresolved_${pol}`);
    }
    const p = String(cf.path).replace(/\\/g, "/");
    if (!p.startsWith("config/") || p.includes("..") || path.isAbsolute(p)) {
      unsafe.push(p);
    }
    if (p.includes("sweetcraft-content") || p.startsWith("Content/") || p.includes("/configs/")) {
      dualAuth.push(p);
    }
    // EXCLUDED must never be staged — presence in catalogue is OK; leakage = appearing as stageable target
    if (BLOCKED_STAGED_POLICIES.has(pol) && cf.target && cf.target !== "NONE") {
      stagedExcluded.push(`${p}:${pol}:target=${cf.target}`);
    }
  }

  // Dual config authority: Content/configs dependency must not exist
  const contentConfigsDep = catalog.configs.some(c =>
    String(c.policy_reason ?? "").toLowerCase().includes("content/configs")
  );

  if (badSchema.length || unsafe.length || dualAuth.length || contentConfigsDep) {
    return {
      id: "CONFIG_POLICY",
      status: "BLOCKED",
      detail: `schema/unsafe/dual-authority issues`,
      evidence: {
        badSchema: badSchema.slice(0, 20),
        unsafe: unsafe.slice(0, 20),
        dualAuth: dualAuth.slice(0, 20),
        contentConfigsDep,
        policies: Object.fromEntries(policies)
      }
    };
  }

  // EXCLUDED with non-NONE target is leakage into release surfaces
  if (stagedExcluded.length) {
    return {
      id: "CONFIG_POLICY",
      status: "BLOCKED",
      detail: `EXCLUDED/runtime leakage into stageable targets: ${stagedExcluded.length}`,
      evidence: { stagedExcluded: stagedExcluded.slice(0, 30), policies: Object.fromEntries(policies) }
    };
  }

  return {
    id: "CONFIG_POLICY",
    status: "PASS",
    detail: `config policy OK configs=${catalog.configs.length}`,
    evidence: { policies: Object.fromEntries(policies) }
  };
}

function readEmbeddedModVersion(jarPath: string): { version?: string; environment?: string } {
  const zip = new AdmZip(jarPath);
  const entry = zip.getEntry("fabric.mod.json");
  if (!entry) return {};
  const json = JSON.parse(entry.getData().toString("utf8")) as {
    version?: string;
    environment?: string;
  };
  return { version: json.version, environment: json.environment };
}

export async function gateCasino(
  catalog: Catalog,
  mfcRoot: string,
  provenancePath: string | null | undefined
): Promise<{ gate: GateResult; evidence: CasinoGateEvidence }> {
  const mod = catalog.mods.find(m => m.mod_id === CASINO_MOD_ID);
  if (!mod) {
    const evidence: CasinoGateEvidence = {
      assemblyConsistency: "BLOCKED",
      certifiedProvenance: "BLOCKED",
      provenanceReason: "xbasecasino missing from catalogue"
    };
    return {
      gate: {
        id: "CASINO",
        status: "BLOCKED",
        detail: evidence.provenanceReason!,
        evidence: evidence as unknown as Record<string, unknown>
      },
      evidence
    };
  }

  const clientJar = path.join(mfcRoot, "client", "mods", mod.jar);
  const serverJar = path.join(mfcRoot, "server", "mods", mod.jar);
  const evidence: CasinoGateEvidence = {
    assemblyConsistency: "PASS",
    certifiedProvenance: "BLOCKED",
    catalogSha256: mod.sha256,
    catalogVersion: mod.version
  };

  const assemblyIssues: string[] = [];
  if (!(await pathExists(clientJar)) || !(await pathExists(serverJar))) {
    assemblyIssues.push("client/server jar missing");
    evidence.assemblyConsistency = "BLOCKED";
  } else {
    const cSha = await sha256File(clientJar);
    const sSha = await sha256File(serverJar);
    evidence.clientSha256 = cSha;
    evidence.serverSha256 = sSha;
    if (cSha !== sSha) {
      assemblyIssues.push("client/server SHA mismatch");
      evidence.assemblyConsistency = "BLOCKED";
    }
    if (cSha.toLowerCase() !== mod.sha256.toLowerCase()) {
      assemblyIssues.push("catalogue SHA != MFC client SHA");
      evidence.assemblyConsistency = "BLOCKED";
    }
    const embC = readEmbeddedModVersion(clientJar);
    const embS = readEmbeddedModVersion(serverJar);
    evidence.embeddedVersion = embC.version;
    if (embC.version !== embS.version) {
      assemblyIssues.push("embedded version client!=server");
      evidence.assemblyConsistency = "BLOCKED";
    }
    if (embC.version && embC.version !== mod.version) {
      assemblyIssues.push(`embedded ${embC.version} != catalogue ${mod.version}`);
      evidence.assemblyConsistency = "BLOCKED";
    }
    if (mod.side_class !== "BOTH_REQUIRED" || !mod.install_client || !mod.install_server) {
      assemblyIssues.push("side_class/install flags incompatible with BOTH_REQUIRED");
      evidence.assemblyConsistency = "BLOCKED";
    }
  }

  // Provenance — never treat version equality as certification
  let provReason = "M6-B_PENDING: no certified provenance proof";
  if (!provenancePath) {
    evidence.certifiedProvenance = "BLOCKED";
    evidence.provenanceReason = provReason;
  } else if (!(await pathExists(provenancePath))) {
    evidence.certifiedProvenance = "BLOCKED";
    evidence.provenanceReason = `provenance file missing: ${provenancePath}`;
    provReason = evidence.provenanceReason;
  } else {
    try {
      const raw = JSON.parse(await fs.readFile(provenancePath, "utf8")) as CasinoProvenanceProof;
      if (raw.schemaVersion !== 1) {
        evidence.certifiedProvenance = "BLOCKED";
        provReason = "invalid provenance schemaVersion";
      } else if (!/^[0-9a-fA-F]{64}$/.test(raw.certifiedArtifactSha256 || "")) {
        evidence.certifiedProvenance = "BLOCKED";
        provReason = "invalid certifiedArtifactSha256";
      } else if (!raw.approvedSourceCommit || !raw.certifiedVersion) {
        evidence.certifiedProvenance = "BLOCKED";
        provReason = "missing approvedSourceCommit/certifiedVersion";
      } else if (
        evidence.clientSha256 &&
        raw.certifiedArtifactSha256.toLowerCase() !== evidence.clientSha256.toLowerCase()
      ) {
        evidence.certifiedProvenance = "BLOCKED";
        provReason = "certified SHA != assembled JAR SHA (forged/mismatched)";
      } else if (raw.certifiedVersion !== mod.version) {
        evidence.certifiedProvenance = "BLOCKED";
        provReason = `certifiedVersion ${raw.certifiedVersion} != catalogue ${mod.version}`;
      } else {
        evidence.certifiedProvenance = "PASS";
        provReason = `certified commit=${raw.approvedSourceCommit} sha=${raw.certifiedArtifactSha256}`;
      }
      evidence.provenanceReason = provReason;
    } catch (e) {
      evidence.certifiedProvenance = "BLOCKED";
      provReason = `provenance parse error: ${e instanceof Error ? e.message : String(e)}`;
      evidence.provenanceReason = provReason;
    }
  }

  const status = worstStatus([evidence.assemblyConsistency, evidence.certifiedProvenance]);
  return {
    gate: {
      id: "CASINO",
      status,
      detail: `assembly=${evidence.assemblyConsistency} provenance=${evidence.certifiedProvenance} ${provReason}${
        assemblyIssues.length ? ` | assembly: ${assemblyIssues.join("; ")}` : ""
      }`,
      evidence: evidence as unknown as Record<string, unknown>
    },
    evidence
  };
}

export function gateVersions(
  catalog: Catalog,
  opts: {
    packVersion?: string | null;
    releaseSequence?: number | null;
    requireDatHostExternalVerify?: boolean;
    casinoVersion?: string;
  }
): GateResult {
  const mc = catalog.generatedFor?.minecraft;
  const loader = catalog.generatedFor?.fabricLoader;
  const fabricApi = catalog.mods.find(m => m.mod_id === "fabric-api");
  const issues: string[] = [];
  const external: string[] = [];

  if (!mc) issues.push("minecraft missing (catalog.generatedFor)");
  if (!loader) issues.push("fabricLoader missing (catalog.generatedFor)");
  if (!fabricApi?.version) issues.push("fabric-api version missing from catalogue");

  // Java: authority = strictest declared dependency among mods (local evidence)
  const javaReqs = catalog.mods
    .map(m => (m.depends as Record<string, string> | undefined)?.java)
    .filter(Boolean) as string[];
  const java = javaReqs.includes(">=25")
    ? ">=25"
    : javaReqs.includes(">=21")
      ? ">=21"
      : javaReqs[0] ?? null;
  if (!java) issues.push("java requirement not locally evidenced in catalogue depends");

  if (!opts.packVersion) {
    // missing packVersion for BOM is not automatically incompatible — mark BLOCKED for release matrix completeness
    issues.push("packVersion not supplied (required local release matrix proof)");
  }
  if (opts.releaseSequence == null) {
    // releaseSequence may be assigned at publish; for preflight mark EXTERNAL if only channel-assigned
    external.push("releaseSequence channel/DatHost assignment not locally final");
  }

  // DatHost live Fabric / server runtime — never infer from historical notes
  if (opts.requireDatHostExternalVerify !== false) {
    external.push("DatHost live Fabric/runtime version not locally verifiable");
  }

  // Incompatible matrix examples
  if (mc && fabricApi?.version && !String(fabricApi.version).includes(String(mc)) && fabricApi.version.includes("+")) {
    // soft check: if fabric-api encodes mc and mismatches
    const plus = String(fabricApi.version).split("+")[1];
    if (plus && plus !== mc) {
      return {
        id: "VERSION_COMPAT",
        status: "BLOCKED",
        detail: `fabric-api ${fabricApi.version} incompatible with minecraft ${mc}`,
        evidence: { minecraft: mc, fabricApi: fabricApi.version, fabricLoader: loader, java }
      };
    }
  }

  if (issues.length) {
    return {
      id: "VERSION_COMPAT",
      status: "BLOCKED",
      detail: issues.join("; "),
      evidence: {
        minecraft: mc ?? "UNKNOWN",
        fabricLoader: loader ?? "UNKNOWN",
        fabricApi: fabricApi?.version ?? "UNKNOWN",
        java: java ?? "UNKNOWN",
        packVersion: opts.packVersion ?? "UNKNOWN",
        casino: opts.casinoVersion ?? "UNKNOWN",
        external
      }
    };
  }

  if (external.length) {
    return {
      id: "VERSION_COMPAT",
      status: "EXTERNAL_VERIFY",
      detail: external.join("; "),
      evidence: {
        minecraft: mc,
        fabricLoader: loader,
        fabricApi: fabricApi?.version,
        java,
        packVersion: opts.packVersion,
        releaseSequence: opts.releaseSequence ?? "UNKNOWN",
        casino: opts.casinoVersion,
        external,
        authorities: {
          minecraft: "PM catalog.generatedFor",
          fabricLoader: "PM catalog.generatedFor",
          fabricApi: "PM catalog mod fabric-api",
          java: "PM catalog mod depends.java",
          casino: "PM catalog xbasecasino + MFC jars",
          packVersion: "stage CLI --version",
          releaseSequence: "stage --sequence / channel publish",
          dathost: "EXTERNAL live server"
        }
      }
    };
  }

  return {
    id: "VERSION_COMPAT",
    status: "PASS",
    detail: `mc=${mc} loader=${loader} api=${fabricApi?.version} java=${java}`,
    evidence: { minecraft: mc, fabricLoader: loader, fabricApi: fabricApi?.version, java }
  };
}

export async function buildBomDryRun(
  opts: ReleasePreflightOptions,
  catalog: Catalog,
  casino: CasinoGateEvidence,
  gates: GateResult[]
): Promise<ReleaseBomCandidate> {
  const fabricApi = catalog.mods.find(m => m.mod_id === "fabric-api");
  const javaReqs = catalog.mods
    .map(m => (m.depends as Record<string, string> | undefined)?.java)
    .filter(Boolean) as string[];
  const java = javaReqs.includes(">=25") ? ">=25" : javaReqs[0] ?? "UNKNOWN";

  let questHash: string | "UNKNOWN" = "UNKNOWN";
  let dpHash: string | "UNKNOWN" = "UNKNOWN";
  let rpHash: string | "UNKNOWN" = "UNKNOWN";
  let contentTree: string | "UNKNOWN" = "UNKNOWN";
  let rpZip: string | "UNKNOWN" = "UNKNOWN";
  let catalogHash: string | "UNKNOWN" = "UNKNOWN";
  let certifiedCommit: string | "UNKNOWN" = "UNKNOWN";
  let certifiedSha: string | "UNKNOWN" = "UNKNOWN";

  try {
    const sync = await loadSyncLib(opts.contentRoot);
    const qRoot = sync.resolveStrict(opts.contentRoot, ...String(sync.QUEST_SOURCE_REL).split(path.sep));
    const dRoot = sync.resolveStrict(opts.contentRoot, ...String(sync.DP_SOURCE_REL).split(path.sep));
    questHash = await treeHashDir(qRoot);
    dpHash = await treeHashDir(dRoot);
  } catch {
    /* UNKNOWN */
  }
  try {
    const pack = await loadPackRpLib(opts.contentRoot);
    const sRoot = pack.resolveStrict(opts.contentRoot, ...String(pack.RP_SOURCE_REL).split(path.sep));
    rpHash = await treeHashDir(sRoot);
    const z = pack.resolveStrict(opts.mfcRoot, ...String(pack.MFC_FR_ZIP_REL).split(path.sep));
    if (await pathExists(z)) rpZip = await sha256File(z);
  } catch {
    /* UNKNOWN */
  }
  try {
    contentTree = await treeHashDir(opts.contentRoot);
  } catch {
    /* UNKNOWN */
  }
  try {
    catalogHash = await sha256File(opts.catalogPath);
  } catch {
    /* UNKNOWN */
  }
  if (opts.casinoProvenancePath && (await pathExists(opts.casinoProvenancePath))) {
    try {
      const raw = JSON.parse(await fs.readFile(opts.casinoProvenancePath, "utf8")) as CasinoProvenanceProof;
      certifiedCommit = raw.approvedSourceCommit || "UNKNOWN";
      certifiedSha = raw.certifiedArtifactSha256 || "UNKNOWN";
    } catch {
      /* UNKNOWN */
    }
  }

  const notes: string[] = [];
  if (String(await gitIdentity(opts.contentRoot)).endsWith("+WIP")) {
    notes.push("Content has uncommitted WIP — no invented commit identity");
  }
  notes.push("BOM dry-run only — not written to PM release directories");
  notes.push("No signing identity secrets included");

  const casinoGate = gates.find(g => g.id === "CASINO");

  return {
    schemaVersion: 1,
    generatedAt: "bom-dry-run",
    packVersion: opts.packVersion ?? "UNKNOWN",
    releaseSequence: opts.releaseSequence ?? "UNKNOWN",
    minecraft: catalog.generatedFor?.minecraft ?? "UNKNOWN",
    java,
    fabricLoader: catalog.generatedFor?.fabricLoader ?? "UNKNOWN",
    fabricApi: fabricApi?.version ?? "UNKNOWN",
    contentSourceIdentity: await gitIdentity(opts.contentRoot),
    contentTreeHash: contentTree,
    questSourceHash: questHash,
    datapackSourceHash: dpHash,
    rpSourceHash: rpHash,
    rpZipSha256: rpZip,
    casinoVersion: casino.catalogVersion ?? "UNKNOWN",
    casinoClientSha256: casino.clientSha256 ?? "UNKNOWN",
    casinoServerSha256: casino.serverSha256 ?? "UNKNOWN",
    casinoCertifiedCommit: certifiedCommit,
    casinoCertifiedArtifactSha256: certifiedSha,
    casinoProvenanceStatus: casino.certifiedProvenance,
    packManagerSourceIdentity: await gitIdentity(opts.packManagerRoot),
    configCatalogueHash: catalogHash,
    clientManifestIdentity: "UNKNOWN",
    serverManifestIdentity: "UNKNOWN",
    notes
  };
}

export async function runReleasePreflight(
  opts: ReleasePreflightOptions
): Promise<ReleasePreflightReport> {
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const roots = {
    contentRoot: path.resolve(opts.contentRoot),
    mfcRoot: path.resolve(opts.mfcRoot),
    catalogPath: path.resolve(opts.catalogPath),
    casinoProvenancePath: opts.casinoProvenancePath
      ? path.resolve(opts.casinoProvenancePath)
      : null
  };

  if (!(await pathExists(roots.contentRoot))) {
    return errorReport(roots, generatedAt, `contentRoot missing: ${roots.contentRoot}`);
  }
  if (!(await pathExists(roots.mfcRoot))) {
    return errorReport(roots, generatedAt, `mfcRoot missing: ${roots.mfcRoot}`);
  }
  if (!(await pathExists(roots.catalogPath))) {
    return errorReport(roots, generatedAt, `catalog missing: ${roots.catalogPath}`);
  }

  let catalog: Catalog;
  try {
    catalog = await readCatalog(roots.catalogPath);
  } catch (e) {
    return errorReport(
      roots,
      generatedAt,
      `catalog read failed: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  const gates: GateResult[] = [];
  gates.push(await gateQuests(roots.contentRoot, roots.mfcRoot));
  gates.push(await gateDatapack(roots.contentRoot, roots.mfcRoot));
  gates.push(await gateFrRp(roots.contentRoot, roots.mfcRoot, opts.approvedFrRpSha256 ?? APPROVED_FR_RP_ZIP_SHA256));
  gates.push(gateConfigPolicy(catalog));
  const casino = await gateCasino(catalog, roots.mfcRoot, roots.casinoProvenancePath);
  gates.push(casino.gate);
  gates.push(
    gateVersions(catalog, {
      packVersion: opts.packVersion,
      releaseSequence: opts.releaseSequence,
      requireDatHostExternalVerify: opts.requireDatHostExternalVerify,
      casinoVersion: casino.evidence.catalogVersion
    })
  );

  const bom = await buildBomDryRun(opts, catalog, casino.evidence, gates);
  const status = worstStatus(gates.map(g => g.status));
  const summary = gates.map(g => `${g.id}=${g.status}`).join(" ");

  return {
    schemaVersion: PREFLIGHT_SCHEMA_VERSION,
    protocol: "STEP-4.6-M7-RELEASE-PREFLIGHT",
    status,
    exitCode: PREFLIGHT_EXIT[status],
    generatedAt,
    mutable: false,
    roots,
    gates,
    casino: casino.evidence,
    bom,
    summary
  };
}

function errorReport(
  roots: ReleasePreflightReport["roots"],
  generatedAt: string,
  detail: string
): ReleasePreflightReport {
  const gates: GateResult[] = [{ id: "ROOTS", status: "ERROR", detail }];
  return {
    schemaVersion: PREFLIGHT_SCHEMA_VERSION,
    protocol: "STEP-4.6-M7-RELEASE-PREFLIGHT",
    status: "ERROR",
    exitCode: PREFLIGHT_EXIT.ERROR,
    generatedAt,
    mutable: false,
    roots,
    gates,
    casino: {
      assemblyConsistency: "ERROR",
      certifiedProvenance: "ERROR",
      provenanceReason: detail
    },
    bom: {
      schemaVersion: 1,
      generatedAt: "bom-dry-run",
      packVersion: "UNKNOWN",
      releaseSequence: "UNKNOWN",
      minecraft: "UNKNOWN",
      java: "UNKNOWN",
      fabricLoader: "UNKNOWN",
      fabricApi: "UNKNOWN",
      contentSourceIdentity: "UNKNOWN",
      contentTreeHash: "UNKNOWN",
      questSourceHash: "UNKNOWN",
      datapackSourceHash: "UNKNOWN",
      rpSourceHash: "UNKNOWN",
      rpZipSha256: "UNKNOWN",
      casinoVersion: "UNKNOWN",
      casinoClientSha256: "UNKNOWN",
      casinoServerSha256: "UNKNOWN",
      casinoCertifiedCommit: "UNKNOWN",
      casinoCertifiedArtifactSha256: "UNKNOWN",
      casinoProvenanceStatus: "UNKNOWN",
      packManagerSourceIdentity: "UNKNOWN",
      configCatalogueHash: "UNKNOWN",
      clientManifestIdentity: "UNKNOWN",
      serverManifestIdentity: "UNKNOWN",
      notes: [detail]
    },
    summary: `ROOTS=ERROR ${detail}`
  };
}

export function formatReleasePreflightSummary(r: ReleasePreflightReport): string {
  const lines = [
    `release-preflight status=${r.status} exit=${r.exitCode}`,
    `casino assembly=${r.casino.assemblyConsistency} provenance=${r.casino.certifiedProvenance}`,
    ...r.gates.map(g => `  ${g.status.padEnd(16)} ${g.id} — ${g.detail}`)
  ];
  return lines.join("\n");
}

export function assertReleasePreflightAllowsStage(report: ReleasePreflightReport): void {
  if (report.status !== "PASS") {
    throw new Error(
      `ASSEMBLY_PREFLIGHT_${report.status}: staging refused — ${report.summary}`
    );
  }
}
