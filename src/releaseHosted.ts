/**
 * Release-hosted local mods (Pack Manager producer).
 *
 * LOCAL_CLEAN / CUSTOM_LOCAL jars are copied into the release tree under
 * files/mods/<filename> and receive a deterministic HTTPS URL baked into the
 * public manifest provider field. Launcher protocol unchanged (url + sha256 + size).
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Catalog, ModRecord } from "./types.js";
import { RELEASE_FILES_BASE } from "./types.js";
import {
  cleanRelativePathsToVerify,
  resolveArtifactSource,
  type ResolvedArtifactSource
} from "./artifactSource.js";
import {
  LocalCleanError,
  verifyLocalCleanArtifact,
  type LocalCleanVerified
} from "./localClean.js";
import { joinOriginPath, normalizeProductOriginUrl, OriginUrlError } from "./originUrl.js";
import { PathSafetyError } from "./paths.js";

export const RELEASE_HOSTED_PROVIDER_TYPE = "sweetcraft";

export interface ReleaseHostedPlanEntry {
  mod_id: string;
  jar: string;
  sha256: string;
  size_bytes: number;
  /** Path under files/: mods/<jar> */
  filesRelativePath: string;
  /** Full staged path: files/mods/<jar> */
  releaseStoragePath: string;
  /** Absolute HTTPS URL for manifest provider.url */
  publicUrl: string;
  sourceKind: "LOCAL_CLEAN" | "CUSTOM_LOCAL";
  cleanRelativePaths: string[];
}

export function assertSafeReleaseHostedModFileName(jar: string): void {
  if (typeof jar !== "string" || !jar) {
    throw new PathSafetyError("jar name vide");
  }
  if (jar.includes("/") || jar.includes("\\") || jar.includes("\0") || jar.includes("..")) {
    throw new PathSafetyError(`jar name unsafe: ${jar}`);
  }
  if (!jar.toLowerCase().endsWith(".jar")) {
    throw new PathSafetyError(`release-hosted mod must end with .jar: ${jar}`);
  }
  if (/^[a-zA-Z]:/.test(jar) || jar.startsWith("/")) {
    throw new PathSafetyError(`jar name absolute refused: ${jar}`);
  }
}

/** Relative path after files/ — e.g. mods/foo.jar */
export function assertSafeReleaseHostedModsPath(relAfterFiles: string): void {
  if (!relAfterFiles.startsWith("mods/")) {
    throw new PathSafetyError(`release-hosted path must start with mods/: ${relAfterFiles}`);
  }
  const rest = relAfterFiles.slice("mods/".length);
  assertSafeReleaseHostedModFileName(rest);
  if (rest.includes("/")) {
    throw new PathSafetyError(`nested mods/ paths refused: ${relAfterFiles}`);
  }
}

export function stagedReleaseHostedModPath(jar: string): string {
  assertSafeReleaseHostedModFileName(jar);
  const base = RELEASE_FILES_BASE.replace(/\/?$/, "/");
  return `${base}mods/${jar}`;
}

/**
 * Public CDN URL for a release-hosted mod:
 * {origin}/releases/{packVersion}/files/mods/{jar}
 */
export function publicReleaseHostedModUrl(
  productOrigin: string,
  packVersion: string,
  jar: string
): string {
  assertSafeReleaseHostedModFileName(jar);
  if (!/^\d+\.\d+\.\d+([.-][0-9A-Za-z.-]+)?$/.test(packVersion)) {
    throw new OriginUrlError(`packVersion invalide pour URL release-hosted: ${packVersion}`);
  }
  return joinOriginPath(
    normalizeProductOriginUrl(productOrigin),
    "releases",
    packVersion,
    "files",
    "mods",
    jar
  );
}

