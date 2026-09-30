import { promises as fs } from "node:fs";
import path from "node:path";
import type { TrustedKeys } from "./releaseSigning.js";

/**
 * Load trusted public keys map: { publicKeyId: PEM }.
 * Never contains private keys.
 */
export async function loadTrustedKeys(opts?: {
  file?: string;
  /** Prefer explicit file; else SWEETCRAFT_TRUSTED_PUBLIC_KEYS_FILE. */
  fromEnv?: boolean;
}): Promise<TrustedKeys> {
  const file =
    opts?.file?.trim() ||
    (opts?.fromEnv !== false ? process.env.SWEETCRAFT_TRUSTED_PUBLIC_KEYS_FILE?.trim() : undefined);
  if (!file) return {};
  const raw = await fs.readFile(path.resolve(file), "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("trusted keys: JSON object attendu { publicKeyId: PEM }");
  }
  const out: TrustedKeys = {};
  for (const [id, pem] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof pem !== "string" || !pem.includes("BEGIN PUBLIC KEY")) {
      throw new Error(`trusted keys: entrée invalide pour ${id} (PEM public attendu)`);
    }
    if (pem.includes("PRIVATE KEY")) {
      throw new Error(`trusted keys: clé privée refusée pour ${id}`);
    }
    out[id] = pem;
  }
  return out;
}
