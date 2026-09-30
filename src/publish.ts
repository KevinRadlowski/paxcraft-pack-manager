import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  buildReleaseSigningPayload,
  RELEASE_SIGNING_PAYLOAD_ID,
  type ReleaseChannel
} from "./releasePayload.js";
import {
  defaultReleaseSigner,
  type ReleaseSigner,
  type TrustedKeys,
  UnsignedDevSigner
} from "./releaseSigning.js";
import { RELEASE_SCHEMA_VERSION } from "./types.js";
import { verifyRelease } from "./verifyRelease.js";
import { buildChannelDescriptor } from "./channel.js";
import { assertSafeReleasePath, verifyChannelDescriptor } from "./verifyChannel.js";
import { VERSION } from "./version.js";

export class PublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishError";
  }
}

export interface PublishOptions {
  /** Staged release directory (source of truth, never mutated). */
  releaseDir: string;
  channel: ReleaseChannel;
  sequence: number;
  /** Publish root (e.g. data/publish) containing releases/ and channels/. */
  outDir: string;
  /** Explicit signer; default from env. */
  signer?: ReleaseSigner;
  /** Required for cryptographic verification after sign. */
  trustedKeys?: TrustedKeys;
  /** Allow unsigned-dev on channel=dev only. */
  allowUnsignedDev?: boolean;
  /**
   * Test-only hooks (never used by CLI).
   * Allows simulating a concurrent publisher between release move and channel commit.
   */
  testHooks?: {
    afterReleaseMovedBeforeChannelCommit?: () => Promise<void>;
  };
}