export function planReleaseHostedMods(
  catalog: Catalog,
  opts: { packVersion: string; productOrigin: string }
): ReleaseHostedPlanEntry[] {
  const origin = normalizeProductOriginUrl(opts.productOrigin);
  const seenJars = new Set<string>();
  const seenLower = new Set<string>();
  const out: ReleaseHostedPlanEntry[] = [];

  for (const m of catalog.mods) {
    const src = resolveArtifactSource(m);
    if (src.kind !== "LOCAL_CLEAN" && src.kind !== "CUSTOM_LOCAL") continue;

    assertSafeReleaseHostedModFileName(m.jar);
    if (seenJars.has(m.jar)) {
      throw new PathSafetyError(`duplicate release-hosted jar: ${m.jar}`);
    }
    const low = m.jar.toLowerCase();
    if (seenLower.has(low)) {
      throw new PathSafetyError(`case-colliding release-hosted jar: ${m.jar}`);
    }
    seenJars.add(m.jar);
    seenLower.add(low);

    const filesRelativePath = `mods/${m.jar}`;
    assertSafeReleaseHostedModsPath(filesRelativePath);

    out.push({
      mod_id: m.mod_id,
      jar: m.jar,
      sha256: m.sha256,
      size_bytes: m.size_bytes,
      filesRelativePath,
      releaseStoragePath: stagedReleaseHostedModPath(m.jar),
      publicUrl: publicReleaseHostedModUrl(origin, opts.packVersion, m.jar),
      sourceKind: src.kind,
      cleanRelativePaths: cleanRelativePathsToVerify(src, m)
    });
  }

  return out.sort((a, b) => a.mod_id.localeCompare(b.mod_id));
}

/** Inject HTTPS URLs into a catalog copy for manifest generation (producer-only mutation). */
export function applyReleaseHostedUrlsToCatalog(
  catalog: Catalog,
  plan: ReleaseHostedPlanEntry[]
): Catalog {
  const byId = new Map(plan.map(p => [p.mod_id, p]));
  const mods = catalog.mods.map(m => {
    const p = byId.get(m.mod_id);
    if (!p) return m;
    return {
      ...m,
      author_provider: RELEASE_HOSTED_PROVIDER_TYPE,
      author_file_url: p.publicUrl,
      author_filename: p.jar,
      provider_preference: "sweetcraft",
      provider_resolution_status: "RELEASE_HOSTED",
      provider_resolved_at: new Date().toISOString()
    } satisfies ModRecord;
  });
  return { ...catalog, mods };
}

export async function materializeReleaseHostedMod(
  cleanRoot: string,
  entry: ReleaseHostedPlanEntry,
  releaseTmpDir: string
): Promise<LocalCleanVerified> {
  if (!entry.cleanRelativePaths.length) {
    throw new LocalCleanError(`no CLEAN paths for ${entry.mod_id}`);
  }
  // Prefer first path (client for BOTH); verify all listed paths match same bytes
  let first: LocalCleanVerified | null = null;
  for (const rel of entry.cleanRelativePaths) {
    const v = await verifyLocalCleanArtifact(cleanRoot, {
      relativePath: rel,
      expectedFileName: entry.jar,
      expectedSha256: entry.sha256,
      expectedSize: entry.size_bytes
    });
    if (!first) first = v;
    else if (v.sha256 !== first.sha256 || v.size !== first.size) {
      throw new LocalCleanError(`CLEAN client/server twin mismatch for ${entry.jar}`);
    }
  }
  if (!first) throw new LocalCleanError(`failed to verify ${entry.mod_id}`);

  const dest = path.join(releaseTmpDir, ...entry.releaseStoragePath.split("/"));
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const data = await fs.readFile(first.absolutePath);
  const sha = createHash("sha256").update(data).digest("hex");
  if (sha !== entry.sha256.toLowerCase() || data.length !== entry.size_bytes) {
    throw new LocalCleanError(`byte copy pre-check failed for ${entry.jar}`);
  }
  await fs.writeFile(dest, data);
  const staged = await fs.readFile(dest);
  const stagedSha = createHash("sha256").update(staged).digest("hex");
  if (stagedSha !== entry.sha256.toLowerCase() || staged.length !== entry.size_bytes) {
    throw new LocalCleanError(`staged release-hosted mod not byte-identical: ${entry.jar}`);
  }
  return first;
}

export function countArtifactKinds(catalog: Catalog): {
  provider: number;
  localClean: number;
  customLocal: number;
  unresolved: number;
} {
  let provider = 0;
  let localClean = 0;
  let customLocal = 0;
  let unresolved = 0;
  for (const m of catalog.mods) {
    const s: ResolvedArtifactSource = resolveArtifactSource(m);
    if (s.kind === "PROVIDER") provider++;
    else if (s.kind === "LOCAL_CLEAN") localClean++;
    else if (s.kind === "CUSTOM_LOCAL") customLocal++;
    else unresolved++;
  }
  return { provider, localClean, customLocal, unresolved };
}
