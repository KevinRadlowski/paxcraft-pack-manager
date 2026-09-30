import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const CLEAN = "H:/Users/kevin/Downloads/Dev/XBase/MODPACK FINAL CLEAN";
const CATALOG = "data/catalog.configs.json";
const OUT = "data/SYNC-05.1-provider-closure-matrix.json";

const catalog = JSON.parse(readFileSync(CATALOG, "utf8"));

function hasUrl(m) {
  return !!(m.modrinth_file_url || m.curseforge_file_url || m.author_file_url);
}

function side(m) {
  if (m.install_client && m.install_server) return "both";
  if (m.install_client) return "client";
  return "server";
}

function resolveDecision(m) {
  const url = hasUrl(m);
  const s = side(m);
  if (url) {
    return {
      disposition: "UPSTREAM_PROVIDER",
      kind: "PROVIDER",
      reason: "catalog has provider file URL"
    };
  }
  if (m.distribution_policy === "UPSTREAM_REQUIRED") {
    return {
      disposition: "PROVIDER_REQUIRED",
      kind: "UNRESOLVED",
      reason: "UPSTREAM_REQUIRED without file URL"
    };
  }
  if (m.distribution_policy === "SWEETCRAFT_ALLOWED") {
    return {
      disposition: "RELEASE_HOSTED",
      kind: "CUSTOM_LOCAL",
      cleanPath: s === "server" ? `server/mods/${m.jar}` : `client/mods/${m.jar}`
    };
  }
  if (m.distribution_policy === "UPSTREAM_PREFERRED") {
    return {
      disposition: "RELEASE_HOSTED",
      kind: "LOCAL_CLEAN",
      cleanPath: s === "server" ? `server/mods/${m.jar}` : `client/mods/${m.jar}`
    };
  }
  return { disposition: "UNKNOWN", kind: "UNRESOLVED", reason: m.distribution_policy };
}

function sha256File(abs) {
  return createHash("sha256").update(readFileSync(abs)).digest("hex");
}

const rows = catalog.mods.map(m => {
  const d = resolveDecision(m);
  let cleanSha = null;
  let cleanPresent = null;
  if (d.cleanPath) {
    const abs = path.join(CLEAN, d.cleanPath.replace(/\//g, path.sep));
    cleanPresent = existsSync(abs);
    if (cleanPresent) cleanSha = sha256File(abs);
  }
  return {
    mod_id: m.mod_id,
    jar: m.jar,
    side: side(m),
    sha256: m.sha256,
    size_bytes: m.size_bytes,
    distribution_policy: m.distribution_policy,
    hasProviderUrl: hasUrl(m),
    modrinth_file_url: m.modrinth_file_url ?? null,
    curseforge_file_url: m.curseforge_file_url ?? null,
    author_file_url: m.author_file_url ?? null,
    provider_resolution_status: m.provider_resolution_status ?? null,
    modrinth_project_id: m.modrinth_project_id ?? null,
    curseforge_project_id: m.curseforge_project_id ?? null,
    ...d,
    cleanShaMatch: cleanSha ? cleanSha === m.sha256 : null
  };
});

const providerRequired = rows.filter(r => r.disposition === "PROVIDER_REQUIRED");
const providerPending = rows.filter(r => !r.hasProviderUrl && r.disposition === "RELEASE_HOSTED");
const unresolved = rows.filter(r => r.kind === "UNRESOLVED");
const upstream = rows.filter(r => r.disposition === "UPSTREAM_PROVIDER");

const summary = {
  generatedAt: new Date().toISOString(),
  catalogMods: rows.length,
  clientInstall: catalog.mods.filter(m => m.install_client).length,
  serverInstall: catalog.mods.filter(m => m.install_server).length,
  upstreamProvider: upstream.length,
  releaseHostedLocalClean: rows.filter(r => r.kind === "LOCAL_CLEAN").length,
  releaseHostedCustom: rows.filter(r => r.kind === "CUSTOM_LOCAL").length,
  providerRequiredCount: providerRequired.length,
  providerPendingCount: providerPending.length,
  unresolvedCount: unresolved.length,
  providerRequired,
  providerPending,
  unresolved
};

writeFileSync(OUT, JSON.stringify({ summary, rows }, null, 2));
console.log(JSON.stringify(summary, null, 2));
