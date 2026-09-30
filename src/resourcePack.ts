import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import {
  assertSafeResourcePackId,
  assertSafeResourcePackTargetPath,
  stagedResourcePackRelativePath
} from "./resourcePackPaths.js";
import type {
  ManifestResourcePack,
  PreparedResourcePack,
  ResourcePackSourceConfig,
  ResourcePacksConfigFile
} from "./resourcePackTypes.js";

export type {
  ManifestResourcePack,
  PreparedResourcePack,
  ResourcePackSourceConfig,
  ResourcePacksConfigFile
} from "./resourcePackTypes.js";

export class ResourcePackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResourcePackError";
  }
}

function assertZipEntrySafe(entryName: string): void {
  const name = entryName.replace(/\\/g, "/");
  if (!name || name.includes("\0")) {
    throw new ResourcePackError(`entrée ZIP invalide: ${entryName}`);
  }
  if (name.startsWith("/") || name.startsWith("\\")) {
    throw new ResourcePackError(`entrée ZIP absolue refusée: ${entryName}`);
  }
  if (/^[a-zA-Z]:/.test(name)) {
    throw new ResourcePackError(`entrée ZIP drive letter refusée: ${entryName}`);
  }
  const parts = name.split("/");
  if (parts.some(p => p === "..")) {
    throw new ResourcePackError(`entrée ZIP path traversal refusée: ${entryName}`);
  }
}

/**
 * Validate ZIP structure for a SweetCraft resource pack (build/staging only).
 * Does not rewrite the archive.
 */
export function validateResourcePackZip(absZipPath: string): void {
  let zip: AdmZip;
  try {
    zip = new AdmZip(absZipPath);
  } catch (e) {
    throw new ResourcePackError(
      `ZIP illisible: ${absZipPath} (${e instanceof Error ? e.message : String(e)})`
    );
  }
  const entries = zip.getEntries();
  if (!entries.length) {
    throw new ResourcePackError("ZIP vide");
  }

  let hasRootMcmeta = false;
  let hasAssetsFile = false;

  for (const ent of entries) {
    const raw = ent.entryName;
    assertZipEntrySafe(raw);
    const name = raw.replace(/\\/g, "/");

    const attr = (ent as { attr?: number }).attr;
    if (typeof attr === "number") {
      const mode = (attr >>> 16) & 0xffff;
      if ((mode & 0xf000) === 0xa000) {
        throw new ResourcePackError(`symlink ZIP refusé: ${name}`);
      }
    }

    if (name === "pack.mcmeta") {
      hasRootMcmeta = true;
    }

    if (name.startsWith("assets/") && !ent.isDirectory) {
      hasAssetsFile = true;
    }
  }

  if (!hasRootMcmeta) {
    throw new ResourcePackError("pack.mcmeta absent à la racine du ZIP");
  }

  let mcmetaRaw: string;
  try {
    mcmetaRaw = zip.readAsText("pack.mcmeta");
  } catch {
    throw new ResourcePackError("pack.mcmeta illisible à la racine");
  }

  let mcmeta: { pack?: Record<string, unknown> };
  try {
    mcmeta = JSON.parse(mcmetaRaw) as { pack?: Record<string, unknown> };
  } catch {
    throw new ResourcePackError("pack.mcmeta JSON invalide");
  }
  if (!mcmeta || typeof mcmeta !== "object" || !mcmeta.pack || typeof mcmeta.pack !== "object") {
    throw new ResourcePackError("pack.mcmeta sans objet pack");
  }

  const pack = mcmeta.pack;
  const hasLegacy = typeof pack.pack_format === "number";
  const hasMin = typeof pack.min_format === "number" || Array.isArray(pack.min_format);
  const hasMax = typeof pack.max_format === "number" || Array.isArray(pack.max_format);
  if (!hasLegacy && !(hasMin && hasMax)) {
    throw new ResourcePackError(
      "pack.mcmeta: exiger pack_format (legacy) ou min_format+max_format (moderne)"
    );
  }

  const hasAssetsDir = entries.some(e => {
    const n = e.entryName.replace(/\\/g, "/");
    return n === "assets" || n === "assets/" || n.startsWith("assets/");
  });
  if (!hasAssetsDir) {
    throw new ResourcePackError("assets/ absent du ZIP");
  }
  if (!hasAssetsFile) {
    throw new ResourcePackError("assets/ vide (aucun fichier)");
  }
}

