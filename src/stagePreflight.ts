/**
 * Stage preflight — verify all artefacts are materializable WITHOUT building a publishable release.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Catalog } from "./types.js";
import { releaseReady, validate } from "./validate.js";
import { CATALOG_SCHEMA_VERSION, MANIFEST_SCHEMA_VERSION } from "./types.js";
import { buildClientManifest, buildServerManifest, isManifestBlockedPolicy } from "./manifest.js";
import {
  cleanRelativePathsToVerify,
  resolveAllArtifactSources,
  type ResolvedArtifactSource
} from "./artifactSource.js";
import { LocalCleanError, verifyLocalCleanArtifact } from "./localClean.js";
import {
  classifyLuckPermsLibs,
  inventoryDatapack,
  inventoryLuckPermsLibs
} from "./serverSupplemental.js";
import {
  prepareResourcePacksFromConfig,
  type PreparedResourcePack
} from "./resourcePack.js";
import { ResourcePackError } from "./resourcePack.js";
import { prepareServerDatapacksFromConfig } from "./serverDatapack.js";
import { ServerDatapackError } from "./serverDatapack.js";
import { resolveSourceConfigFile, type ManifestConfigEntry } from "./stage.js";

/** Canonical CLEAN SweetCraft FR resource pack (anti-regression vs historical v1.0). */
export const CLEAN_RESOURCEPACK_EXPECTED = {
  id: "sweetcraft-fr",
  fileName: "SweetCraft-FR-v2.7-DETAIL-PASS.zip",
  sha256: "f491caae5e1485d3e9c709f44cc81099ce6e742c48a9a33818740d643b09250f",
  size: 400806,
  versionSubstring: "2.7"
} as const;

export interface StagePreflightOptions {
  catalog: Catalog;
  cleanRoot: string;
  /** Pack root for config files (usually CLEAN client or a merged root). */
  configSourceRoot: string;
  resourcePacksFile: string;
  /** Optional server datapacks config (defaults to data/serverDatapacks.json when present). */
  serverDatapacksFile?: string;
  packVersion?: string;
  /** Optional HEAD check for provider URLs (off by default — deterministic local). */
  checkProviderHttp?: boolean;
}

export interface StagePreflightResult {
  verdict: "STAGE_PREFLIGHT_READY" | "STAGE_PREFLIGHT_BLOCKED";
  blockers: string[];
  warnings: string[];
  protocolImpact: "NO_PROTOCOL_CHANGE";
  counts: {
    provider: number;
    localClean: number;
    customLocal: number;
    unresolved: number;
    catalogMods: number;
  };
  sources: ResolvedArtifactSource[];
  resourcePack: {
    ok: boolean;
    sha256?: string;
    size?: number;
    detail: string;
  };
  luckperms: ReturnType<typeof classifyLuckPermsLibs> & { inventoried: number };
  datapack: { status: string; proof: string; fileCount: number };
  serverDatapacks: { ok: boolean; count: number; detail: string; treeSha256?: string };
  configsChecked: number;
}

function unionConfigs(
  client: { configs: ManifestConfigEntry[] },
  server: { configs: ManifestConfigEntry[] }
): ManifestConfigEntry[] {
  const map = new Map<string, ManifestConfigEntry>();
  for (const cf of [...client.configs, ...server.configs]) {
    if (isManifestBlockedPolicy(cf.policy)) continue;
    map.set(cf.path, cf);
  }
  return [...map.values()];
}

