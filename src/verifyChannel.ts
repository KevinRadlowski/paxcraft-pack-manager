import { promises as fs } from "node:fs";
import path from "node:path";
import {
  buildChannelSigningPayload,
  CHANNEL_SCHEMA_VERSION,
  CHANNEL_SIGNING_PAYLOAD_ID,
  type ChannelDescriptor
} from "./releasePayload.js";
import { verifyEd25519Pem, type TrustedKeys } from "./releaseSigning.js";
import { hashFile } from "./io.js";
import { verifyRelease } from "./verifyRelease.js";

export class VerifyChannelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerifyChannelError";
  }
}

export interface VerifyChannelOptions {
  /** Absolute or relative path to channels/<name>.json */
  channelFile: string;
  /** CDN/publish root containing releases/ and channels/ */
  root: string;
  trustedKeys?: TrustedKeys;
  allowUnsignedDev?: boolean;
}

export interface VerifyChannelResult {
  ok: boolean;
  channel: string;
  packVersion: string;
  releaseSequence: number;
  releasePath: string;
  channelSignature: "SIGNED_OK" | "UNSIGNED_DEV" | "FAIL";
  releaseSignature: "SIGNED_OK" | "UNSIGNED_DEV" | "FAIL" | "SKIPPED";
  errors: string[];
  warnings: string[];
}

/** CDN-relative release.json path: releases/<packVersion>/release.json */
export function assertSafeReleasePath(releasePath: string, expectedPackVersion?: string): void {
  if (typeof releasePath !== "string" || !releasePath) {
    throw new VerifyChannelError("releasePath vide");
  }
  if (releasePath.includes("\\") || releasePath.includes("\0") || releasePath.includes("\r") || releasePath.includes("\n")) {
    throw new VerifyChannelError(`releasePath invalide: ${releasePath}`);
  }
  if (path.isAbsolute(releasePath) || /^[a-zA-Z]:/.test(releasePath) || releasePath.startsWith("//")) {
    throw new VerifyChannelError(`releasePath absolu refusé: ${releasePath}`);
  }
  if (releasePath.includes("..")) {
    throw new VerifyChannelError(`path traversal refusé: ${releasePath}`);
  }
  const m = /^releases\/([^/]+)\/release\.json$/.exec(releasePath);
  if (!m) {
    throw new VerifyChannelError(
      `releasePath doit matcher releases/<packVersion>/release.json (reçu: ${releasePath})`
    );
  }
  if (expectedPackVersion && m[1] !== expectedPackVersion) {
    throw new VerifyChannelError(
      `releasePath packVersion=${m[1]} != channel packVersion=${expectedPackVersion}`
    );
  }
}