export async function hashFileBytes(absPath: string): Promise<{ sha256: string; size: number; data: Buffer }> {
  const data = await fs.readFile(absPath);
  return {
    data,
    size: data.length,
    sha256: createHash("sha256").update(data).digest("hex")
  };
}

export function validateSourceConfigEntry(raw: ResourcePackSourceConfig): void {
  assertSafeResourcePackId(raw.id);
  if (!raw.displayName?.trim()) throw new ResourcePackError(`displayName vide (${raw.id})`);
  if (!raw.version?.trim()) throw new ResourcePackError(`version vide (${raw.id})`);
  if (raw.target !== "CLIENT") {
    throw new ResourcePackError(`target doit être CLIENT (${raw.id})`);
  }
  if (typeof raw.autoEnable !== "boolean") {
    throw new ResourcePackError(`autoEnable doit être boolean (${raw.id})`);
  }
  if (!raw.sourcePath?.trim()) throw new ResourcePackError(`sourcePath vide (${raw.id})`);
  assertSafeResourcePackTargetPath(raw.targetPath);
}

/**
 * Load + validate + hash resource packs from a config file.
 * Catalog stays independent (schema 2 unchanged).
 */
export async function prepareResourcePacksFromConfig(
  configPath: string
): Promise<PreparedResourcePack[]> {
  let parsed: ResourcePacksConfigFile;
  try {
    parsed = JSON.parse(await fs.readFile(configPath, "utf8")) as ResourcePacksConfigFile;
  } catch (e) {
    throw new ResourcePackError(
      `resourcepacks config illisible: ${configPath} (${e instanceof Error ? e.message : String(e)})`
    );
  }
  if (!parsed || !Array.isArray(parsed.resourcePacks)) {
    throw new ResourcePackError("resourcepacks.json: resourcePacks[] requis");
  }
  return prepareResourcePacks(parsed.resourcePacks, path.dirname(path.resolve(configPath)));
}

export async function prepareResourcePacks(
  entries: ResourcePackSourceConfig[],
  resolveBaseDir: string
): Promise<PreparedResourcePack[]> {
  const seen = new Set<string>();
  const out: PreparedResourcePack[] = [];

  for (const raw of entries) {
    validateSourceConfigEntry(raw);
    if (seen.has(raw.id)) {
      throw new ResourcePackError(`resource pack id dupliqué: ${raw.id}`);
    }
    seen.add(raw.id);

    const abs = path.isAbsolute(raw.sourcePath)
      ? path.resolve(raw.sourcePath)
      : path.resolve(resolveBaseDir, raw.sourcePath);

    let st;
    try {
      st = await fs.lstat(abs);
    } catch {
      throw new ResourcePackError(`source absente: ${abs}`);
    }
    if (st.isSymbolicLink()) {
      throw new ResourcePackError(`source symlink refusée: ${abs}`);
    }
    if (!st.isFile()) {
      throw new ResourcePackError(`source n'est pas un fichier: ${abs}`);
    }
    if (!abs.toLowerCase().endsWith(".zip")) {
      throw new ResourcePackError(`source non ZIP: ${abs}`);
    }

    validateResourcePackZip(abs);
    const { sha256, size } = await hashFileBytes(abs);

    out.push({
      id: raw.id,
      displayName: raw.displayName.trim(),
      version: raw.version.trim(),
      target: "CLIENT",
      targetPath: raw.targetPath.replace(/\\/g, "/"),
      autoEnable: raw.autoEnable,
      sha256,
      size,
      sourceAbsolutePath: abs,
      releaseStoragePath: stagedResourcePackRelativePath(raw.targetPath)
    });
  }

  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function toManifestResourcePack(p: PreparedResourcePack): ManifestResourcePack {
  return {
    id: p.id,
    displayName: p.displayName,
    version: p.version,
    targetPath: p.targetPath,
    sha256: p.sha256,
    size: p.size,
    autoEnable: p.autoEnable
  };
}

/** Assert a public manifest entry has no local path leakage. */
export function assertPublicManifestPackClean(entry: Record<string, unknown>): void {
  for (const k of Object.keys(entry)) {
    if (/source/i.test(k)) {
      throw new ResourcePackError(`champ source interdit dans manifest public: ${k}`);
    }
    const v = entry[k];
    if (typeof v === "string" && (/^[a-zA-Z]:\\/.test(v) || v.startsWith("H:\\"))) {
      throw new ResourcePackError(`chemin local détecté dans manifest public (${k})`);
    }
  }
}
