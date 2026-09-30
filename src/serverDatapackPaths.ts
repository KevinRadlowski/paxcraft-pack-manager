import path from "node:path";
import { RELEASE_FILES_BASE } from "./types.js";
import { PathSafetyError } from "./paths.js";

/** Dedicated-server destination root for a folder datapack. */
export function assertSafeServerDatapackTargetPath(targetPath: string): void {
  if (typeof targetPath !== "string" || !targetPath) {
    throw new PathSafetyError("targetPath datapack vide");
  }
  if (targetPath.includes("\\") || targetPath.includes("\0")) {
    throw new PathSafetyError(`targetPath backslash/null refusé: ${targetPath}`);
  }
  if (path.isAbsolute(targetPath) || /^[a-zA-Z]:/.test(targetPath) || targetPath.startsWith("//")) {
    throw new PathSafetyError(`targetPath absolu refusé: ${targetPath}`);
  }
  if (!targetPath.startsWith("world/datapacks/")) {
    throw new PathSafetyError(`targetPath doit commencer par world/datapacks/: ${targetPath}`);
  }
  const parts = targetPath.split("/");
  if (parts.some(p => p === ".." || p === "" || p === ".")) {
    throw new PathSafetyError(`path traversal refusé: ${targetPath}`);
  }
  if (parts.length < 3) {
    throw new PathSafetyError(`targetPath datapack trop court: ${targetPath}`);
  }
}

/** File path relative to dedicated server root. */
export function assertSafeServerDatapackServerPath(serverRelativePath: string): void {
  if (typeof serverRelativePath !== "string" || !serverRelativePath) {
    throw new PathSafetyError("chemin datapack serveur vide");
  }
  if (serverRelativePath.includes("\\") || serverRelativePath.includes("\0")) {
    throw new PathSafetyError(`chemin datapack backslash/null refusé: ${serverRelativePath}`);
  }
  if (path.isAbsolute(serverRelativePath) || /^[a-zA-Z]:/.test(serverRelativePath)) {
    throw new PathSafetyError(`chemin datapack absolu refusé: ${serverRelativePath}`);
  }
  if (!serverRelativePath.startsWith("world/datapacks/")) {
    throw new PathSafetyError(`chemin datapack hors world/datapacks/: ${serverRelativePath}`);
  }
  const parts = serverRelativePath.split("/");
  if (parts.some(p => p === ".." || p === "" || p === ".")) {
    throw new PathSafetyError(`path traversal refusé: ${serverRelativePath}`);
  }
}

export function assertSafeServerDatapackId(id: string): void {
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(id)) {
    throw new PathSafetyError(`server datapack id invalide: ${id}`);
  }
}

/** Staged release path: files/world/datapacks/... */
export function stagedServerDatapackFileRelativePath(serverRelativePath: string): string {
  assertSafeServerDatapackServerPath(serverRelativePath);
  const base = RELEASE_FILES_BASE.replace(/\/?$/, "/");
  return `${base}${serverRelativePath}`.replace(/\\/g, "/");
}
