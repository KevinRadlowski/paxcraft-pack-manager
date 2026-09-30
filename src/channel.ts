import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  buildChannelSigningPayload,
  CHANNEL_SCHEMA_VERSION,
  CHANNEL_SIGNING_PAYLOAD_ID,
  type ChannelDescriptor,
  type ReleaseChannel
} from "./releasePayload.js";
import type { ReleaseSigner } from "./releaseSigning.js";
import { hashFile } from "./io.js";
import { assertSafeReleasePath } from "./verifyChannel.js";

export interface BuildChannelOptions {
  channel: ReleaseChannel;
  /** Absolute path to the release directory (contains release.json). */
  releaseDir: string;
  /** CDN-relative path to release.json, e.g. releases/0.1.0/release.json */
  releasePath: string;
  /** Positive integer assigned at publish time for this channel. */
  releaseSequence: number;
  signer: ReleaseSigner;
  /** Allow unsigned-dev channel when channel=dev. */
  allowUnsignedDev?: boolean;
}

/**
 * Build a signed (or unsigned-dev) channel pointer. Does not write to disk —
 * publication tooling will upload the result.
 */
export async function buildChannelDescriptor(opts: BuildChannelOptions): Promise<ChannelDescriptor> {
  if (!Number.isInteger(opts.releaseSequence) || opts.releaseSequence < 1) {
    throw new Error("releaseSequence must be a positive integer at publish time");
  }
  assertSafeReleasePath(opts.releasePath);

  const releaseJsonPath = path.join(opts.releaseDir, "release.json");
  const releaseRaw = await fs.readFile(releaseJsonPath);
  const release = JSON.parse(releaseRaw.toString("utf8")) as {
    packVersion: string;
    antiRollback?: { releaseSequence?: number | null };
    signature?: { status?: string };
  };
  if (opts.channel === "stable" || opts.channel === "beta") {
    if (release.signature?.status !== "signed") {
      throw new Error(`${opts.channel} channel requires a signed release (got ${release.signature?.status ?? "missing"})`);
    }
  }
  if (
    release.antiRollback?.releaseSequence != null &&
    release.antiRollback.releaseSequence !== opts.releaseSequence
  ) {
    throw new Error(
      `channel sequence ${opts.releaseSequence} != release sequence ${release.antiRollback.releaseSequence}`
    );
  }

  const releaseSha256 = createHash("sha256").update(releaseRaw).digest("hex");
  const hashed = await hashFile(releaseJsonPath, "sha256");
  if (hashed !== releaseSha256) {
    throw new Error("internal hash mismatch for release.json");
  }

  const releasePath = opts.releasePath.replace(/\\/g, "/");
  assertSafeReleasePath(releasePath, release.packVersion);

  const payload = buildChannelSigningPayload({
    channel: opts.channel,
    packVersion: release.packVersion,
    releaseSequence: opts.releaseSequence,
    releasePath,
    releaseSha256
  });
  const signed = await opts.signer.sign(payload);
  const status = signed ? ("signed" as const) : ("unsigned-dev" as const);
  if ((opts.channel === "stable" || opts.channel === "beta") && status !== "signed") {
    throw new Error(`${opts.channel} channel descriptor must be signed`);
  }
  if (status === "unsigned-dev" && opts.channel === "dev" && !opts.allowUnsignedDev) {
    throw new Error("dev channel unsigned requires allowUnsignedDev");
  }
  if (status === "unsigned-dev" && opts.channel !== "dev") {
    throw new Error("unsigned-dev channel only allowed for dev");
  }

  return {
    schemaVersion: CHANNEL_SCHEMA_VERSION,
    channel: opts.channel,
    packVersion: release.packVersion,
    releaseSequence: opts.releaseSequence,
    releasePath,
    releaseSha256,
    signature: {
      status,
      algorithm: "ed25519",
      publicKeyId: signed?.publicKeyId ?? null,
      payload: CHANNEL_SIGNING_PAYLOAD_ID,
      value: signed?.signatureBase64 ?? null
    }
  };
}
