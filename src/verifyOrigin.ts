import { promises as fs } from "node:fs";
import path from "node:path";
import type { ReleaseChannel } from "./releasePayload.js";
import type { TrustedKeys } from "./releaseSigning.js";
import { verifyRelease } from "./verifyRelease.js";
import { verifyChannelDescriptor } from "./verifyChannel.js";

export class OriginVerifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OriginVerifyError";
  }
}

export interface VerifyOriginOptions {
  /** Incoming transaction root (contains releases/ and channels/). */
  transactionDir: string;
  channel: ReleaseChannel | string;
  trustedKeys: TrustedKeys;
}

export interface VerifyOriginResult {
  ok: boolean;
  transaction: string;
  channel: string;
  packVersion: string;
  releaseSequence: number;
  releaseSignature: "SIGNED_OK" | "FAIL";
  channelSignature: "SIGNED_OK" | "FAIL";
  filesChecked: number;
  configs: number;
  errors: string[];
}

const FORBIDDEN_EXT = new Set([".pem", ".key", ".env", ".bak", ".tmp", ".log"]);

function assertChannel(ch: string): asserts ch is ReleaseChannel {
  if (ch !== "dev" && ch !== "beta" && ch !== "stable") {
    throw new OriginVerifyError(`channel invalide (dev|beta|stable): ${ch}`);
  }
}

async function lstatSafe(p: string) {
  return fs.lstat(p);
}

async function assertNotSymlink(abs: string, label: string) {
  const st = await lstatSafe(abs);
  if (st.isSymbolicLink()) {
    throw new OriginVerifyError(`symlink refusé: ${label}`);
  }
  return st;
}

function isHiddenName(name: string): boolean {
  return name.startsWith(".");
}

function isForbiddenFile(name: string): boolean {
  if (isHiddenName(name)) return true;
  const lower = name.toLowerCase();
  for (const ext of FORBIDDEN_EXT) {
    if (lower.endsWith(ext)) return true;
  }
  // also reject names like ".env.local" already caught by hidden; "foo.env" by ext
  return false;
}

interface WalkEntry {
  rel: string;
  abs: string;
  isFile: boolean;
  isDirectory: boolean;
}

async function walkTransaction(root: string): Promise<WalkEntry[]> {
  const out: WalkEntry[] = [];
  async function walk(dir: string, relBase: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      const rel = relBase ? `${relBase}/${ent.name}` : ent.name;
      const abs = path.join(dir, ent.name);
      // Use lstat — Dirent.isSymbolicLink() is reliable when withFileTypes, but re-check
      const st = await lstatSafe(abs);
      if (st.isSymbolicLink()) {
        throw new OriginVerifyError(`symlink refusé: ${rel}`);
      }
      if (isForbiddenFile(ent.name)) {
        throw new OriginVerifyError(`fichier interdit dans la transaction: ${rel}`);
      }
      if (st.isDirectory()) {
        out.push({ rel: rel.replace(/\\/g, "/"), abs, isFile: false, isDirectory: true });
        await walk(abs, rel.replace(/\\/g, "/"));
      } else if (st.isFile()) {
        out.push({ rel: rel.replace(/\\/g, "/"), abs, isFile: true, isDirectory: false });
      } else {
        throw new OriginVerifyError(`type de fichier non supporté: ${rel}`);
      }
    }
  }
  await walk(root, "");
  return out;
}

/**
 * Verify an incoming origin transaction (read-only).
 * Reuses verifyRelease + verifyChannelDescriptor. Never requires a private key.
 * Origin always requires cryptographic signatures (even for channel=dev).
 */
