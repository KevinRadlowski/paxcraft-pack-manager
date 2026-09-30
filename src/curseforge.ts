/**
 * CurseForge provider resolution — hash-exact, fail-closed.
 * API key from process.env.CURSEFORGE_API_KEY only; never serialized.
 */
import type { Catalog, ModRecord } from "./types.js";

const API = "https://api.curseforge.com/v1";

/** Official CurseForge / Overwolf CDN hosts for file downloads. */
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  "edge.forgecdn.net",
  "mediafilez.forgecdn.net",
  "media.forgecdn.net",
  "download.curseforge.com",
  "www.curseforge.com",
  "curseforge.com"
]);

type CFHash = { value: string; algo: number }; // 1=SHA1, 2=MD5
export interface CFFile {
  id: number;
  modId: number;
  displayName: string;
  fileName: string;
  downloadUrl?: string | null;
  fileLength: number;
  gameVersions: string[];
  hashes?: CFHash[];
  releaseType?: number;
}
interface CFResponse<T> {
  data: T;
}

export function curseforgeApiKeyPresent(): boolean {
  return typeof process.env.CURSEFORGE_API_KEY === "string" && process.env.CURSEFORGE_API_KEY.length > 0;
}

function apiKeyOrThrow(): string {
  const k = process.env.CURSEFORGE_API_KEY;
  if (!k) throw new Error("CURSEFORGE_AUTH_MISSING");
  return k;
}

export function sha1OfCfFile(f: CFFile): string | undefined {
  return f.hashes?.find(h => h.algo === 1)?.value?.toLowerCase();
}

/**
 * Select CF file by cryptographic identity only.
 * Filename/version/size alone are NEVER sufficient.
 */
export function chooseFileByHash(m: ModRecord, files: CFFile[]): CFFile | null {
  const sha1 = m.sha1?.toLowerCase();
  if (!sha1) return null;
  const exact = files.find(f => sha1OfCfFile(f) === sha1);
  if (!exact) return null;
  // Optional size coherence when CF reports length
  if (typeof exact.fileLength === "number" && exact.fileLength > 0 && m.size_bytes > 0) {
    if (exact.fileLength !== m.size_bytes) return null;
  }
  return exact;
}

/** @deprecated approximate matching — kept unused; do not call for production resolve. */
export function chooseFileApproximate(m: ModRecord, files: CFFile[]): CFFile | null {
  const byName = files.find(f => f.fileName === m.jar);
  if (byName) return byName;
  return (
    files.find(
      f =>
        f.fileName.toLowerCase().includes(m.version.toLowerCase()) && f.fileLength === m.size_bytes
    ) ?? null
  );
}

export function assertSafeCurseForgeDownloadUrl(url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`CurseForge URL invalide: ${url.slice(0, 80)}`);
  }
  if (u.protocol !== "https:") {
    throw new Error(`CurseForge URL must be HTTPS (got ${u.protocol})`);
  }
  const host = u.hostname.toLowerCase();
  const allowed =
    ALLOWED_DOWNLOAD_HOSTS.has(host) ||
    host.endsWith(".forgecdn.net") ||
    host.endsWith(".curseforge.com");
  if (!allowed) {
    throw new Error(`CurseForge download host non autorisé: ${host}`);
  }
  if (u.username || u.password) {
    throw new Error("CurseForge URL must not embed credentials");
  }
  // Reject obvious secret query params
  for (const key of u.searchParams.keys()) {
    if (/api[_-]?key|token|secret|password|auth/i.test(key)) {
      throw new Error(`CurseForge URL contains forbidden query param: ${key}`);
    }
  }
}

async function getFiles(projectId: number, gameVersion: string): Promise<CFFile[]> {
  const key = apiKeyOrThrow();
  const u = new URL(`${API}/mods/${projectId}/files`);
  u.searchParams.set("gameVersion", gameVersion);
  u.searchParams.set("pageSize", "50");
  // Also try without strict filter if needed — first pass with MC version
  const r = await fetch(u, {
    headers: { accept: "application/json", "x-api-key": key }
  });
  if (!r.ok) throw new Error(`CurseForge HTTP ${r.status}`);
  return ((await r.json()) as CFResponse<CFFile[]>).data;
}

