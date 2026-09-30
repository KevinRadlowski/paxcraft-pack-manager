/**
 * Staging artifact source resolution (Pack Manager producer only).
 * Does NOT change launcher manifest/release/channel schemas.
 *
 * PROVIDER — download via catalog provider URL (normal path).
 * LOCAL_CLEAN — exact jar under authorized CLEAN root (hash/size fail-closed).
 * CUSTOM_LOCAL — pack-owned / SweetCraft-allowed local jar (same fail-closed checks).
 */
import type { DistributionPolicy, ModRecord } from "./types.js";

export type ArtifactSourceKind = "PROVIDER" | "LOCAL_CLEAN" | "CUSTOM_LOCAL";

export type ArtifactSourceDecision =
  | "LOCAL_CLEAN_ALLOWED"
  | "CUSTOM_LOCAL_ALLOWED"
  | "PROVIDER_REQUIRED"
  | "REDISTRIBUTION_BLOCKED"
  | "PROVIDER";

export interface ResolvedArtifactSource {
  mod_id: string;
  jar: string;
  sha256: string;
  size_bytes: number;
  kind: ArtifactSourceKind | "UNRESOLVED";
  decision: ArtifactSourceDecision | "UNRESOLVED";
  providerUrl: string | null;
  reason: string;
  /** Relative path under CLEAN root when local/custom (posix). */
  cleanRelativePath: string | null;
  side: "client" | "server" | "both";
}

function hasProviderUrl(m: ModRecord): boolean {
  return !!(m.modrinth_file_url || m.curseforge_file_url || m.author_file_url);
}

function providerUrl(m: ModRecord): string | null {
  return m.modrinth_file_url || m.curseforge_file_url || m.author_file_url || null;
}

function installSide(m: ModRecord): "client" | "server" | "both" {
  if (m.install_client && m.install_server) return "both";
  if (m.install_client) return "client";
  return "server";
}

/** Policies that may be packaged from an exact local CLEAN jar by the producer. */
export function allowsLocalCleanRedistribution(policy: DistributionPolicy): boolean {
  return policy === "SWEETCRAFT_ALLOWED" || policy === "UPSTREAM_PREFERRED";
}

/** Policies that forbid SweetCraft redistributing the jar octets (must use upstream URL). */
export function forbidsLocalRedistribution(policy: DistributionPolicy): boolean {
  return policy === "UPSTREAM_REQUIRED" || policy === "BLOCKED" || policy === "LEGAL_REVIEW";
}

/**
 * Deterministic staging source for one mod.
 * Never falls back PROVIDER→LOCAL because a download failed.
 */
export function resolveArtifactSource(m: ModRecord): ResolvedArtifactSource {
  const url = providerUrl(m);
  const side = installSide(m);
  const base = {
    mod_id: m.mod_id,
    jar: m.jar,
    sha256: m.sha256,
    size_bytes: m.size_bytes,
    providerUrl: url,
    side
  };

  if (url) {
    return {
      ...base,
      kind: "PROVIDER",
      decision: "PROVIDER",
      reason: "catalog has provider file URL — PROVIDER is authoritative",
      cleanRelativePath: null
    };
  }

  // No URL
  if (m.distribution_policy === "BLOCKED" || m.distribution_policy === "LEGAL_REVIEW") {
    return {
      ...base,
      kind: "UNRESOLVED",
      decision: "REDISTRIBUTION_BLOCKED",
      reason: `no provider URL and distribution_policy=${m.distribution_policy}`,
      cleanRelativePath: null
    };
  }

  if (m.distribution_policy === "UPSTREAM_REQUIRED") {
    return {
      ...base,
      kind: "UNRESOLVED",
      decision: "PROVIDER_REQUIRED",
      reason:
        "UPSTREAM_REQUIRED without file URL — must resolve CurseForge/Modrinth/author URL; LOCAL_CLEAN redistribution forbidden",
      cleanRelativePath: null
    };
  }

  if (m.distribution_policy === "SWEETCRAFT_ALLOWED") {
    const rel =
      side === "server"
        ? `server/mods/${m.jar}`
        : side === "client"
          ? `client/mods/${m.jar}`
          : `client/mods/${m.jar}`; // both: client path is canonical for identical C+S jars
    return {
      ...base,
      kind: "CUSTOM_LOCAL",
      decision: "CUSTOM_LOCAL_ALLOWED",
      reason: "SWEETCRAFT_ALLOWED + no provider URL — custom/local CLEAN jar with fail-closed hash/size",
      cleanRelativePath: rel
    };
  }

  if (m.distribution_policy === "UPSTREAM_PREFERRED") {
    const rel =
      side === "server"
        ? `server/mods/${m.jar}`
        : `client/mods/${m.jar}`;
    return {
      ...base,
      kind: "LOCAL_CLEAN",
      decision: "LOCAL_CLEAN_ALLOWED",
      reason:
        "UPSTREAM_PREFERRED + no provider URL — LOCAL_CLEAN allowed for producer packaging when exact CLEAN jar matches catalog hash",
      cleanRelativePath: rel
    };
  }

  return {
    ...base,
    kind: "UNRESOLVED",
    decision: "UNRESOLVED",
    reason: `unhandled distribution_policy=${m.distribution_policy}`,
    cleanRelativePath: null
  };
}

export function resolveAllArtifactSources(mods: ModRecord[]): ResolvedArtifactSource[] {
  return mods.map(resolveArtifactSource).sort((a, b) => a.mod_id.localeCompare(b.mod_id));
}

/** For BOTH jars, also verify server twin when present. */
export function cleanRelativePathsToVerify(
  resolved: ResolvedArtifactSource,
  mod: ModRecord
): string[] {
  if (!resolved.cleanRelativePath) return [];
  if (mod.install_client && mod.install_server) {
    return [`client/mods/${mod.jar}`, `server/mods/${mod.jar}`];
  }
  if (mod.install_server && !mod.install_client) return [`server/mods/${mod.jar}`];
  return [`client/mods/${mod.jar}`];
}
