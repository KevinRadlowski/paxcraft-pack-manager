/**
 * Server supplemental / opaque files — Pack Manager producer inventory.
 * NOT part of launcher manifest schema 6.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { assertSafeCleanRelativePath, resolveUnderCleanRoot } from "./localClean.js";

export type LuckPermsLibsClassification =
  | "LUCKPERMS_LIBS_REQUIRED_DISTRIBUTION"
  | "LUCKPERMS_LIBS_REGENERABLE"
  | "LUCKPERMS_LIBS_RUNTIME_CACHE"
  | "UNKNOWN";

export type DatapackStatus = "DATAPACK_SERVER_DISTRIBUTED" | "DATAPACK_SERVER_NOT_DISTRIBUTED";

export interface SupplementalFileEntry {
  /** posix path relative to CLEAN root */
  relativePath: string;
  sha256: string;
  size: number;
  role: "luckperms_lib" | "datapack_file";
}

/**
 * LuckPerms Fabric downloads Maven deps into mods/luckperms/libs on first boot,
 * verifies checksums, and writes *-remapped.jar via jar-relocator.
 * The CLEAN copies are a warm cache — regenerable when the server has network + write access.
 * SweetCraft does NOT distribute them as ModRecords or required release artefacts.
 */
export function classifyLuckPermsLibs(): {
  classification: LuckPermsLibsClassification;
  rationale: string;
} {
  return {
    classification: "LUCKPERMS_LIBS_REGENERABLE",
    rationale:
      "LuckPerms DependencyManager downloads jars into mods/luckperms/libs on first startup (checksum-verified) and generates *-remapped.jar. Offline/fresh servers need network once or a writable libs dir; SweetCraft need not redistribute these 22 jars."
  };
}

export async function inventoryLuckPermsLibs(
  cleanRoot: string
): Promise<{ count: number; files: SupplementalFileEntry[] }> {
  const relDir = "server/mods/luckperms/libs";
  assertSafeCleanRelativePath(relDir + "/x.jar");
  const absDir = resolveUnderCleanRoot(cleanRoot, relDir);
  let names: string[] = [];
  try {
    names = (await fs.readdir(absDir)).filter(n => n.toLowerCase().endsWith(".jar")).sort();
  } catch {
    return { count: 0, files: [] };
  }
  const files: SupplementalFileEntry[] = [];
  for (const name of names) {
    const rel = `${relDir}/${name}`;
    const abs = resolveUnderCleanRoot(cleanRoot, rel);
    const data = await fs.readFile(abs);
    files.push({
      relativePath: rel,
      sha256: createHash("sha256").update(data).digest("hex"),
      size: data.length,
      role: "luckperms_lib"
    });
  }
  return { count: files.length, files };
}

export async function inventoryDatapack(
  cleanRoot: string,
  datapackRel = "server/world/datapacks/SweetCraft_Quest_Support"
): Promise<{
  status: DatapackStatus;
  proof: string;
  files: SupplementalFileEntry[];
}> {
  const mcmetaRel = `${datapackRel}/pack.mcmeta`;
  try {
    assertSafeCleanRelativePath(mcmetaRel);
    const absMeta = resolveUnderCleanRoot(cleanRoot, mcmetaRel);
    await fs.access(absMeta);
  } catch {
    return {
      status: "DATAPACK_SERVER_NOT_DISTRIBUTED",
      proof: "datapack pack.mcmeta absent under CLEAN",
      files: []
    };
  }

  const absRoot = resolveUnderCleanRoot(cleanRoot, datapackRel);
  const files: SupplementalFileEntry[] = [];
  async function walk(dir: string, relBase: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const rel = `${relBase}/${e.name}`.replace(/\\/g, "/");
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(abs, rel);
      } else if (e.isFile()) {
        const data = await fs.readFile(abs);
        files.push({
          relativePath: rel,
          sha256: createHash("sha256").update(data).digest("hex"),
          size: data.length,
          role: "datapack_file"
        });
      }
    }
  }
  await walk(absRoot, datapackRel);
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  return {
    status: "DATAPACK_SERVER_DISTRIBUTED",
    proof: `${files.length} pack-owned datapack file(s) under ${datapackRel}; staged via serverDatapacks[] when data/serverDatapacks.json is configured`,
    files
  };
}
