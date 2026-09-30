/**
 * Fail-closed verification of jars under an authorized CLEAN root.
 * Producer-only — does not alter launcher protocol.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export class LocalCleanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalCleanError";
  }
}

export function assertSafeCleanRelativePath(relPosix: string): void {
  const n = relPosix.replace(/\\/g, "/");
  if (!n || n.includes("\0")) throw new LocalCleanError(`chemin CLEAN invalide: ${relPosix}`);
  if (n.startsWith("/") || /^[a-zA-Z]:/.test(n)) {
    throw new LocalCleanError(`chemin CLEAN absolu refusé: ${relPosix}`);
  }
  if (n.includes("\\")) throw new LocalCleanError(`backslash refusé: ${relPosix}`);
  const parts = n.split("/");
  if (parts.some(p => p === ".." || p === "")) {
    throw new LocalCleanError(`traversal / segment vide refusé: ${relPosix}`);
  }
}

export function resolveUnderCleanRoot(cleanRoot: string, relPosix: string): string {
  assertSafeCleanRelativePath(relPosix);
  const root = path.resolve(cleanRoot);
  const abs = path.resolve(root, ...relPosix.split("/"));
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new LocalCleanError(`échappement hors CLEAN root: ${relPosix}`);
  }
  return abs;
}

export interface LocalCleanExpectation {
  /** posix path relative to CLEAN root */
  relativePath: string;
  expectedFileName: string;
  expectedSha256: string;
  expectedSize: number;
}

export interface LocalCleanVerified {
  absolutePath: string;
  relativePath: string;
  sha256: string;
  size: number;
}

/**
 * Verify a single CLEAN-relative file matches catalog expectations exactly.
 */
export async function verifyLocalCleanArtifact(
  cleanRoot: string,
  expect: LocalCleanExpectation
): Promise<LocalCleanVerified> {
  const abs = resolveUnderCleanRoot(cleanRoot, expect.relativePath);
  const base = path.basename(abs);
  if (base !== expect.expectedFileName) {
    throw new LocalCleanError(
      `filename mismatch: expected ${expect.expectedFileName} got ${base} (${expect.relativePath})`
    );
  }

  let st;
  try {
    st = await fs.lstat(abs);
  } catch {
    throw new LocalCleanError(`fichier CLEAN absent: ${expect.relativePath}`);
  }
  if (st.isSymbolicLink()) {
    throw new LocalCleanError(`symlink CLEAN refusé: ${expect.relativePath}`);
  }
  if (!st.isFile()) {
    throw new LocalCleanError(`pas un fichier régulier: ${expect.relativePath}`);
  }

  const data = await fs.readFile(abs);
  if (data.length !== expect.expectedSize) {
    throw new LocalCleanError(
      `size mismatch ${expect.relativePath}: expected ${expect.expectedSize} got ${data.length}`
    );
  }
  const sha256 = createHash("sha256").update(data).digest("hex");
  if (sha256 !== expect.expectedSha256.toLowerCase()) {
    throw new LocalCleanError(
      `SHA-256 mismatch ${expect.relativePath}: expected ${expect.expectedSha256} got ${sha256}`
    );
  }

  return {
    absolutePath: abs,
    relativePath: expect.relativePath.replace(/\\/g, "/"),
    sha256,
    size: data.length
  };
}