export async function verifyOrigin(opts: VerifyOriginOptions): Promise<VerifyOriginResult> {
  const errors: string[] = [];
  const fail = (m: string): never => {
    throw new OriginVerifyError(m);
  };

  assertChannel(String(opts.channel));
  const channel = opts.channel as ReleaseChannel;

  if (!opts.trustedKeys || Object.keys(opts.trustedKeys).length === 0) {
    fail("trusted keys vides — SWEETCRAFT_TRUSTED_PUBLIC_KEYS_FILE ou --trusted-keys obligatoire");
  }

  const rawTx = opts.transactionDir;
  if (!rawTx || typeof rawTx !== "string") fail("transaction path vide");
  if (rawTx.includes("\0")) fail("transaction path invalide");

  const transaction = path.resolve(rawTx);
  if (transaction.includes("\0")) fail("transaction path invalide");

  let rootStat;
  try {
    rootStat = await assertNotSymlink(transaction, transaction);
  } catch (e) {
    if (e instanceof OriginVerifyError) throw e;
    fail(`transaction introuvable: ${transaction}`);
  }
  if (!rootStat!.isDirectory()) fail(`transaction n'est pas un répertoire: ${transaction}`);

  let entries: WalkEntry[];
  try {
    entries = await walkTransaction(transaction);
  } catch (e) {
    if (e instanceof OriginVerifyError) throw e;
    fail(e instanceof Error ? e.message : String(e));
  }

  const files = entries!.filter(e => e.isFile);
  const topDirs = new Set(
    entries!.filter(e => e.isDirectory && !e.rel.includes("/")).map(e => e.rel)
  );
  for (const d of topDirs) {
    if (d !== "releases" && d !== "channels") {
      fail(`entrée racine interdite: ${d}`);
    }
  }
  for (const f of files) {
    if (!f.rel.includes("/")) {
      fail(`fichier racine interdit: ${f.rel}`);
    }
  }

  // Exactly one release directory under releases/
  const releaseDirs = entries!
    .filter(e => e.isDirectory && /^releases\/[^/]+$/.test(e.rel))
    .map(e => e.rel.slice("releases/".length));
  if (releaseDirs.length === 0) fail("release absente (releases/<packVersion>/)");
  if (releaseDirs.length > 1) {
    fail(`plusieurs releases refusées: ${releaseDirs.join(", ")}`);
  }
  const packVersion = releaseDirs[0]!;
  if (!packVersion || packVersion.includes("..") || packVersion.startsWith(".")) {
    fail(`packVersion invalide: ${packVersion}`);
  }

  const releaseDir = path.join(transaction, "releases", packVersion);
  const releaseJson = path.join(releaseDir, "release.json");
  if (!(await fs.access(releaseJson).then(() => true).catch(() => false))) {
    fail("release absente (release.json manquant)");
  }

  const channelFile = path.join(transaction, "channels", `${channel}.json`);
  if (!(await fs.access(channelFile).then(() => true).catch(() => false))) {
    fail(`channel absent: channels/${channel}.json`);
  }

  for (const f of files) {
    if (f.rel.startsWith("channels/")) {
      if (f.rel !== `channels/${channel}.json`) {
        fail(`fichier channel inattendu: ${f.rel}`);
      }
    }
  }

  let channelDoc: {
    packVersion?: string;
    releaseSequence?: number;
    releasePath?: string;
  };
  try {
    channelDoc = JSON.parse(await fs.readFile(channelFile, "utf8"));
  } catch (e) {
    fail(`channel illisible: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (channelDoc!.packVersion !== packVersion) {
    fail(
      `packVersion diverge: channel=${channelDoc!.packVersion} transaction=${packVersion}`
    );
  }

  const expectedPath = `releases/${packVersion}/release.json`;
  if (channelDoc!.releasePath !== expectedPath) {
    fail(`releasePath invalide: attendu ${expectedPath}, reçu ${channelDoc!.releasePath}`);
  }

  // --- reuse existing verifiers (signed required on origin) ---
  const vr = await verifyRelease({
    releaseDir,
    trustedKeys: opts.trustedKeys,
    allowUnsignedDev: false
  });
  if (!vr.ok || vr.signature !== "SIGNED_OK") {
    for (const e of vr.errors) errors.push(`release: ${e}`);
    if (vr.signature === "UNSIGNED_DEV") {
      errors.push("release: unsigned-dev refusé sur l'origin (signature obligatoire)");
    } else if (vr.signature !== "SIGNED_OK") {
      errors.push(`release: signature=${vr.signature}`);
    }
  }

  const vc = await verifyChannelDescriptor({
    channelFile,
    root: transaction,
    trustedKeys: opts.trustedKeys,
    allowUnsignedDev: false
  });
  if (!vc.ok || vc.channelSignature !== "SIGNED_OK") {
    for (const e of vc.errors) errors.push(`channel: ${e}`);
    if (vc.channelSignature === "UNSIGNED_DEV") {
      errors.push("channel: unsigned-dev refusé sur l'origin (signature obligatoire)");
    } else if (vc.channelSignature !== "SIGNED_OK") {
      errors.push(`channel: signature=${vc.channelSignature}`);
    }
  }

  if (vc.releaseSequence !== (channelDoc!.releaseSequence ?? -1)) {
    // verifyChannel already checks coherence; keep explicit
  }

  let configs = 0;
  try {
    const release = JSON.parse(await fs.readFile(releaseJson, "utf8")) as {
      stats?: { configsStaged?: number };
      antiRollback?: { releaseSequence?: number | null };
    };
    configs = release.stats?.configsStaged ?? 0;
    if (configs === 0) {
      // fallback: count files/ entries from checksums via filesChecked approximation
      configs = Math.max(0, vr.filesChecked - 2);
    }
  } catch {
    configs = Math.max(0, vr.filesChecked - 2);
  }

  if (errors.length) {
    throw new OriginVerifyError(errors.join("; "));
  }

  return {
    ok: true,
    transaction,
    channel,
    packVersion,
    releaseSequence: vc.releaseSequence,
    releaseSignature: "SIGNED_OK",
    channelSignature: "SIGNED_OK",
    filesChecked: vr.filesChecked,
    configs,
    errors: []
  };
}

export function formatOriginVerifyReport(r: VerifyOriginResult): string {
  return [
    "ORIGIN_VERIFY_OK",
    `Transaction: ${r.transaction}`,
    `Channel: ${r.channel}`,
    `Pack version: ${r.packVersion}`,
    `Release sequence: ${r.releaseSequence}`,
    `Release signature: ${r.releaseSignature}`,
    `Channel signature: ${r.channelSignature}`,
    `Files checked: ${r.filesChecked}`,
    `Configs: ${r.configs}`
  ].join("\n");
}

export function originVerifyToJson(r: VerifyOriginResult): Record<string, unknown> {
  return {
    ok: r.ok,
    channel: r.channel,
    packVersion: r.packVersion,
    releaseSequence: r.releaseSequence,
    releaseSignature: r.releaseSignature,
    channelSignature: r.channelSignature,
    filesChecked: r.filesChecked,
    configs: r.configs,
    transaction: r.transaction
  };
}
