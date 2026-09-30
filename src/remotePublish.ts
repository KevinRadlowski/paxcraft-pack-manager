import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { ReleaseChannel } from "./releasePayload.js";
import type { TrustedKeys } from "./releaseSigning.js";
import { loadTrustedKeys } from "./trustedKeys.js";
import { verifyRelease } from "./verifyRelease.js";
import { verifyChannelDescriptor } from "./verifyChannel.js";
import {
  assertPackVersion,
  assertPositiveSequence,
  assertReleaseChannel,
  assertTransactionId,
  DEFAULT_ORIGIN,
  generateTransactionId,
  incomingChannelPath,
  incomingReleasePath,
  incomingTransactionPath,
  PUBLIC_ROOT
} from "./remotePaths.js";
import {
  remoteCommitCommand,
  remoteMkdirTransactionCommand,
  remoteRmTransactionCommand,
  remoteVerifyOriginCommand,
  SystemSshTransport,
  type RemoteTransport,
  type SshTarget
} from "./sshTransport.js";
import { verifyHttpsPublication, createDefaultHttpFetcher, type HttpFetcher } from "./httpVerify.js";
import {
  normalizeProductOriginUrl,
  OriginUrlError,
  publicChannelUrl,
  publicReleaseJsonUrl
} from "./originUrl.js";

export const DEFAULT_UPLOAD_TIMEOUT_SECONDS = 60;

export type RemotePublishStep =
  | "LOCAL_VERIFY"
  | "SSH_PREPARE"
  | "UPLOAD"
  | "REMOTE_VERIFY"
  | "COMMIT"
  | "HTTPS_VERIFY"
  | "CLEANUP";

export type RemotePublishFailCode = "REMOTE_PUBLISH_FAIL" | "REMOTE_PUBLISH_COMMITTED_BUT_UNVERIFIED";

export class RemotePublishError extends Error {
  readonly step: RemotePublishStep;
  /** True when the remote commit gate already succeeded. */
  readonly remoteCommitSucceeded: boolean;
  readonly doNotRetryUpload: boolean;
  readonly code: RemotePublishFailCode;
  readonly channelUrl?: string;
  readonly releaseUrl?: string;

  constructor(
    step: RemotePublishStep,
    message: string,
    opts?: {
      remoteCommitSucceeded?: boolean;
      channelUrl?: string;
      releaseUrl?: string;
    }
  ) {
    super(message);
    this.name = "RemotePublishError";
    this.step = step;
    this.remoteCommitSucceeded = !!opts?.remoteCommitSucceeded;
    this.doNotRetryUpload = this.remoteCommitSucceeded;
    this.code = this.remoteCommitSucceeded
      ? "REMOTE_PUBLISH_COMMITTED_BUT_UNVERIFIED"
      : "REMOTE_PUBLISH_FAIL";
    this.channelUrl = opts?.channelUrl;
    this.releaseUrl = opts?.releaseUrl;
  }
}

/** Validate timeoutSeconds: finite number strictly > 0. Returns seconds. */
export function resolveTimeoutSeconds(timeoutSeconds: number | undefined): number {
  const v = timeoutSeconds === undefined ? DEFAULT_UPLOAD_TIMEOUT_SECONDS : timeoutSeconds;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
    throw new RemotePublishError(
      "LOCAL_VERIFY",
      "--timeout doit être un nombre fini strictement positif (secondes)"
    );
  }
  return v;
}

export interface RemotePublishOptions {
  root: string;
  channel: ReleaseChannel | string;
  host: string;
  user: string;
  identity?: string;
  port?: number;
  origin?: string;
  timeoutSeconds?: number;
  keepFailedTransaction?: boolean;
  trustedKeys?: TrustedKeys;
  trustedKeysFile?: string;
  transport?: RemoteTransport;
  httpFetch?: HttpFetcher;
  httpsMaxAttempts?: number;
  httpsRetryDelayMs?: number;
  httpsSleep?: (ms: number) => Promise<void>;
  /** Test hook: record ssh/scp calls */
  onNetwork?: (kind: string, detail: string) => void;
}

