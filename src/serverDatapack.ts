import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  assertSafeServerDatapackId,
  assertSafeServerDatapackServerPath,
  assertSafeServerDatapackTargetPath
} from "./serverDatapackPaths.js";
import { PathSafetyError } from "./paths.js";
import type {
  ManifestServerDatapack,
  ManifestServerDatapackFile,
  PreparedServerDatapack,
  ServerDatapackSourceConfig,
  ServerDatapacksConfigFile
} from "./serverDatapackTypes.js";

export class ServerDatapackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerDatapackError";
  }
}

function sha256buf(b: Buffer): string {
  return createHash("sha256").update(b).digest("hex");
}

export function computeDatapackTreeSha256(files: ManifestServerDatapackFile[]): string {
  const lines = [...files]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map(f => `${f.sha256.toLowerCase()}\t${f.size}\t${f.path}`);
  return sha256buf(Buffer.from(lines.join("\n") + "\n", "utf8"));
}

async function inventoryFolderDatapack(
  sourceAbsolutePath: string,
  targetPath: string
): Promise<ManifestServerDatapackFile[]> {
  assertSafeServerDatapackTargetPath(targetPath);
  const root = path.resolve(sourceAbsolutePath);
  let st;
  try {
    st = await fs.stat(root);
  } catch {
    throw new ServerDatapackError(`source datapack introuvable: ${sourceAbsolutePath}`);
  }
  if (!st.isDirectory()) {
    throw new ServerDatapackError(`source datapack doit être un dossier: ${sourceAbsolutePath}`);
  }

  const mcmeta = path.join(root, "pack.mcmeta");
  try {
    await fs.access(mcmeta);
  } catch {
    throw new ServerDatapackError(`pack.mcmeta absent: ${sourceAbsolutePath}`);
  }

  const files: ManifestServerDatapackFile[] = [];
  async function walk(dir: string, relBase: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const rel = `${relBase}/${e.name}`.replace(/\\/g, "/");
      const abs = path.join(dir, e.name);
      if (e.isSymbolicLink()) {
        throw new ServerDatapackError(`symlink refusé dans datapack: ${rel}`);
      }
      if (e.isDirectory()) {
        await walk(abs, rel);
      } else if (e.isFile()) {
        assertSafeServerDatapackServerPath(rel);
        const data = await fs.readFile(abs);
        files.push({ path: rel, sha256: sha256buf(data), size: data.length });
      }
    }
  }
  await walk(root, targetPath.replace(/\/$/, ""));
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export async function prepareServerDatapacksFromConfig(
  configFile: string
): Promise<PreparedServerDatapack[]> {
  let raw: ServerDatapacksConfigFile;
  try {
    raw = JSON.parse(await fs.readFile(path.resolve(configFile), "utf8")) as ServerDatapacksConfigFile;
  } catch (e) {
    throw new ServerDatapackError(
      `config datapacks illisible: ${configFile} (${e instanceof Error ? e.message : String(e)})`
    );
  }
  if (!Array.isArray(raw.serverDatapacks)) {
    throw new ServerDatapackError("serverDatapacks[] manquant");
  }

  const seenIds = new Set<string>();
  const out: PreparedServerDatapack[] = [];
  for (const cfg of raw.serverDatapacks) {
    await prepareOne(cfg, seenIds, out);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

async function prepareOne(
  cfg: ServerDatapackSourceConfig,
  seenIds: Set<string>,
  out: PreparedServerDatapack[]
): Promise<void> {
  assertSafeServerDatapackId(cfg.id);
  if (seenIds.has(cfg.id)) {
    throw new ServerDatapackError(`duplicate server datapack id: ${cfg.id}`);
  }
  seenIds.add(cfg.id);
  assertSafeServerDatapackTargetPath(cfg.targetPath);
  const sourceAbsolutePath = path.resolve(cfg.sourcePath);
  const files = await inventoryFolderDatapack(sourceAbsolutePath, cfg.targetPath);
  if (!files.length) {
    throw new ServerDatapackError(`datapack vide: ${cfg.id}`);
  }
  const totalBytes = files.reduce((s, f) => s + f.size, 0);
  out.push({
    id: cfg.id,
    displayName: cfg.displayName,
    version: cfg.version,
    targetPath: cfg.targetPath,
    apply: cfg.apply ?? "force",
    fileCount: files.length,
    totalBytes,
    treeSha256: computeDatapackTreeSha256(files),
    files,
    sourceAbsolutePath
  });
}

export function toManifestServerDatapack(p: PreparedServerDatapack): ManifestServerDatapack {
  return {
    id: p.id,
    displayName: p.displayName,
    version: p.version,
    targetPath: p.targetPath,
    apply: p.apply,
    fileCount: p.fileCount,
    totalBytes: p.totalBytes,
    treeSha256: p.treeSha256,
    files: p.files.map(f => ({ path: f.path, sha256: f.sha256, size: f.size }))
  };
}

export function assertPublicManifestDatapackClean(obj: Record<string, unknown>): void {
  if ("sourcePath" in obj || "sourceAbsolutePath" in obj) {
    throw new ServerDatapackError("manifest datapack leak: sourcePath interdit");
  }
}