async function getFilesPaged(projectId: number, gameVersion: string): Promise<CFFile[]> {
  const first = await getFiles(projectId, gameVersion);
  if (first.length) return first;
  // Fallback: list without gameVersion filter (still hash-matched later)
  const key = apiKeyOrThrow();
  const u = new URL(`${API}/mods/${projectId}/files`);
  u.searchParams.set("pageSize", "50");
  const r = await fetch(u, {
    headers: { accept: "application/json", "x-api-key": key }
  });
  if (!r.ok) throw new Error(`CurseForge HTTP ${r.status}`);
  return ((await r.json()) as CFResponse<CFFile[]>).data;
}

async function getDownloadUrl(projectId: number, fileId: number): Promise<string | null> {
  const key = apiKeyOrThrow();
  const r = await fetch(`${API}/mods/${projectId}/files/${fileId}/download-url`, {
    headers: { accept: "application/json", "x-api-key": key }
  });
  if (!r.ok) return null;
  return ((await r.json()) as CFResponse<string>).data;
}

export type FtbResolveStatus =
  | "FTB_PROVIDER_EXACT_MATCH"
  | "FTB_PROVIDER_NOT_FOUND"
  | "FTB_PROVIDER_HASH_MISMATCH"
  | "CURSEFORGE_AUTH_MISSING"
  | "CURSEFORGE_NO_PROJECT_ID"
  | "CURSEFORGE_NO_LOCAL_SHA1"
  | "CURSEFORGE_BAD_URL";

export interface FtbResolveRow {
  mod_id: string;
  jar: string;
  status: FtbResolveStatus;
  projectId: number | null;
  fileId: number | null;
  upstreamFileName: string | null;
  hashAlgo: "sha1" | null;
  urlResolved: boolean;
  detail: string;
}

/**
 * Resolve only mods that already have curseforge_project_id and no Modrinth URL,
 * using SHA-1 exact match against CLEAN catalog hashes.
 */
