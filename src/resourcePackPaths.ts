import path from "node:path";
import { RELEASE_FILES_BASE } from "./types.js";
import { PathSafetyError, assertSafeConfigPath } from "./paths.js";
import { assertSafeServerDatapackServerPath } from "./serverDatapackPaths.js";

/** Minecraft instance destination (POSIX). Must be under resourcepacks/. */
export function assertSafeResourcePackTargetPath(targetPath: string): void {
  if (typeof targetPath !== "string" || !targetPath) {
    throw new PathSafetyError("targetPath resource pack vide");
  }
  if (targetPath.includes("\\") || targetPath.includes("\0")) {
    throw new PathSafetyError(`targetPath backslash/null refusé: ${targetPath}`);
  }
  if (path.isAbsolute(targetPath) || /^[a-zA-Z]:/.test(targetPath) || targetPath.startsWith("//")) {
    throw new PathSafetyError(`targetPath absolu refusé: ${targetPath}`);
  }
  if (!targetPath.startsWith("resourcepacks/")) {
    throw new PathSafetyError(`targetPath doit commencer par resourcepacks/: ${targetPath}`);
  }
  const parts = targetPath.split("/");
  if (parts.some(p => p === ".." || p === "" || p === ".")) {
    throw new PathSafetyError(`path traversal refusé: ${targetPath}`);
  }
  if (!targetPath.toLowerCase().endsWith(".zip")) {
    throw new PathSafetyError(`targetPath doit finir par .zip: ${targetPath}`);
  }
}

/**
 * Relative path under files/ in a staged release:
 * config/... | resourcepacks/... | mods/<jar>
 */
export function assertSafeFilesPayloadPath(relAfterFiles: string): void {
  if (relAfterFiles.startsWith("config/")) {
    assertSafeConfigPath(relAfterFiles);
    return;
  }
  if (relAfterFiles.startsWith("resourcepacks/")) {
    assertSafeResourcePackTargetPath(relAfterFiles);
    return;
  }
  if (relAfterFiles.startsWith("world/datapacks/")) {
    assertSafeServerDatapackServerPath(relAfterFiles);
    return;
  }
  if (relAfterFiles.startsWith("mods/")) {
    // Release-hosted local mods (producer copies; launcher downloads via HTTPS URL)
    if (relAfterFiles.includes("\\") || relAfterFiles.includes("\0")) {
      throw new PathSafetyError(`mods path backslash/null refusé: ${relAfterFiles}`);
    }
    const parts = relAfterFiles.split("/");
    if (parts.length !== 2 || parts.some(p => p === ".." || p === "" || p === ".")) {
      throw new PathSafetyError(`mods path invalide: ${relAfterFiles}`);
    }
    const jar = parts[1]!;
    if (!jar.toLowerCase().endsWith(".jar")) {
      throw new PathSafetyError(`mods entry must be .jar: ${relAfterFiles}`);
    }
    if (jar.includes("/") || jar.includes("\\")) {
      throw new PathSafetyError(`mods jar name unsafe: ${relAfterFiles}`);
    }
    return;
  }
  throw new PathSafetyError(
    `chemin files/ non autorisé (config/, resourcepacks/, world/datapacks/ ou mods/): ${relAfterFiles}`
  );
}

/** Staged release path: files/<targetPath> for resource packs. */
export function stagedResourcePackRelativePath(targetPath: string): string {
  assertSafeResourcePackTargetPath(targetPath);
  const base = RELEASE_FILES_BASE.replace(/\/?$/, "/");
  return `${base}${targetPath}`.replace(/\\/g, "/");
}

export function assertSafeResourcePackId(id: string): void {
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(id)) {
    throw new PathSafetyError(`resource pack id invalide: ${id}`);
  }
}