export async function runStagePreflight(opts: StagePreflightOptions): Promise<StagePreflightResult> {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const catalog = opts.catalog;
  const packVersion = opts.packVersion ?? "0.1.3";

  if (catalog.schemaVersion !== CATALOG_SCHEMA_VERSION) {
    blockers.push(`catalog schema ${catalog.schemaVersion} != ${CATALOG_SCHEMA_VERSION}`);
  }

  const ready = releaseReady(catalog);
  if (!ready.ready) {
    for (const b of ready.blocking.slice(0, 20)) {
      blockers.push(`RELEASE_READY ${b.code} ${b.subject}`);
    }
  }

  const sources = resolveAllArtifactSources(catalog.mods);
  let provider = 0;
  let localClean = 0;
  let customLocal = 0;
  let unresolved = 0;

  for (const s of sources) {
    if (s.kind === "PROVIDER") provider++;
    else if (s.kind === "LOCAL_CLEAN") localClean++;
    else if (s.kind === "CUSTOM_LOCAL") customLocal++;
    else {
      unresolved++;
      blockers.push(`UNRESOLVED_ARTIFACT ${s.mod_id}: ${s.decision} — ${s.reason}`);
    }
  }

  // Verify local/custom jars fail-closed
  for (const s of sources) {
    if (s.kind !== "LOCAL_CLEAN" && s.kind !== "CUSTOM_LOCAL") continue;
    const mod = catalog.mods.find(m => m.mod_id === s.mod_id)!;
    const rels = cleanRelativePathsToVerify(s, mod);
    for (const rel of rels) {
      try {
        await verifyLocalCleanArtifact(opts.cleanRoot, {
          relativePath: rel,
          expectedFileName: mod.jar,
          expectedSha256: mod.sha256,
          expectedSize: mod.size_bytes
        });
      } catch (e) {
        blockers.push(
          `LOCAL_VERIFY ${s.mod_id} ${rel}: ${e instanceof LocalCleanError ? e.message : String(e)}`
        );
      }
    }
  }

  // Resource pack — must be v2.7 CLEAN exact
  let prepared: PreparedResourcePack[] = [];
  let rpOk = false;
  let rpDetail = "";
  let rpSha: string | undefined;
  let rpSize: number | undefined;
  try {
    prepared = await prepareResourcePacksFromConfig(opts.resourcePacksFile);
    const rp = prepared.find(p => p.id === CLEAN_RESOURCEPACK_EXPECTED.id) ?? prepared[0];
    if (!rp) {
      blockers.push("resourcepack: none prepared");
      rpDetail = "empty";
    } else {
      rpSha = rp.sha256;
      rpSize = rp.size;
      const base = path.basename(rp.sourceAbsolutePath);
      if (base.includes("v1.0") || rp.version === "1.0") {
        blockers.push("resourcepack: historical v1.0 source forbidden for CLEAN 0.1.3");
      }
      if (!base.includes("v2.7") && !rp.version.includes("2.7")) {
        blockers.push(`resourcepack: expected v2.7, got file=${base} version=${rp.version}`);
      }
      if (rp.sha256 !== CLEAN_RESOURCEPACK_EXPECTED.sha256 || rp.size !== CLEAN_RESOURCEPACK_EXPECTED.size) {
        blockers.push(
          `resourcepack hash/size: expected ${CLEAN_RESOURCEPACK_EXPECTED.sha256}/${CLEAN_RESOURCEPACK_EXPECTED.size} got ${rp.sha256}/${rp.size}`
        );
      } else {
        rpOk = true;
        rpDetail = `ok ${base}`;
      }
    }
  } catch (e) {
    blockers.push(
      `resourcepack prepare: ${e instanceof ResourcePackError ? e.message : String(e)}`
    );
    rpDetail = "prepare failed";
  }

  // Configs present under CLEAN client and/or server config trees
  const clientM = buildClientManifest(catalog, packVersion, {
    generatedAt: "preflight",
    resourcePacks: prepared.map(p => ({
      id: p.id,
      displayName: p.displayName,
      version: p.version,
      targetPath: p.targetPath,
      sha256: p.sha256,
      size: p.size,
      autoEnable: p.autoEnable
    }))
  });
  const serverM = buildServerManifest(catalog, packVersion, { generatedAt: "preflight" });
  if (clientM.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    blockers.push("client manifest schema mismatch");
  }
  const configs = unionConfigs(
    clientM as { configs: ManifestConfigEntry[] },
    serverM as { configs: ManifestConfigEntry[] }
  );
  let configsChecked = 0;
  const { createHash } = await import("node:crypto");
  for (const cf of configs) {
    const roots = [
      opts.configSourceRoot,
      path.join(opts.cleanRoot, "client"),
      path.join(opts.cleanRoot, "server")
    ];
    let ok = false;
    let lastErr = "";
    for (const root of roots) {
      try {
        const abs = resolveSourceConfigFile(root, cf.path);
        const data = await fs.readFile(abs);
        const actual = createHash("sha256").update(data).digest("hex");
        if (actual !== cf.sha256.toLowerCase()) {
          lastErr = `hash mismatch under ${root}`;
          continue;
        }
        ok = true;
        configsChecked++;
        break;
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
      }
    }
    if (!ok) blockers.push(`config missing/unsafe ${cf.path}: ${lastErr}`);
  }

  // Duplicate mod targets
  const clientFiles = new Set<string>();
  for (const m of clientM.mods as Array<{ file: string; id: string }>) {
    if (clientFiles.has(m.file)) blockers.push(`duplicate client file ${m.file}`);
    clientFiles.add(m.file);
  }

  const lpClass = classifyLuckPermsLibs();
  const lpInv = await inventoryLuckPermsLibs(opts.cleanRoot);
  if (lpClass.classification === "LUCKPERMS_LIBS_REGENERABLE") {
    warnings.push(
      `LuckPerms libs: ${lpInv.count} inventoried under CLEAN but classified REGENERABLE — not required in release`
    );
  }

  const dp = await inventoryDatapack(opts.cleanRoot);
  warnings.push(`datapack: ${dp.status} — ${dp.proof}`);

  let sdpOk = false;
  let sdpCount = 0;
  let sdpDetail = "not configured";
  let sdpTree: string | undefined;
  let sdpFile = opts.serverDatapacksFile;
  if (!sdpFile) {
    const defaultSdp = path.resolve("data/serverDatapacks.json");
    try {
      await fs.access(defaultSdp);
      sdpFile = defaultSdp;
    } catch {
      /* optional */
    }
  }
  if (sdpFile) {
    try {
      const prepared = await prepareServerDatapacksFromConfig(sdpFile);
      sdpCount = prepared.length;
      sdpOk = prepared.length > 0;
      sdpTree = prepared[0]?.treeSha256;
      sdpDetail = prepared.map(p => `${p.id} files=${p.fileCount}`).join("; ");
    } catch (e) {
      blockers.push(
        `server datapacks: ${e instanceof ServerDatapackError ? e.message : String(e)}`
      );
      sdpDetail = "prepare failed";
    }
  }

  // Protocol confirmation
  const protocolImpact = "NO_PROTOCOL_CHANGE" as const;

  // Note: LOCAL_CLEAN/CUSTOM jars are producer-verified; launcher still needs a downloadable
  // URL at publish time unless a future lot adds release-hosted mod URLs (protocol change).
  if (localClean + customLocal > 0) {
    warnings.push(
      `${localClean + customLocal} local/custom artifact(s) verified on CLEAN; stageRelease with --clean materializes them as release-hosted files/mods/* with HTTPS URLs (NO_PROTOCOL_CHANGE)`
    );
  }

  const findings = validate(catalog);
  if (findings.some(f => f.severity === "ERROR")) {
    blockers.push("catalog validate still has ERROR");
  }

  const uniqueBlockers = [...new Set(blockers)];
  return {
    verdict: uniqueBlockers.length === 0 ? "STAGE_PREFLIGHT_READY" : "STAGE_PREFLIGHT_BLOCKED",
    blockers: uniqueBlockers,
    warnings,
    protocolImpact,
    counts: {
      provider,
      localClean,
      customLocal,
      unresolved,
      catalogMods: catalog.mods.length
    },
    sources,
    resourcePack: { ok: rpOk, sha256: rpSha, size: rpSize, detail: rpDetail },
    luckperms: { ...lpClass, inventoried: lpInv.count },
    datapack: { status: dp.status, proof: dp.proof, fileCount: dp.files.length },
    serverDatapacks: { ok: sdpOk, count: sdpCount, detail: sdpDetail, treeSha256: sdpTree },
    configsChecked
  };
}