export interface PublishResult {
  packVersion: string;
  channel: ReleaseChannel;
  releaseSequence: number;
  releaseDir: string;
  channelFile: string;
  releaseSignature: "SIGNED" | "UNSIGNED_DEV";
  channelSignature: "SIGNED" | "UNSIGNED_DEV";
  filesChecked: number;
  configsStaged: number;
  clientMods: number;
  serverMods: number;
  publishVerification: "OK";
  remoteUpload: "NOT_PERFORMED";
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

async function rmrf(dir: string) {
  await fs.rm(dir, { recursive: true, force: true });
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function assertChannel(ch: string): asserts ch is ReleaseChannel {
  if (ch !== "dev" && ch !== "beta" && ch !== "stable") {
    throw new PublishError(`--channel invalide (dev|beta|stable): ${ch}`);
  }
}

function assertSequence(n: number) {
  if (!Number.isInteger(n) || n < 1) {
    throw new PublishError(`--sequence doit être un entier positif (>=1), reçu: ${n}`);
  }
}

export async function readExistingChannelSequence(
  outDir: string,
  channel: ReleaseChannel
): Promise<number | null> {
  const f = path.join(outDir, "channels", `${channel}.json`);
  if (!(await pathExists(f))) return null;
  const desc = JSON.parse(await fs.readFile(f, "utf8")) as { releaseSequence?: number };
  if (!Number.isInteger(desc.releaseSequence) || (desc.releaseSequence as number) < 1) {
    throw new PublishError(`channel existant invalide (releaseSequence): ${f}`);
  }
  return desc.releaseSequence as number;
}

/**
 * Replace (or create) `dest` with the contents of `sourceFile`.
 *
 * Cross-platform strategy:
 * - Write/copy into a unique temp file in the same directory (same volume).
 * - POSIX: `rename(temp, dest)` atomically replaces an existing dest.
 * - Windows/NTFS: `rename` cannot overwrite; move dest aside to a unique
 *   backup, rename temp → dest, then unlink backup. On failure after dest was
 *   moved aside, attempt to restore the backup so the channel pointer is not lost.
 *
 * Best-effort atomicity of the pointer: readers may briefly see a missing file
 * on Windows during the swap window; they never see a partial JSON write.
 */
export async function replaceFileAtomically(sourceFile: string, dest: string): Promise<void> {
  const dir = path.dirname(dest);
  await fs.mkdir(dir, { recursive: true });
  const temp = path.join(dir, `.${path.basename(dest)}.${randomBytes(4).toString("hex")}.tmp`);
  await fs.copyFile(sourceFile, temp);

  const destExists = await pathExists(dest);
  if (!destExists) {
    try {
      await fs.rename(temp, dest);
      return;
    } catch (e) {
      await fs.unlink(temp).catch(() => undefined);
      throw e;
    }
  }

  // Destination exists — platform-specific replace
  if (process.platform === "win32") {
    const backup = path.join(dir, `.${path.basename(dest)}.${randomBytes(4).toString("hex")}.bak`);
    try {
      await fs.rename(dest, backup);
    } catch (e) {
      await fs.unlink(temp).catch(() => undefined);
      throw e;
    }
    try {
      await fs.rename(temp, dest);
    } catch (e) {
      // Restore previous channel pointer
      await fs.rename(backup, dest).catch(() => undefined);
      await fs.unlink(temp).catch(() => undefined);
      throw e;
    }
    await fs.unlink(backup).catch(() => undefined);
    return;
  }

  // POSIX: atomic replace
  try {
    await fs.rename(temp, dest);
  } catch (e) {
    await fs.unlink(temp).catch(() => undefined);
    throw e;
  }
}

function assertSequenceStillWins(sequence: number, observed: number | null, channel: ReleaseChannel) {
  if (observed !== null && sequence <= observed) {
    throw new PublishError(
      `CHANNEL_SEQUENCE_RACE: sequence ${sequence} n'est plus strictement supérieure à channel ${channel} (observé=${observed})`
    );
  }
}

/**
 * Publish a staged release into a local CDN tree (no network).
 * Staging source is never modified.
 */
export async function publishRelease(opts: PublishOptions): Promise<PublishResult> {
  assertChannel(opts.channel);
  assertSequence(opts.sequence);

  const channel = opts.channel;
  const sequence = opts.sequence;
  const allowUnsigned = !!opts.allowUnsignedDev;
  const stagingDir = path.resolve(opts.releaseDir);
  const outDir = path.resolve(opts.outDir);

  if (channel !== "dev" && allowUnsigned) {
    throw new PublishError("--allow-unsigned-dev uniquement autorisé avec --channel dev");
  }
  if ((channel === "beta" || channel === "stable") && allowUnsigned) {
    throw new PublishError(`${channel}: unsigned interdit`);
  }

  if (!(await pathExists(path.join(stagingDir, "release.json")))) {
    throw new PublishError(`staging release.json introuvable: ${stagingDir}`);
  }

  // --- integrity of staging (unsigned OK) ---
  const before = await verifyRelease({
    releaseDir: stagingDir,
    trustedKeys: opts.trustedKeys,
    allowUnsignedDev: true
  });
  if (!before.ok || before.releaseIntegrity !== "OK") {
    const sample = before.errors.slice(0, 3).join("; ");
    throw new PublishError(`intégrité staging KO: ${sample || "unknown"}`);
  }

  const stagingRelease = JSON.parse(await fs.readFile(path.join(stagingDir, "release.json"), "utf8")) as {
    packVersion: string;
    product: string;
    minecraft: string;
    fabricLoader: string;
    server: string;
    packManagerVersion: string;
    catalogSchemaVersion: number;
    manifestSchemaVersion: number;
    configBase: string;
    createdAt?: string;
    antiRollback?: { packVersion?: string; releaseSequence?: number | null; note?: string };
    artefacts: {
      clientManifest: { path: string; sha256: string };
      serverManifest: { path: string; sha256: string };
      checksums: { path: string; sha256: string };
    };
    stats?: { clientMods?: number; serverMods?: number; configsStaged?: number; excludedInCatalog?: number };
  };

  const packVersion = stagingRelease.packVersion;
  if (!packVersion) throw new PublishError("packVersion manquant dans staging");

  const stagingBase = path.basename(stagingDir);
  if (stagingBase !== packVersion) {
    throw new PublishError(
      `dossier staging (${stagingBase}) != release.packVersion (${packVersion})`
    );
  }

  // Early sequence check (fast-fail); authoritative check is at channel commit.
  const prevSeq = await readExistingChannelSequence(outDir, channel);
  assertSequenceStillWins(sequence, prevSeq, channel);

  const destReleaseDir = path.join(outDir, "releases", packVersion);
  if (await pathExists(destReleaseDir)) {
    throw new PublishError(
      `release déjà publiée (immutable): ${destReleaseDir}`
    );
  }

  // signer policy
  let signer = opts.signer ?? defaultReleaseSigner();
  const requireSigned = channel !== "dev" || !allowUnsigned;
  if (requireSigned) {
    if (signer instanceof UnsignedDevSigner) {
      throw new PublishError(
        channel === "dev"
          ? "signature requise pour dev (fournir clé Ed25519 ou --allow-unsigned-dev)"
          : `${channel}: signature Ed25519 obligatoire (SWEETCRAFT_RELEASE_ED25519_PRIVATE_KEY_PEM + PUBLIC_KEY_ID)`
      );
    }
  } else if (!opts.signer) {
    signer = new UnsignedDevSigner();
  }

  const tmpName = `.tmp-publish-${packVersion}-${randomBytes(4).toString("hex")}`;
  const tmpRoot = path.join(outDir, tmpName);
  const tmpReleaseDir = path.join(tmpRoot, "releases", packVersion);
  const tmpChannelDir = path.join(tmpRoot, "channels");
  const releasePath = `releases/${packVersion}/release.json`;
  assertSafeReleasePath(releasePath, packVersion);

  await fs.mkdir(outDir, { recursive: true });
  await rmrf(tmpRoot);

  /** True only after THIS transaction moved its own release into outDir/releases/. */
  let ownReleaseCommitted = false;
  try {
    await fs.mkdir(path.dirname(tmpReleaseDir), { recursive: true });
    await fs.cp(stagingDir, tmpReleaseDir, { recursive: true });

    const stagingChecksums = await fs.readFile(path.join(stagingDir, "checksums.json"));
    const copiedChecksums = await fs.readFile(path.join(tmpReleaseDir, "checksums.json"));
    if (!stagingChecksums.equals(copiedChecksums)) {
      throw new PublishError("checksums.json altéré pendant la copie");
    }

    const signPayload = buildReleaseSigningPayload({
      product: stagingRelease.product,
      packVersion,
      minecraft: stagingRelease.minecraft,
      fabricLoader: stagingRelease.fabricLoader,
      server: stagingRelease.server,
      packManagerVersion: stagingRelease.packManagerVersion,
      catalogSchemaVersion: stagingRelease.catalogSchemaVersion,
      manifestSchemaVersion: stagingRelease.manifestSchemaVersion,
      releaseSchemaVersion: RELEASE_SCHEMA_VERSION,
      configBase: stagingRelease.configBase,
      releaseSequence: sequence,
      clientManifestSha256: stagingRelease.artefacts.clientManifest.sha256,
      serverManifestSha256: stagingRelease.artefacts.serverManifest.sha256,
      checksumsSha256: stagingRelease.artefacts.checksums.sha256
    });

    const signed = await signer.sign(signPayload);
    if (requireSigned && !signed) {
      throw new PublishError(
        "signature échouée: clé absente (SWEETCRAFT_RELEASE_ED25519_PRIVATE_KEY_PEM + SWEETCRAFT_RELEASE_PUBLIC_KEY_ID)"
      );
    }
    const releaseSigStatus = signed ? ("signed" as const) : ("unsigned-dev" as const);
    if ((channel === "beta" || channel === "stable") && releaseSigStatus !== "signed") {
      throw new PublishError(`${channel}: release doit être signed`);
    }

    const publishedRelease = {
      schemaVersion: RELEASE_SCHEMA_VERSION,
      product: stagingRelease.product,
      packVersion,
      minecraft: stagingRelease.minecraft,
      fabricLoader: stagingRelease.fabricLoader,
      server: stagingRelease.server,
      createdAt: stagingRelease.createdAt ?? new Date().toISOString(),
      packManagerVersion: stagingRelease.packManagerVersion,
      catalogSchemaVersion: stagingRelease.catalogSchemaVersion,
      manifestSchemaVersion: stagingRelease.manifestSchemaVersion,
      configBase: stagingRelease.configBase,
      antiRollback: {
        packVersion,
        releaseSequence: sequence,
        note: "releaseSequence assigned at local publish; immutable for this packVersion"
      },
      artefacts: stagingRelease.artefacts,
      signature: {
        status: releaseSigStatus,
        algorithm: "ed25519" as const,
        publicKeyId: signed?.publicKeyId ?? null,
        payload: RELEASE_SIGNING_PAYLOAD_ID,
        value: signed?.signatureBase64 ?? null,
        signer: signer.name
      },
      stats: stagingRelease.stats ?? undefined,
      published: {
        channel,
        packManagerPublishVersion: VERSION,
        publishedAt: new Date().toISOString(),
        remoteUpload: "NOT_PERFORMED" as const
      }
    };
    await fs.writeFile(path.join(tmpReleaseDir, "release.json"), stableJson(publishedRelease), "utf8");

    const afterChecksums = await fs.readFile(path.join(tmpReleaseDir, "checksums.json"));
    if (!stagingChecksums.equals(afterChecksums)) {
      throw new PublishError("checksums.json ne doivent pas changer au publish");
    }

    const trustedForVerify: TrustedKeys = { ...(opts.trustedKeys ?? {}) };
    const maybePem = (signer as ReleaseSigner & { publicKeyPem?: string; publicKeyId?: string }).publicKeyPem;
    const maybeId = (signer as ReleaseSigner & { publicKeyId?: string }).publicKeyId;
    if (maybePem && maybeId) trustedForVerify[maybeId] = maybePem;

    const vr = await verifyRelease({
      releaseDir: tmpReleaseDir,
      trustedKeys: trustedForVerify,
      allowUnsignedDev: allowUnsigned || releaseSigStatus === "unsigned-dev"
    });
    if (!vr.ok) {
      throw new PublishError(`verify release après signature: ${vr.errors.slice(0, 3).join("; ")}`);
    }
    if (requireSigned && vr.signature !== "SIGNED_OK") {
      throw new PublishError(`signature release non valide après publish (${vr.signature})`);
    }

    await fs.mkdir(tmpChannelDir, { recursive: true });
    const channelSigner =
      releaseSigStatus === "unsigned-dev" ? new UnsignedDevSigner() : signer;
    if (requireSigned && channelSigner instanceof UnsignedDevSigner) {
      throw new PublishError("channel signature requise");
    }
    const channelDesc = await buildChannelDescriptor({
      channel,
      releaseDir: tmpReleaseDir,
      releasePath,
      releaseSequence: sequence,
      signer: channelSigner,
      allowUnsignedDev: allowUnsigned
    });
    const tmpChannelFile = path.join(tmpChannelDir, `${channel}.json`);
    await fs.writeFile(tmpChannelFile, stableJson(channelDesc), "utf8");

    const vc = await verifyChannelDescriptor({
      channelFile: tmpChannelFile,
      root: tmpRoot,
      trustedKeys: trustedForVerify,
      allowUnsignedDev: allowUnsigned || channelDesc.signature.status === "unsigned-dev"
    });
    if (!vc.ok) {
      throw new PublishError(`verify channel après signature: ${vc.errors.slice(0, 3).join("; ")}`);
    }

    // --- commit ---
    if (await pathExists(destReleaseDir)) {
      throw new PublishError(`race: release apparue pendant publish: ${destReleaseDir}`);
    }
    await fs.mkdir(path.join(outDir, "releases"), { recursive: true });
    await fs.mkdir(path.join(outDir, "channels"), { recursive: true });

    await fs.rename(tmpReleaseDir, destReleaseDir);
    ownReleaseCommitted = true;

    // Concurrent publisher may commit a higher sequence here (tests / real races).
    if (opts.testHooks?.afterReleaseMovedBeforeChannelCommit) {
      await opts.testHooks.afterReleaseMovedBeforeChannelCommit();
    }

    // Authoritative anti-rollback recheck immediately before replacing the pointer.
    const observedAtCommit = await readExistingChannelSequence(outDir, channel);
    try {
      assertSequenceStillWins(sequence, observedAtCommit, channel);
    } catch (e) {
      // Rollback ONLY this transaction's release — never another publisher's tree.
      await rmrf(destReleaseDir);
      ownReleaseCommitted = false;
      throw e;
    }

    const finalChannelFile = path.join(outDir, "channels", `${channel}.json`);
    try {
      await replaceFileAtomically(tmpChannelFile, finalChannelFile);
    } catch (e) {
      await rmrf(destReleaseDir);
      ownReleaseCommitted = false;
      throw new PublishError(
        `échec écriture channel (release annulée): ${e instanceof Error ? e.message : String(e)}`
      );
    }

    ownReleaseCommitted = false; // channel commit succeeded; do not roll back on later errors
    await rmrf(tmpRoot);

    const finalVc = await verifyChannelDescriptor({
      channelFile: finalChannelFile,
      root: outDir,
      trustedKeys: trustedForVerify,
      allowUnsignedDev: allowUnsigned || channelDesc.signature.status === "unsigned-dev"
    });
    if (!finalVc.ok) {
      throw new PublishError(`vérification finale KO: ${finalVc.errors.slice(0, 3).join("; ")}`);
    }

    return {
      packVersion,
      channel,
      releaseSequence: sequence,
      releaseDir: destReleaseDir,
      channelFile: finalChannelFile,
      releaseSignature: releaseSigStatus === "signed" ? "SIGNED" : "UNSIGNED_DEV",
      channelSignature: channelDesc.signature.status === "signed" ? "SIGNED" : "UNSIGNED_DEV",
      filesChecked: vr.filesChecked,
      configsStaged: stagingRelease.stats?.configsStaged ?? 0,
      clientMods: stagingRelease.stats?.clientMods ?? 0,
      serverMods: stagingRelease.stats?.serverMods ?? 0,
      publishVerification: "OK",
      remoteUpload: "NOT_PERFORMED"
    };
  } catch (e) {
    if (ownReleaseCommitted) {
      await rmrf(destReleaseDir).catch(() => undefined);
    }
    await rmrf(tmpRoot).catch(() => undefined);
    throw e;
  }
}

export function formatPublishReport(
  r: PublishResult,
  integrityBefore: string
): string {
  return [
    "SweetCraft Publisher",
    "",
    `Pack version: ${r.packVersion}`,
    `Channel: ${r.channel}`,
    `Release sequence: ${r.releaseSequence}`,
    "",
    `Release integrity before publish: ${integrityBefore}`,
    `Release signature: ${r.releaseSignature}`,
    `Channel signature: ${r.channelSignature}`,
    "",
    `Files: ${r.filesChecked}`,
    `Configs: ${r.configsStaged}`,
    `Client mods: ${r.clientMods}`,
    `Server mods: ${r.serverMods}`,
    "",
    "Published locally:",
    r.releaseDir,
    "",
    "Channel:",
    r.channelFile,
    "",
    `Publish verification: ${r.publishVerification}`,
    "",
    `REMOTE_UPLOAD: ${r.remoteUpload}`
  ].join("\n");
}

/** Hash helper used by tests. */
export function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}
