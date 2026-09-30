/**
 * Local in-place production signing of a staged release.
 * Reuses SWEETCRAFT-RELEASE-SIGNATURE-V1 + ReleaseSigner — no channel, no upload.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  buildReleaseSigningPayload,
  RELEASE_SIGNING_PAYLOAD_ID
} from "./releasePayload.js";
import {
  defaultReleaseSigner,
  type ReleaseSigner,
  type TrustedKeys,
  UnsignedDevSigner
} from "./releaseSigning.js";
import { RELEASE_SCHEMA_VERSION } from "./types.js";
import { verifyRelease, type VerifyReleaseResult } from "./verifyRelease.js";

export class SignReleaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignReleaseError";
  }
}

export interface SignStagedReleaseOptions {
  /** Canonical staged release directory (mutated: release.json signature only). */
  releaseDir: string;
  /** Explicit signer; default from env (EnvEd25519Signer). */
  signer?: ReleaseSigner;
  /** Trusted public keys for post-sign verify. */
  trustedKeys: TrustedKeys;
  /**
   * Expected packVersion / sequence fail-closed checks.
   * If omitted, uses values already present in release.json.
   */
  expectPackVersion?: string;
  expectReleaseSequence?: number;
}

export interface SignStagedReleaseResult {
  releaseDir: string;
  packVersion: string;
  releaseSequence: number;
  publicKeyId: string;
  signatureStatus: "signed";
  verify: VerifyReleaseResult;
  publishableStable: boolean;
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Sign an already-staged release in place.
 * Only updates release.json signature.* (and status). Payload files unchanged.
 * Does NOT create/update channels, does NOT upload, does NOT invent crypto.
 */
export async function signStagedRelease(
  opts: SignStagedReleaseOptions
): Promise<SignStagedReleaseResult> {
  const releaseDir = path.resolve(opts.releaseDir);
  const releasePath = path.join(releaseDir, "release.json");

  if (!(await pathExists(releasePath))) {
    throw new SignReleaseError(`release.json introuvable: ${releasePath}`);
  }

  const pre = await verifyRelease({
    releaseDir,
    trustedKeys: opts.trustedKeys,
    allowUnsignedDev: true
  });
  if (!pre.ok || pre.releaseIntegrity !== "OK") {
    throw new SignReleaseError(
      `intégrité pre-sign KO: ${pre.errors.slice(0, 5).join("; ") || "unknown"}`
    );
  }

  const release = JSON.parse(await fs.readFile(releasePath, "utf8")) as Record<string, unknown> & {
    schemaVersion: number;
    packVersion: string;
    product: string;
    minecraft: string;
    fabricLoader: string;
    server: string;
    packManagerVersion: string;
    catalogSchemaVersion: number;
    manifestSchemaVersion: number;
    configBase: string;
    antiRollback?: { packVersion?: string; releaseSequence?: number | null; note?: string };
    artefacts: {
      clientManifest: { path: string; sha256: string };
      serverManifest: { path: string; sha256: string };
      checksums: { path: string; sha256: string };
    };
    signature?: {
      status?: string;
      algorithm?: string;
      publicKeyId?: string | null;
      payload?: string;
      value?: string | null;
      signer?: string;
    };
  };

  if (release.schemaVersion !== RELEASE_SCHEMA_VERSION) {
    throw new SignReleaseError(
      `release schema attendu ${RELEASE_SCHEMA_VERSION}, reçu ${release.schemaVersion}`
    );
  }
  if (opts.expectPackVersion && release.packVersion !== opts.expectPackVersion) {
    throw new SignReleaseError(
      `packVersion=${release.packVersion} attendu ${opts.expectPackVersion}`
    );
  }
  const seq = release.antiRollback?.releaseSequence;
  if (opts.expectReleaseSequence != null) {
    if (seq !== opts.expectReleaseSequence) {
      throw new SignReleaseError(
        `releaseSequence=${String(seq)} attendu ${opts.expectReleaseSequence}`
      );
    }
  }
  if (!Number.isInteger(seq) || (seq as number) < 1) {
    throw new SignReleaseError(`releaseSequence invalide pour signature prod: ${String(seq)}`);
  }
  if (release.signature?.status === "signed" && release.signature.value) {
    throw new SignReleaseError("release déjà signée — refus de re-signer (fail-closed)");
  }

  const signer = opts.signer ?? defaultReleaseSigner();
  if (signer instanceof UnsignedDevSigner) {
    throw new SignReleaseError(
      "signer unsigned-dev refusé — fournir Ed25519 (env PEM + PUBLIC_KEY_ID)"
    );
  }

  const signPayload = buildReleaseSigningPayload({
    product: release.product,
    packVersion: release.packVersion,
    minecraft: release.minecraft,
    fabricLoader: release.fabricLoader,
    server: release.server,
    packManagerVersion: release.packManagerVersion,
    catalogSchemaVersion: release.catalogSchemaVersion,
    manifestSchemaVersion: release.manifestSchemaVersion,
    releaseSchemaVersion: RELEASE_SCHEMA_VERSION,
    configBase: release.configBase,
    releaseSequence: seq as number,
    clientManifestSha256: release.artefacts.clientManifest.sha256,
    serverManifestSha256: release.artefacts.serverManifest.sha256,
    checksumsSha256: release.artefacts.checksums.sha256
  });

  const signed = await signer.sign(signPayload);
  if (!signed) {
    throw new SignReleaseError("signature échouée (clé absente ou refusée)");
  }

  const next = {
    ...release,
    antiRollback: {
      ...release.antiRollback,
      packVersion: release.packVersion,
      releaseSequence: seq,
      note:
        release.antiRollback?.note ??
        "candidate releaseSequence set at local staging; production-signed locally"
    },
    signature: {
      status: "signed" as const,
      algorithm: "ed25519" as const,
      publicKeyId: signed.publicKeyId,
      payload: RELEASE_SIGNING_PAYLOAD_ID,
      value: signed.signatureBase64,
      signer: signer.name
    }
  };

  await fs.writeFile(releasePath, stableJson(next), "utf8");

  const verify = await verifyRelease({
    releaseDir,
    trustedKeys: opts.trustedKeys,
    allowUnsignedDev: false
  });
  if (!verify.ok || verify.signature !== "SIGNED_OK") {
    throw new SignReleaseError(
      `verify post-sign KO (${verify.signature}): ${verify.errors.slice(0, 5).join("; ")}`
    );
  }
  if (!verify.publishableStable) {
    throw new SignReleaseError("post-sign: publishableStable=false inattendu");
  }

  return {
    releaseDir,
    packVersion: release.packVersion,
    releaseSequence: seq as number,
    publicKeyId: signed.publicKeyId,
    signatureStatus: "signed",
    verify,
    publishableStable: verify.publishableStable
  };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