export async function verifyChannelDescriptor(opts: VerifyChannelOptions): Promise<VerifyChannelResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const fail = (m: string) => {
    errors.push(m);
  };
  const root = path.resolve(opts.root);
  const channelFile = path.resolve(opts.channelFile);
  const allowUnsigned = opts.allowUnsignedDev !== false;

  let channel = "?";
  let packVersion = "?";
  let releaseSequence = 0;
  let releasePath = "?";
  let channelSignature: VerifyChannelResult["channelSignature"] = "FAIL";
  let releaseSignature: VerifyChannelResult["releaseSignature"] = "SKIPPED";

  let desc: ChannelDescriptor;
  try {
    desc = JSON.parse(await fs.readFile(channelFile, "utf8")) as ChannelDescriptor;
  } catch (e) {
    fail(`channel illisible: ${e instanceof Error ? e.message : String(e)}`);
    return {
      ok: false,
      channel,
      packVersion,
      releaseSequence,
      releasePath,
      channelSignature,
      releaseSignature,
      errors,
      warnings
    };
  }

  channel = String(desc.channel);
  packVersion = desc.packVersion;
  releaseSequence = desc.releaseSequence;
  releasePath = desc.releasePath;

  if (desc.schemaVersion !== CHANNEL_SCHEMA_VERSION) {
    fail(`channel schemaVersion attendu ${CHANNEL_SCHEMA_VERSION}, reçu ${desc.schemaVersion}`);
  }
  if (channel !== "dev" && channel !== "beta" && channel !== "stable") {
    fail(`channel inconnu: ${channel}`);
  }
  if (!packVersion) fail("packVersion manquant");
  if (!Number.isInteger(releaseSequence) || releaseSequence < 1) {
    fail(`releaseSequence invalide: ${releaseSequence}`);
  }

  try {
    assertSafeReleasePath(releasePath, packVersion);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }

  const basename = path.basename(channelFile, ".json");
  if (basename !== channel) {
    fail(`nom fichier channel (${basename}.json) != channel (${channel})`);
  }

  // --- channel signature ---
  const sig = desc.signature;
  if (!sig) {
    fail("signature channel manquante");
  } else if (sig.status === "unsigned-dev") {
    if (channel === "beta" || channel === "stable") {
      fail(`${channel}: unsigned-dev interdit`);
      channelSignature = "FAIL";
    } else if (!allowUnsigned) {
      fail("unsigned-dev channel refusé");
      channelSignature = "FAIL";
    } else {
      channelSignature = "UNSIGNED_DEV";
    }
  } else if (sig.status === "signed") {
    if (sig.algorithm !== "ed25519") fail(`algorithm channel: ${sig.algorithm}`);
    if (sig.payload !== CHANNEL_SIGNING_PAYLOAD_ID) {
      fail(`payload channel attendu ${CHANNEL_SIGNING_PAYLOAD_ID}`);
    }
    if (!sig.publicKeyId) fail("publicKeyId channel manquant");
    if (!sig.value) fail("signature.value channel manquant");
    const pem = sig.publicKeyId ? opts.trustedKeys?.[sig.publicKeyId] : undefined;
    if (!pem) {
      fail(`clé publique inconnue (channel): ${sig.publicKeyId}`);
      channelSignature = "FAIL";
    } else if (sig.value) {
      try {
        const payload = buildChannelSigningPayload({
          channel: desc.channel,
          packVersion: desc.packVersion,
          releaseSequence: desc.releaseSequence,
          releasePath: desc.releasePath,
          releaseSha256: desc.releaseSha256
        });
        if (!verifyEd25519Pem(pem, payload, sig.value)) {
          fail("signature channel Ed25519 INVALIDE");
          channelSignature = "FAIL";
        } else {
          channelSignature = "SIGNED_OK";
        }
      } catch (e) {
        fail(`payload channel: ${e instanceof Error ? e.message : String(e)}`);
        channelSignature = "FAIL";
      }
    }
  } else {
    fail(`signature.status channel inconnu: ${sig.status}`);
  }

  // --- pointed release ---
  const releaseJsonAbs = path.join(root, ...releasePath.split("/"));
  let releaseRaw: Buffer | null = null;
  try {
    releaseRaw = await fs.readFile(releaseJsonAbs);
  } catch {
    fail(`release.json absent: ${releasePath}`);
  }

  if (releaseRaw) {
    const actualSha = await hashFile(releaseJsonAbs, "sha256");
    if (actualSha !== desc.releaseSha256.toLowerCase()) {
      fail(`releaseSha256 mismatch: channel=${desc.releaseSha256} actual=${actualSha}`);
    }
    let release: {
      packVersion?: string;
      antiRollback?: { releaseSequence?: number | null };
      signature?: { status?: string };
    };
    try {
      release = JSON.parse(releaseRaw.toString("utf8"));
    } catch (e) {
      fail(`release.json parse: ${e instanceof Error ? e.message : String(e)}`);
      release = {};
    }
    if (release.packVersion && release.packVersion !== packVersion) {
      fail(`packVersion diverge channel=${packVersion} release=${release.packVersion}`);
    }
    const relSeq = release.antiRollback?.releaseSequence;
    if (relSeq !== releaseSequence) {
      fail(`releaseSequence diverge channel=${releaseSequence} release=${relSeq}`);
    }

    const releaseDir = path.dirname(releaseJsonAbs);
    const vr = await verifyRelease({
      releaseDir,
      trustedKeys: opts.trustedKeys,
      allowUnsignedDev: allowUnsigned
    });
    releaseSignature = vr.signature === "SIGNED_OK" || vr.signature === "UNSIGNED_DEV" || vr.signature === "FAIL"
      ? vr.signature
      : "FAIL";
    if (!vr.ok) {
      for (const e of vr.errors) fail(`release: ${e}`);
    }
    if ((channel === "beta" || channel === "stable") && releaseSignature !== "SIGNED_OK") {
      fail(`${channel} exige release signée (got ${releaseSignature})`);
    }
  }

  return {
    ok: errors.length === 0 && (channelSignature === "SIGNED_OK" || channelSignature === "UNSIGNED_DEV"),
    channel,
    packVersion,
    releaseSequence,
    releasePath,
    channelSignature,
    releaseSignature,
    errors,
    warnings
  };
}

export function formatVerifyChannelReport(r: VerifyChannelResult): string {
  const lines = [
    `Channel: ${r.channel}`,
    `Pack version: ${r.packVersion}`,
    `Release sequence: ${r.releaseSequence}`,
    `Release path: ${r.releasePath}`,
    `Channel signature: ${r.channelSignature}`,
    `Release signature: ${r.releaseSignature}`,
    `Channel verification: ${r.ok ? "OK" : "FAIL"}`
  ];
  if (r.warnings.length) {
    lines.push("Warnings:");
    for (const w of r.warnings) lines.push(`  - ${w}`);
  }
  if (r.errors.length) {
    lines.push("Errors:");
    for (const e of r.errors) lines.push(`  - ${e}`);
  }
  return lines.join("\n");
}
