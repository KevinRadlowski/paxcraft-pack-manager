import type { ManifestResourcePack } from "./resourcePackTypes.js";
import {
  assertSafeResourcePackId,
  assertSafeResourcePackTargetPath,
  stagedResourcePackRelativePath
} from "./resourcePackPaths.js";

export class ManifestResourcePackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestResourcePackError";
  }
}

const SHA256_RE = /^[a-fA-F0-9]{64}$/;

/**
 * Validate public manifest resourcePacks for schema 6.
 * Does not open ZIP archives (origin-safe).
 */
export function validateManifestResourcePacks(
  packs: unknown,
  side: "client" | "server",
  opts?: { allowImplicitEmpty?: boolean }
): ManifestResourcePack[] {
  if (packs === undefined || packs === null) {
    if (opts?.allowImplicitEmpty) return [];
    throw new ManifestResourcePackError(`resourcePacks manquant (schema 6, ${side})`);
  }
  if (!Array.isArray(packs)) {
    throw new ManifestResourcePackError(`resourcePacks doit être un tableau (${side})`);
  }

  if (side === "server") {
    if (packs.length !== 0) {
      throw new ManifestResourcePackError(
        `server-manifest resourcePacks doit être [] (reçu ${packs.length} entrée(s))`
      );
    }
    return [];
  }

  const seen = new Set<string>();
  const out: ManifestResourcePack[] = [];

  for (const raw of packs) {
    if (!raw || typeof raw !== "object") {
      throw new ManifestResourcePackError("entrée resourcePack invalide");
    }
    const e = raw as Record<string, unknown>;

    if ("sourcePath" in e || "sourceAbsolutePath" in e) {
      throw new ManifestResourcePackError("sourcePath interdit dans manifest public");
    }
    for (const [k, v] of Object.entries(e)) {
      if (typeof v === "string" && (/^[a-zA-Z]:[\\/]/.test(v) || /^H:\\/i.test(v))) {
        throw new ManifestResourcePackError(`chemin local détecté dans manifest (${k})`);
      }
    }

    if (typeof e.id !== "string" || !e.id) {
      throw new ManifestResourcePackError("resourcePack.id manquant");
    }
    try {
      assertSafeResourcePackId(e.id);
    } catch (err) {
      throw new ManifestResourcePackError(err instanceof Error ? err.message : String(err));
    }
    if (seen.has(e.id)) {
      throw new ManifestResourcePackError(`resource pack id dupliqué: ${e.id}`);
    }
    seen.add(e.id);

    if (typeof e.displayName !== "string" || !e.displayName.trim()) {
      throw new ManifestResourcePackError(`displayName vide (${e.id})`);
    }
    if (typeof e.version !== "string" || !e.version.trim()) {
      throw new ManifestResourcePackError(`version vide (${e.id})`);
    }
    if (typeof e.targetPath !== "string") {
      throw new ManifestResourcePackError(`targetPath manquant (${e.id})`);
    }
    try {
      assertSafeResourcePackTargetPath(e.targetPath);
    } catch (err) {
      throw new ManifestResourcePackError(err instanceof Error ? err.message : String(err));
    }
    if (typeof e.sha256 !== "string" || !SHA256_RE.test(e.sha256)) {
      throw new ManifestResourcePackError(`sha256 invalide (${e.id})`);
    }
    if (typeof e.size !== "number" || !Number.isInteger(e.size) || e.size < 0) {
      throw new ManifestResourcePackError(`size invalide (${e.id})`);
    }
    if (typeof e.autoEnable !== "boolean") {
      throw new ManifestResourcePackError(`autoEnable non boolean (${e.id})`);
    }

    out.push({
      id: e.id,
      displayName: e.displayName.trim(),
      version: e.version.trim(),
      targetPath: e.targetPath,
      sha256: e.sha256.toLowerCase(),
      size: e.size,
      autoEnable: e.autoEnable
    });
  }

  return out;
}

export function expectedReleaseStoragePath(targetPath: string): string {
  return stagedResourcePackRelativePath(targetPath);
}
