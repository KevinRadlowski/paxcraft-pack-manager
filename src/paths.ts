import path from "node:path";
import { RELEASE_FILES_BASE } from "./types.js";

export class PathSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathSafetyError";
  }
}

/** Reject absolute paths, Windows drives, backslashes, and traversal for config/* paths. */
export function assertSafeConfigPath(configPath: string): void {
  if (typeof configPath !== "string" || !configPath) {
    throw new PathSafetyError("chemin config vide");
  }
  if (!configPath.startsWith("config/")) {
    throw new PathSafetyError(`chemin config invalide (doit commencer par config/): ${configPath}`);
  }
  if (configPath.includes("\\") || configPath.includes("\0")) {
    throw new PathSafetyError(`chemin config invalide (séparateurs): ${configPath}`);
  }
  if (path.isAbsolute(configPath) || /^[a-zA-Z]:/.test(configPath) || configPath.startsWith("//")) {
    throw new PathSafetyError(`chemin config absolu refusé: ${configPath}`);
  }
  const parts = configPath.split("/");
  if (parts.some(p => p === ".." || p === "" || p === ".")) {
    throw new PathSafetyError(`path traversal refusé: ${configPath}`);
  }
}

export function stagedConfigRelativePath(configPath: string): string {
  assertSafeConfigPath(configPath);
  const base = RELEASE_FILES_BASE.replace(/\/?$/, "/");
  return `${base}${configPath}`.replace(/\\/g, "/");
}
