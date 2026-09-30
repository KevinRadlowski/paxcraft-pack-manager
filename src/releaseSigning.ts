import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";

/**
 * Ed25519 signing abstraction for release artefacts.
 * Private keys must come from env/CI — never commit secrets, never log PEM values.
 */
export interface ReleaseSigner {
  readonly name: string;
  /** Returns null when running unsigned-dev (no key available). */
  sign(payload: Buffer): Promise<{ signatureBase64: string; publicKeyId: string } | null>;
}

export function sha256Buffer(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function publicKeyIdFromDer(publicKeyDer: Buffer): string {
  return sha256Buffer(publicKeyDer).slice(0, 16);
}

function requirePublicKeyId(): string {
  const id = process.env.SWEETCRAFT_RELEASE_PUBLIC_KEY_ID?.trim();
  if (!id) {
    throw new Error(
      "SWEETCRAFT_RELEASE_PUBLIC_KEY_ID est obligatoire pour une signature réelle (ex: sweetcraft-release-2026-01)"
    );
  }
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/i.test(id)) {
    throw new Error("SWEETCRAFT_RELEASE_PUBLIC_KEY_ID invalide");
  }
  return id;
}

/**
 * Dev/CI signer: SWEETCRAFT_RELEASE_ED25519_PRIVATE_KEY_PEM + SWEETCRAFT_RELEASE_PUBLIC_KEY_ID.
 * Never logs the PEM.
 */
export class EnvEd25519Signer implements ReleaseSigner {
  readonly name = "env-ed25519";
  async sign(payload: Buffer) {
    const pem = process.env.SWEETCRAFT_RELEASE_ED25519_PRIVATE_KEY_PEM?.trim();
    if (!pem) return null;
    const publicKeyId = requirePublicKeyId();
    try {
      const privateKey = createPrivateKey(pem);
      const signature = cryptoSign(null, payload, privateKey);
      return {
        signatureBase64: signature.toString("base64"),
        publicKeyId
      };
    } catch {
      // Avoid leaking PEM via error messages.
      throw new Error("échec signature Ed25519 (clé privée invalide ou incompatible)");
    }
  }
}

export class UnsignedDevSigner implements ReleaseSigner {
  readonly name = "unsigned-dev";
  async sign(_payload: Buffer) {
    return null;
  }
}

export function defaultReleaseSigner(): ReleaseSigner {
  if (process.env.SWEETCRAFT_RELEASE_ED25519_PRIVATE_KEY_PEM?.trim()) {
    return new EnvEd25519Signer();
  }
  return new UnsignedDevSigner();
}

/** Test helper: ephemeral keypair signer (never persists keys). */
export function createEphemeralEd25519Signer(publicKeyId = "test-ephemeral-key"): ReleaseSigner & {
  publicKeyPem: string;
  publicKeyId: string;
} {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return {
    name: "ephemeral-ed25519",
    publicKeyPem,
    publicKeyId,
    async sign(payload: Buffer) {
      const signature = cryptoSign(null, payload, privateKey);
      return { signatureBase64: signature.toString("base64"), publicKeyId };
    }
  };
}

export function verifyEd25519Pem(publicKeyPem: string, payload: Buffer, signatureBase64: string): boolean {
  try {
    const key = createPublicKey(publicKeyPem);
    return cryptoVerify(null, payload, key, Buffer.from(signatureBase64, "base64"));
  } catch {
    return false;
  }
}

export type TrustedKeys = Record<string, string>; // publicKeyId -> PEM