export interface RemotePublishResult {
  ok: true;
  packVersion: string;
  channel: ReleaseChannel;
  releaseSequence: number;
  transactionId: string;
  releaseSignature: "SIGNED_OK";
  channelSignature: "SIGNED_OK";
  origin: string;
}

function redactSecrets(text: string): string {
  return text
    .replace(/BEGIN [A-Z ]*PRIVATE KEY[\s\S]*?END [A-Z ]*PRIVATE KEY/gi, "[REDACTED_PRIVATE_KEY]")
    .replace(/passphrase[^\s]*/gi, "passphrase=[REDACTED]");
}

function assertNoSecretsInLogs(...parts: string[]) {
  const blob = parts.join("\n");
  if (/BEGIN [A-Z ]*PRIVATE KEY/i.test(blob)) {
    throw new RemotePublishError("LOCAL_VERIFY", "fuite potentielle de clé privée dans les logs/commandes");
  }
  if (/SWEETCRAFT_RELEASE_ED25519_PRIVATE_KEY_PEM/i.test(blob) && /-----BEGIN/.test(blob)) {
    throw new RemotePublishError("LOCAL_VERIFY", "clé de signature release détectée — interdite dans le transport");
  }
}

async function loadChannelDoc(root: string, channel: ReleaseChannel) {
  const channelFile = path.join(root, "channels", `${channel}.json`);
  const raw = await fs.readFile(channelFile);
  const doc = JSON.parse(raw.toString("utf8")) as {
    packVersion?: string;
    releaseSequence?: number;
    releasePath?: string;
    schemaVersion?: number;
    channel?: string;
    releaseSha256?: string;
    signature?: { algorithm?: string; publicKeyId?: string | null; value?: string | null; status?: string };
  };
  return { channelFile, raw, doc };
}

/**
 * Prevalidate a local publish tree. Throws before any network.
 * Returns metadata needed for upload.
 */