export async function resolveCurseForgeExact(
  c: Catalog,
  opts?: { onlyModIds?: Set<string> }
): Promise<{
  catalog: Catalog;
  rows: FtbResolveRow[];
  found: number;
  missing: number;
  needsApiKey: boolean;
  authMissing: boolean;
}> {
  const rows: FtbResolveRow[] = [];
  if (!curseforgeApiKeyPresent()) {
    const mods = c.mods.map(m => {
      if (opts?.onlyModIds && !opts.onlyModIds.has(m.mod_id)) return m;
      if (m.modrinth_file_url || m.curseforge_file_url) return m;
      if (!m.curseforge_project_id) return m;
      return { ...m, provider_resolution_status: "CURSEFORGE_API_KEY_REQUIRED" };
    });
    for (const m of c.mods) {
      if (opts?.onlyModIds && !opts.onlyModIds.has(m.mod_id)) continue;
      if (!m.curseforge_project_id) continue;
      if (m.modrinth_file_url || m.curseforge_file_url) continue;
      rows.push({
        mod_id: m.mod_id,
        jar: m.jar,
        status: "CURSEFORGE_AUTH_MISSING",
        projectId: m.curseforge_project_id ?? null,
        fileId: null,
        upstreamFileName: null,
        hashAlgo: null,
        urlResolved: false,
        detail: "CURSEFORGE_API_KEY absent from process environment"
      });
    }
    return {
      catalog: { ...c, mods },
      rows,
      found: 0,
      missing: rows.length,
      needsApiKey: true,
      authMissing: true
    };
  }

  let found = 0;
  let missing = 0;
  const mods: ModRecord[] = [];

  for (const m of c.mods) {
    if (opts?.onlyModIds && !opts.onlyModIds.has(m.mod_id)) {
      mods.push(m);
      continue;
    }
    // Keep Modrinth-resolved as-is
    if (m.modrinth_file_url) {
      mods.push(m);
      continue;
    }
    if (!m.curseforge_project_id) {
      if (opts?.onlyModIds?.has(m.mod_id)) {
        rows.push({
          mod_id: m.mod_id,
          jar: m.jar,
          status: "CURSEFORGE_NO_PROJECT_ID",
          projectId: null,
          fileId: null,
          upstreamFileName: null,
          hashAlgo: null,
          urlResolved: false,
          detail: "curseforge_project_id missing"
        });
        missing++;
      }
      mods.push(m);
      continue;
    }
    if (!m.sha1) {
      rows.push({
        mod_id: m.mod_id,
        jar: m.jar,
        status: "CURSEFORGE_NO_LOCAL_SHA1",
        projectId: m.curseforge_project_id,
        fileId: null,
        upstreamFileName: null,
        hashAlgo: null,
        urlResolved: false,
        detail: "local sha1 required for exact CF match"
      });
      missing++;
      mods.push(m);
      continue;
    }

    try {
      const files = await getFilesPaged(m.curseforge_project_id, c.generatedFor.minecraft);
      const exact = chooseFileByHash(m, files);
      if (!exact) {
        // Distinguish: CF returned files but none matched sha1
        const anySha = files.some(f => !!sha1OfCfFile(f));
        const status: FtbResolveStatus = anySha
          ? "FTB_PROVIDER_HASH_MISMATCH"
          : "FTB_PROVIDER_NOT_FOUND";
        rows.push({
          mod_id: m.mod_id,
          jar: m.jar,
          status,
          projectId: m.curseforge_project_id,
          fileId: null,
          upstreamFileName: null,
          hashAlgo: "sha1",
          urlResolved: false,
          detail: anySha
            ? `no CF file with sha1=${m.sha1} (and matching size)`
            : "no CF files / no sha1 hashes from API"
        });
        missing++;
        mods.push({ ...m, provider_resolution_status: status });
        continue;
      }

      let dl = exact.downloadUrl ?? (await getDownloadUrl(m.curseforge_project_id, exact.id));
      if (dl) {
        try {
          assertSafeCurseForgeDownloadUrl(dl);
        } catch (e) {
          rows.push({
            mod_id: m.mod_id,
            jar: m.jar,
            status: "CURSEFORGE_BAD_URL",
            projectId: m.curseforge_project_id,
            fileId: exact.id,
            upstreamFileName: exact.fileName,
            hashAlgo: "sha1",
            urlResolved: false,
            detail: e instanceof Error ? e.message : String(e)
          });
          missing++;
          mods.push(m);
          continue;
        }
      }

      found++;
      rows.push({
        mod_id: m.mod_id,
        jar: m.jar,
        status: "FTB_PROVIDER_EXACT_MATCH",
        projectId: m.curseforge_project_id,
        fileId: exact.id,
        upstreamFileName: exact.fileName,
        hashAlgo: "sha1",
        urlResolved: !!dl,
        detail: `sha1 exact match fileId=${exact.id}`
      });
      mods.push({
        ...m,
        provider_preference: "curseforge",
        curseforge_file_id: exact.id,
        curseforge_filename: exact.fileName,
        curseforge_file_url: dl ?? null,
        curseforge_game_versions: exact.gameVersions,
        provider_resolution_status: dl ? "RESOLVED" : "RESOLVED_NO_DIRECT_URL",
        provider_resolved_at: new Date().toISOString()
        // distribution_policy unchanged (UPSTREAM_REQUIRED stays)
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("CURSEFORGE_AUTH_MISSING")) {
        rows.push({
          mod_id: m.mod_id,
          jar: m.jar,
          status: "CURSEFORGE_AUTH_MISSING",
          projectId: m.curseforge_project_id,
          fileId: null,
          upstreamFileName: null,
          hashAlgo: null,
          urlResolved: false,
          detail: msg
        });
      } else {
        rows.push({
          mod_id: m.mod_id,
          jar: m.jar,
          status: "FTB_PROVIDER_NOT_FOUND",
          projectId: m.curseforge_project_id,
          fileId: null,
          upstreamFileName: null,
          hashAlgo: "sha1",
          urlResolved: false,
          detail: msg
        });
      }
      missing++;
      mods.push(m);
    }
  }

  return {
    catalog: { ...c, mods },
    rows,
    found,
    missing,
    needsApiKey: false,
    authMissing: false
  };
}

/** Legacy entry used by resolve-providers — now hash-exact only. */
export async function resolveCurseForge(
  c: Catalog
): Promise<{
  catalog: Catalog;
  found: number;
  missing: number;
  skipped: number;
  needsApiKey: boolean;
}> {
  if (!curseforgeApiKeyPresent()) {
    let missing = 0;
    let skipped = 0;
    const mods = c.mods.map(m => {
      if (m.modrinth_version_id || m.modrinth_file_url) return m;
      if (!m.curseforge_project_id) {
        skipped++;
        return m;
      }
      missing++;
      return { ...m, provider_resolution_status: "CURSEFORGE_API_KEY_REQUIRED" };
    });
    return { catalog: { ...c, mods }, found: 0, missing, skipped, needsApiKey: true };
  }

  const r = await resolveCurseForgeExact(c);
  let skipped = 0;
  for (const m of c.mods) {
    if (!m.curseforge_project_id && !m.modrinth_file_url) skipped++;
  }
  return {
    catalog: r.catalog,
    found: r.found,
    missing: r.missing,
    skipped,
    needsApiKey: false
  };
}