export async function prevalidateLocalPublish(opts: {
  root: string;
  channel: string;
  trustedKeys: TrustedKeys;
}): Promise<{
  channel: ReleaseChannel;
  packVersion: string;
  releaseSequence: number;
  releaseDir: string;
  channelFile: string;
  releaseJsonPath: string;
  channelRaw: Buffer;
  releaseRaw: Buffer;
}> {
  assertReleaseChannel(opts.channel);
  const channel = opts.channel as ReleaseChannel;
  const root = path.resolve(opts.root);

  if (!opts.trustedKeys || Object.keys(opts.trustedKeys).length === 0) {
    throw new RemotePublishError("LOCAL_VERIFY", "trusted keyring absent — fournir --trusted-keys");
  }

  let channelFile: string;
  let channelRaw: Buffer;
  let doc: Awaited<ReturnType<typeof loadChannelDoc>>["doc"];
  try {
    ({ channelFile, raw: channelRaw, doc } = await loadChannelDoc(root, channel));
  } catch (e) {
    throw new RemotePublishError(
      "LOCAL_VERIFY",
      `channel local illisible: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  if (doc.channel && doc.channel !== channel) {
    throw new RemotePublishError("LOCAL_VERIFY", `channel fichier (${doc.channel}) != demandé (${channel})`);
  }
  if (!doc.packVersion) throw new RemotePublishError("LOCAL_VERIFY", "packVersion manquant");
  assertPackVersion(doc.packVersion);
  if (!Number.isInteger(doc.releaseSequence)) {
    throw new RemotePublishError("LOCAL_VERIFY", "releaseSequence manquant");
  }
  assertPositiveSequence(doc.releaseSequence!);
  const expectedPath = `releases/${doc.packVersion}/release.json`;
  if (doc.releasePath !== expectedPath) {
    throw new RemotePublishError(
      "LOCAL_VERIFY",
      `releasePath invalide: attendu ${expectedPath}, reçu ${doc.releasePath}`
    );
  }

  const releaseDir = path.join(root, "releases", doc.packVersion);
  const releaseJsonPath = path.join(releaseDir, "release.json");
  let releaseRaw: Buffer;
  try {
    releaseRaw = await fs.readFile(releaseJsonPath);
  } catch {
    throw new RemotePublishError("LOCAL_VERIFY", `release absente: ${releaseJsonPath}`);
  }

  const vr = await verifyRelease({
    releaseDir,
    trustedKeys: opts.trustedKeys,
    allowUnsignedDev: false
  });
  if (!vr.ok || vr.signature !== "SIGNED_OK") {
    const detail = vr.errors.slice(0, 3).join("; ") || vr.signature;
    throw new RemotePublishError("LOCAL_VERIFY", `release signature invalide: ${detail}`);
  }

  const vc = await verifyChannelDescriptor({
    channelFile,
    root,
    trustedKeys: opts.trustedKeys,
    allowUnsignedDev: false
  });
  if (!vc.ok || vc.channelSignature !== "SIGNED_OK") {
    const detail = vc.errors.slice(0, 3).join("; ") || vc.channelSignature;
    throw new RemotePublishError("LOCAL_VERIFY", `channel signature invalide: ${detail}`);
  }
  if (vc.releaseSequence !== doc.releaseSequence) {
    throw new RemotePublishError("LOCAL_VERIFY", "releaseSequence incohérent channel/release");
  }

  return {
    channel,
    packVersion: doc.packVersion,
    releaseSequence: doc.releaseSequence!,
    releaseDir,
    channelFile,
    releaseJsonPath,
    channelRaw,
    releaseRaw
  };
}

/**
 * Upload a locally signed publish tree to the SweetCraft origin via SSH + commit gate.
 * Never writes to public/; never transmits release signing private keys.
 */
export async function remotePublish(opts: RemotePublishOptions): Promise<RemotePublishResult> {
  const step = (s: RemotePublishStep, msg: string): never => {
    throw new RemotePublishError(s, msg);
  };

  // Reject forbidden CLI-equivalent options if somehow passed via env pollution in messages
  const forbidden = ["--password", "--root-password", "--disable-host-key-check", "--insecure"];
  for (const f of forbidden) {
    if (opts.host.includes(f) || opts.user.includes(f)) {
      step("LOCAL_VERIFY", `option interdite: ${f}`);
    }
  }

  const timeoutSeconds = resolveTimeoutSeconds(opts.timeoutSeconds);
  const timeoutMs = Math.floor(timeoutSeconds * 1000);

  let trustedKeys = opts.trustedKeys;
  if (!trustedKeys) {
    try {
      trustedKeys = await loadTrustedKeys({
        file: opts.trustedKeysFile,
        fromEnv: !opts.trustedKeysFile
      });
    } catch (e) {
      throw new RemotePublishError(
        "LOCAL_VERIFY",
        `trusted keys: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  // --- LOCAL_VERIFY (no network) ---
  const local = await prevalidateLocalPublish({
    root: opts.root,
    channel: opts.channel,
    trustedKeys
  });

  const tx = generateTransactionId(local.channel, local.packVersion, local.releaseSequence);
  assertTransactionId(tx);
  let origin: string;
  try {
    origin = normalizeProductOriginUrl(opts.origin ?? DEFAULT_ORIGIN);
  } catch (e) {
    throw new RemotePublishError(
      "LOCAL_VERIFY",
      e instanceof OriginUrlError || e instanceof Error ? e.message : String(e)
    );
  }
  const channelPublicUrl = publicChannelUrl(origin, local.channel);
  const releasePublicUrl = publicReleaseJsonUrl(origin, local.packVersion);
  const transport = opts.transport ?? new SystemSshTransport();
  const target: SshTarget = {
    host: opts.host,
    user: opts.user,
    port: opts.port ?? 22,
    identity: opts.identity,
    batchMode: true,
    timeoutMs
  };

  const httpFetch = opts.httpFetch ?? createDefaultHttpFetcher(timeoutMs);

  const notify = (kind: string, detail: string) => {
    assertNoSecretsInLogs(kind, detail);
    opts.onNetwork?.(kind, detail);
  };

  /** True once we have attempted to create incoming/<tx> on the remote. */
  let remoteTransactionMayExist = false;
  let committed = false;

  const cleanup = async () => {
    if (opts.keepFailedTransaction) return;
    if (committed) return; // never delete a committed public release; only incoming tx
    if (!remoteTransactionMayExist) return;
    try {
      notify("cleanup", tx);
      const cmd = remoteRmTransactionCommand(tx);
      assertNoSecretsInLogs(cmd);
      if (cmd.includes(PUBLIC_ROOT)) step("CLEANUP", "cleanup public interdit");
      await transport.ssh(target, cmd);
    } catch {
      // best-effort
    }
  };

  const failOp = async (
    s: RemotePublishStep,
    msg: string,
    res?: { timedOut?: boolean; stderr?: string; stdout?: string }
  ): Promise<never> => {
    const detail = res?.timedOut ? `timeout after ${timeoutSeconds}s: ${msg}` : msg;
    await cleanup();
    throw new RemotePublishError(s, detail);
  };

  const failAfterCommit = (msg: string): never => {
    throw new RemotePublishError("HTTPS_VERIFY", msg, {
      remoteCommitSucceeded: true,
      channelUrl: channelPublicUrl,
      releaseUrl: releasePublicUrl
    });
  };

  try {
    // --- SSH_PREPARE ---
    notify("ssh_prepare", incomingTransactionPath(tx));
    const mkdirCmd = remoteMkdirTransactionCommand(tx);
    assertNoSecretsInLogs(mkdirCmd);
    remoteTransactionMayExist = true; // mkdir may have partially created the tree
    const mkdirRes = await transport.ssh(target, mkdirCmd);
    if (mkdirRes.timedOut || mkdirRes.code !== 0) {
      await failOp(
        "SSH_PREPARE",
        `mkdir remote échoué: ${redactSecrets(mkdirRes.stderr || mkdirRes.stdout)}`,
        mkdirRes
      );
    }

    // --- UPLOAD ---
    const remoteRelease = incomingReleasePath(tx, local.packVersion);
    const remoteChannel = incomingChannelPath(tx, local.channel);
    notify("upload_release", `${local.releaseDir} -> ${remoteRelease}`);
    const scpRel = await transport.scpTo(target, local.releaseDir, remoteRelease, true);
    if (scpRel.timedOut || scpRel.code !== 0) {
      await failOp(
        "UPLOAD",
        `upload release échoué: ${redactSecrets(scpRel.stderr || scpRel.stdout)}`,
        scpRel
      );
    }
    notify("upload_channel", `${local.channelFile} -> ${remoteChannel}`);
    const scpCh = await transport.scpTo(target, local.channelFile, remoteChannel, false);
    if (scpCh.timedOut || scpCh.code !== 0) {
      await failOp(
        "UPLOAD",
        `upload channel échoué: ${redactSecrets(scpCh.stderr || scpCh.stdout)}`,
        scpCh
      );
    }

    for (const r of [scpRel, scpCh, mkdirRes]) {
      assertNoSecretsInLogs(r.argv.join(" "), r.stdout, r.stderr);
      if (r.argv.join(" ").includes(PUBLIC_ROOT)) {
        await failOp("UPLOAD", "tentative d'écriture public détectée");
      }
    }

    // --- REMOTE_VERIFY ---
    const verifyCmd = remoteVerifyOriginCommand(tx, local.channel);
    notify("remote_verify", verifyCmd);
    assertNoSecretsInLogs(verifyCmd);
    const verifyRes = await transport.ssh(target, verifyCmd);
    if (verifyRes.timedOut || verifyRes.code !== 0) {
      await failOp(
        "REMOTE_VERIFY",
        `verify-origin exit ${verifyRes.code}: ${redactSecrets(verifyRes.stderr || verifyRes.stdout)}`,
        verifyRes
      );
    }
    if (!verifyRes.stdout.includes("ORIGIN_VERIFY_OK")) {
      await failOp("REMOTE_VERIFY", "remote verifier sans ORIGIN_VERIFY_OK");
    }

    // --- COMMIT ---
    const commitCmd = remoteCommitCommand(tx, local.channel, local.releaseSequence);
    notify("commit", commitCmd);
    assertNoSecretsInLogs(commitCmd);
    if (!commitCmd.includes(tx) || !commitCmd.includes(local.channel) || !commitCmd.includes(String(local.releaseSequence))) {
      await failOp("COMMIT", "arguments commit incomplets");
    }
    const commitRes = await transport.ssh(target, commitCmd);
    if (commitRes.timedOut || commitRes.code !== 0) {
      const out = redactSecrets(commitRes.stderr || commitRes.stdout);
      if (commitRes.timedOut) {
        await failOp("COMMIT", `commit gate: ${out}`, commitRes);
      }
      await cleanup();
      if (/CHANNEL_SEQUENCE_RACE/i.test(out)) {
        step("COMMIT", `CHANNEL_SEQUENCE_RACE: ${out}`);
      }
      step("COMMIT", `commit gate échoué: ${out}`);
    }
    committed = true;

    // --- HTTPS_VERIFY ---
    try {
      await verifyHttpsPublication({
        origin,
        channel: local.channel,
        packVersion: local.packVersion,
        localChannelPath: local.channelFile,
        localReleaseJsonPath: local.releaseJsonPath,
        fetchFn: httpFetch,
        maxAttempts: opts.httpsMaxAttempts,
        retryDelayMs: opts.httpsRetryDelayMs,
        sleep: opts.httpsSleep,
        attemptTimeoutMs: timeoutMs
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/timeout/i.test(msg)) {
        failAfterCommit(`timeout after ${timeoutSeconds}s: ${msg}`);
      }
      failAfterCommit(msg);
    }

    return {
      ok: true,
      packVersion: local.packVersion,
      channel: local.channel,
      releaseSequence: local.releaseSequence,
      transactionId: tx,
      releaseSignature: "SIGNED_OK",
      channelSignature: "SIGNED_OK",
      origin
    };
  } catch (e) {
    if (e instanceof RemotePublishError) {
      if (e.remoteCommitSucceeded || e.step === "HTTPS_VERIFY") {
        // commit succeeded — do not delete public / do not cleanup gate-owned state
      } else if (remoteTransactionMayExist && !committed && e.step !== "LOCAL_VERIFY" && e.step !== "CLEANUP") {
        // ensure cleanup if a branch threw without calling failOp
        await cleanup().catch(() => undefined);
      }
      throw e;
    }
    if (remoteTransactionMayExist && !committed) await cleanup().catch(() => undefined);
    throw new RemotePublishError("UPLOAD", e instanceof Error ? e.message : String(e));
  }
}

export function formatRemotePublishReport(r: RemotePublishResult): string {
  return [
    "SweetCraft Remote Publisher",
    "",
    "Local verification: OK",
    `Release signature: ${r.releaseSignature}`,
    `Channel signature: ${r.channelSignature}`,
    "",
    `Pack version: ${r.packVersion}`,
    `Channel: ${r.channel}`,
    `Release sequence: ${r.releaseSequence}`,
    "",
    `Transaction: ${r.transactionId}`,
    "",
    "Upload: OK",
    "Remote origin verification: OK",
    "Commit gate: OK",
    "HTTPS channel verification: OK",
    "HTTPS release verification: OK",
    "",
    "REMOTE_PUBLISH_OK"
  ].join("\n");
}

export function formatRemotePublishFail(e: RemotePublishError): string {
  if (e.remoteCommitSucceeded || e.code === "REMOTE_PUBLISH_COMMITTED_BUT_UNVERIFIED") {
    const lines = [
      "REMOTE_PUBLISH_COMMITTED_BUT_UNVERIFIED",
      `Step: ${e.step}`,
      "REMOTE_COMMIT_SUCCEEDED=YES",
      "DO_NOT_RETRY_UPLOAD=YES",
      `Reason: ${redactSecrets(e.message)}`
    ];
    if (e.channelUrl) lines.push(`Channel URL: ${e.channelUrl}`);
    if (e.releaseUrl) lines.push(`Release URL: ${e.releaseUrl}`);
    return lines.join("\n");
  }
  return ["REMOTE_PUBLISH_FAIL", `Step: ${e.step}`, redactSecrets(e.message)].join("\n");
}

/** Hash helper for tests */
export function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}
