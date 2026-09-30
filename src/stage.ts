import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Catalog } from "./types.js";
import {
  CATALOG_SCHEMA_VERSION,
  MANIFEST_SCHEMA_VERSION,
  RELEASE_FILES_BASE,
  RELEASE_SCHEMA_VERSION
} from "./types.js";
import { buildClientManifest, buildServerManifest, isManifestBlockedPolicy } from "./manifest.js";
import { releaseReady, validate } from "./validate.js";
import { hashFile } from "./io.js";
import { VERSION } from "./version.js";
import { defaultReleaseSigner, type ReleaseSigner, sha256Buffer } from "./releaseSigning.js";
import { buildReleaseSigningPayload, RELEASE_SIGNING_PAYLOAD_ID } from "./releasePayload.js";
import { assertSafeConfigPath as assertSafeConfigPathCore, stagedConfigRelativePath as stagedConfigRelativePathCore } from "./paths.js";
import { PathSafetyError } from "./paths.js";
import {
  prepareResourcePacksFromConfig,
  toManifestResourcePack,
  type PreparedResourcePack
} from "./resourcePack.js";
import { ResourcePackError } from "./resourcePack.js";
import { assertPublicManifestPackClean } from "./resourcePack.js";
import {
  applyReleaseHostedUrlsToCatalog,
  materializeReleaseHostedMod,
  planReleaseHostedMods
} from "./releaseHosted.js";
import { LocalCleanError } from "./localClean.js";
import { DEFAULT_ORIGIN } from "./remotePaths.js";
import { OriginUrlError } from "./originUrl.js";
import { prepareServerDatapacksFromConfig, toManifestServerDatapack } from "./serverDatapack.js";
import type { PreparedServerDatapack } from "./serverDatapackTypes.js";
import { ServerDatapackError } from "./serverDatapack.js";
import { assertPublicManifestDatapackClean } from "./serverDatapack.js";
import { stagedServerDatapackFileRelativePath } from "./serverDatapackPaths.js";
import {
  assertReleasePreflightAllowsStage,
  runReleasePreflight
} from "./releasePreflight.js";
import {
  UNIT_TEST_STAGE_BYPASS,
  type StageAssemblyGate
} from "./releasePreflightTypes.js";

export class StageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StageError";
  }
}

export interface StageOptions {
  catalog: Catalog;
  packVersion: string;
  /** Pack root containing `config/` (e.g. MODPACK FINAL CLEAN/client). */
  sourceRoot: string;
  /** Parent directory for versioned releases (e.g. data/releases). */
  outDir: string;
  force?: boolean;
  signer?: ReleaseSigner;
  /** Fixed createdAt for deterministic tests. */
  createdAt?: string;
  /**
   * Local resource packs config (e.g. data/resourcepacks.json).
   * Paths may be machine-local; never written into public manifests.
   */
  resourcePacksFile?: string;
  /** Pre-prepared packs (tests). Overrides resourcePacksFile when set. */
  resourcePacks?: PreparedResourcePack[];
  /** Local server datapacks config (e.g. data/serverDatapacks.json). */
  serverDatapacksFile?: string;
  /** Pre-prepared server datapacks (tests). Overrides serverDatapacksFile when set. */
  serverDatapacks?: PreparedServerDatapack[];
  /**
   * CLEAN root for LOCAL_CLEAN / CUSTOM_LOCAL jars that become release-hosted.
   * Required when the catalog has mods without provider URLs that resolve to local kinds.
   */
  cleanRoot?: string;
  /**
   * Product public origin used to bake HTTPS URLs for release-hosted mods.
   * Example: https://cdn.xnosweet.fr/sweetcraft
   */
  productOrigin?: string;
  /**
   * Optional candidate releaseSequence for local staging (antiRollback + signing payload).
   * Default null — production assignment remains at channel publish.
   * Staging with a sequence still requires SIGNED_OK to be publishable.
   */
  releaseSequence?: number | null;
  /**
   * STEP-4.6-M7 assembly release preflight — required before any release-state mutation.
   * Production CLI always supplies mode "run" or a precomputed PASS report.
   * Unit tests may use mode "unit-test-bypass" with UNIT_TEST_STAGE_BYPASS only.
   * Missing gate → fail-closed (no silent bypass).
   */
  assemblyGate?: StageAssemblyGate;
}

export interface StageResult {
  releaseDir: string;
  packVersion: string;
  clientMods: number;
  serverMods: number;
  configsStaged: number;
  resourcePacksStaged: number;
  serverDatapacksStaged: number;
  releaseHostedModsStaged: number;
  excluded: number;
  checksumEntries: number;
  signatureStatus: "signed" | "unsigned-dev";
  publicKeyId: string | null;
  releaseReady: true;
}

export interface ManifestConfigEntry {
  path: string;
  sha256: string;
  policy: string;
  apply: string;
  target: string;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

async function writeJsonAtomic(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, stableJson(value), "utf8");
}

/** Reject absolute paths, Windows drives, backslashes, and traversal. */
export function assertSafeConfigPath(configPath: string): void {
  try {
    assertSafeConfigPathCore(configPath);
  } catch (e) {
    throw new StageError(e instanceof Error ? e.message : String(e));
  }
}

export function resolveSourceConfigFile(sourceRoot: string, configPath: string): string {
  assertSafeConfigPath(configPath);
  const root = path.resolve(sourceRoot);
  const abs = path.resolve(root, ...configPath.split("/"));
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new StageError(`path escape hors sourceRoot: ${configPath}`);
  }
  return abs;
}

export function stagedConfigRelativePath(configPath: string): string {
  try {
    return stagedConfigRelativePathCore(configPath);
  } catch (e) {
    if (e instanceof PathSafetyError) throw new StageError(e.message);
    throw e;
  }
}

function assertSemverLike(version: string) {
  if (!/^\d+\.\d+\.\d+([.-][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new StageError(`--version invalide (attendu semver-like): ${version}`);
  }
}

function unionManifestConfigs(client: { configs: ManifestConfigEntry[] }, server: { configs: ManifestConfigEntry[] }): ManifestConfigEntry[] {
  const map = new Map<string, ManifestConfigEntry>();
  for (const cf of [...client.configs, ...server.configs]) {
    if (isManifestBlockedPolicy(cf.policy)) {
      throw new StageError(`config bloquée présente dans manifest: ${cf.path} policy=${cf.policy}`);
    }
    const prev = map.get(cf.path);
    if (prev && prev.sha256 !== cf.sha256) {
      throw new StageError(`sha256 divergent client/server pour ${cf.path}`);
    }
    map.set(cf.path, cf);
  }
  return [...map.values()].sort((a, b) => a.path.localeCompare(b.path));
}

async function rmrf(dir: string) {
  await fs.rm(dir, { recursive: true, force: true });
}

async function enforceAssemblyGate(opts: StageOptions): Promise<void> {
  const gate = opts.assemblyGate;
  if (!gate) {
    throw new StageError(
      "ASSEMBLY_PREFLIGHT_REQUIRED: assemblyGate manquant — staging refusé (fail-closed STEP-4.6-M7)"
    );
  }
  if (gate.mode === "unit-test-bypass") {
    if (gate.token !== UNIT_TEST_STAGE_BYPASS) {
      throw new StageError("ASSEMBLY_PREFLIGHT_REQUIRED: bypass token invalide");
    }
    return;
  }
  if (gate.mode === "report") {
    try {
      assertReleasePreflightAllowsStage(gate.report);
    } catch (e) {
      throw new StageError(e instanceof Error ? e.message : String(e));
    }
    return;
  }
  if (gate.mode === "run") {
    const report = await runReleasePreflight(gate.options);
    try {
      assertReleasePreflightAllowsStage(report);
    } catch (e) {
      throw new StageError(e instanceof Error ? e.message : String(e));
    }
    return;
  }
  throw new StageError("ASSEMBLY_PREFLIGHT_REQUIRED: mode assemblyGate inconnu");
}

/**
 * Stage a versioned SweetCraft release (metadata + config files only; mods stay on providers).
 */
export async function stageRelease(opts: StageOptions): Promise<StageResult> {
  const packVersion = opts.packVersion.trim();
  assertSemverLike(packVersion);

  // STEP-4.6-M7: fail-closed BEFORE any release-state mutation (mkdir/write).
  await enforceAssemblyGate(opts);

  const catalog = opts.catalog;
  if (catalog.schemaVersion !== CATALOG_SCHEMA_VERSION) {
    throw new StageError(
      `schema catalogue attendu ${CATALOG_SCHEMA_VERSION}, reçu ${catalog.schemaVersion} — exécuter \`pnpm pack:configs\` (CLI: classify-configs)`
    );
  }

  const ready = releaseReady(catalog);
  if (!ready.ready) {
    const sample = ready.blocking.slice(0, 5).map(x => `${x.code} ${x.subject}`).join("; ");
    throw new StageError(`RELEASE_READY=NO — staging refusé (${ready.blocking.length} erreur(s)): ${sample}`);
  }

  // Extra validate pass for messaging consistency
  const findings = validate(catalog);
  if (findings.some(x => x.severity === "ERROR")) {
    throw new StageError("validation catalogue en erreur — staging refusé");
  }

  const sourceRoot = path.resolve(opts.sourceRoot);
  const releasesRoot = path.resolve(opts.outDir);
  const destDir = path.join(releasesRoot, packVersion);
  const force = !!opts.force;

  try {
    await fs.access(sourceRoot);
  } catch {
    throw new StageError(`source introuvable: ${sourceRoot}`);
  }

  if (!force) {
    try {
      await fs.access(destDir);
      throw new StageError(`release déjà présente: ${destDir} (utiliser --force pour remplacer en dev)`);
    } catch (e) {
      if (e instanceof StageError) throw e;
      // ENOENT ok
    }
  }

  let preparedPacks: PreparedResourcePack[] = opts.resourcePacks ?? [];
  if (!opts.resourcePacks && opts.resourcePacksFile) {
    try {
      preparedPacks = await prepareResourcePacksFromConfig(opts.resourcePacksFile);
    } catch (e) {
      if (e instanceof ResourcePackError || e instanceof PathSafetyError) {
        throw new StageError(e.message);
      }
      throw e;
    }
  }

  const publicPacks = preparedPacks.map(p => {
    const m = toManifestResourcePack(p);
    assertPublicManifestPackClean(m as unknown as Record<string, unknown>);
    return m;
  });

  let preparedDatapacks: PreparedServerDatapack[] = opts.serverDatapacks ?? [];
  if (!opts.serverDatapacks && opts.serverDatapacksFile) {
    try {
      preparedDatapacks = await prepareServerDatapacksFromConfig(opts.serverDatapacksFile);
    } catch (e) {
      if (e instanceof ServerDatapackError || e instanceof PathSafetyError) {
        throw new StageError(e.message);
      }
      throw e;
    }
  }

  const publicDatapacks = preparedDatapacks.map(p => {
    const m = toManifestServerDatapack(p);
    assertPublicManifestDatapackClean(m as unknown as Record<string, unknown>);
    return m;
  });

  const productOrigin = opts.productOrigin ?? DEFAULT_ORIGIN;
  let hostedPlan;
  try {
    hostedPlan = planReleaseHostedMods(catalog, {
      packVersion,
      productOrigin
    });
  } catch (e) {
    if (e instanceof PathSafetyError || e instanceof OriginUrlError) {
      throw new StageError(e.message);
    }
    throw e;
  }

  if (hostedPlan.length > 0 && !opts.cleanRoot) {
    throw new StageError(
      `release-hosted mods (${hostedPlan.length}) require --clean / StageOptions.cleanRoot`
    );
  }

  const catalogForManifest =
    hostedPlan.length > 0 ? applyReleaseHostedUrlsToCatalog(catalog, hostedPlan) : catalog;

  const createdAt = opts.createdAt ?? new Date().toISOString();
  const clientManifest = buildClientManifest(catalogForManifest, packVersion, {
    generatedAt: createdAt,
    resourcePacks: publicPacks
  });
  const serverManifest = buildServerManifest(catalogForManifest, packVersion, {
    generatedAt: createdAt,
    serverDatapacks: publicDatapacks
  });
  const toStage = unionManifestConfigs(
    clientManifest as { configs: ManifestConfigEntry[] },
    serverManifest as { configs: ManifestConfigEntry[] }
  );

  const excluded = catalog.configs.filter(c => c.policy === "EXCLUDED").length;
  const tmpName = `.tmp-${packVersion}-${randomBytes(4).toString("hex")}`;
  const tmpDir = path.join(releasesRoot, tmpName);

  await fs.mkdir(releasesRoot, { recursive: true });
  await rmrf(tmpDir);
  await fs.mkdir(tmpDir, { recursive: true });

  try {
    // Copy configs byte-for-byte with hash verification
    for (const cf of toStage) {
      const src = resolveSourceConfigFile(sourceRoot, cf.path);
      let data: Buffer;
      try {
        data = await fs.readFile(src);
      } catch {
        throw new StageError(`fichier config source absent: ${src}`);
      }
      const actual = createHash("sha256").update(data).digest("hex");
      if (actual !== cf.sha256.toLowerCase()) {
        throw new StageError(
          `SHA-256 mismatch pour ${cf.path}: catalogue=${cf.sha256} fichier=${actual}`
        );
      }
      const rel = stagedConfigRelativePath(cf.path);
      const dest = path.join(tmpDir, ...rel.split("/"));
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, data);
    }

    // Copy resource packs byte-for-byte (exact ZIP octets; never re-zip)
    for (const rp of preparedPacks) {
      let data: Buffer;
      try {
        data = await fs.readFile(rp.sourceAbsolutePath);
      } catch {
        throw new StageError(`resource pack source absent: ${rp.sourceAbsolutePath}`);
      }
      const actual = createHash("sha256").update(data).digest("hex");
      if (actual !== rp.sha256.toLowerCase() || data.length !== rp.size) {
        throw new StageError(
          `SHA/size mismatch resource pack ${rp.id}: expected sha=${rp.sha256} size=${rp.size} got sha=${actual} size=${data.length}`
        );
      }
      const dest = path.join(tmpDir, ...rp.releaseStoragePath.split("/"));
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, data);
      const stagedSha = createHash("sha256").update(await fs.readFile(dest)).digest("hex");
      const stagedSize = (await fs.stat(dest)).size;
      if (stagedSha !== rp.sha256.toLowerCase() || stagedSize !== rp.size) {
        throw new StageError(`staged resource pack non byte-identical: ${rp.id}`);
      }
    }

    // Server datapacks — folder tree under files/world/datapacks/...
    for (const dp of preparedDatapacks) {
      for (const f of dp.files) {
        const relFromTarget = f.path.slice(dp.targetPath.length + 1);
        const src = path.join(dp.sourceAbsolutePath, ...relFromTarget.split("/"));
        let data: Buffer;
        try {
          data = await fs.readFile(src);
        } catch {
          throw new StageError(`datapack source absent: ${src}`);
        }
        const actual = createHash("sha256").update(data).digest("hex");
        if (actual !== f.sha256.toLowerCase() || data.length !== f.size) {
          throw new StageError(`datapack SHA/size mismatch ${f.path}`);
        }
        const rel = stagedServerDatapackFileRelativePath(f.path);
        const dest = path.join(tmpDir, ...rel.split("/"));
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, data);
      }
    }

    // Release-hosted local mods → files/mods/<jar>
    for (const h of hostedPlan) {
      try {
        await materializeReleaseHostedMod(opts.cleanRoot!, h, tmpDir);
      } catch (e) {
        if (e instanceof LocalCleanError || e instanceof PathSafetyError) {
          throw new StageError(e.message);
        }
        throw e;
      }
    }

    await writeJsonAtomic(path.join(tmpDir, "client-manifest.json"), clientManifest);
    await writeJsonAtomic(path.join(tmpDir, "server-manifest.json"), serverManifest);

    // checksums.json — deterministic order; excludes release.json (chicken/egg)
    const checksumEntries: { path: string; size: number; sha256: string }[] = [];
    const addChecksum = async (relPosix: string) => {
      const abs = path.join(tmpDir, ...relPosix.split("/"));
      const st = await fs.stat(abs);
      const sha256 = await hashFile(abs, "sha256");
      checksumEntries.push({ path: relPosix, size: st.size, sha256 });
    };
    await addChecksum("client-manifest.json");
    await addChecksum("server-manifest.json");
    for (const cf of toStage) {
      await addChecksum(stagedConfigRelativePath(cf.path));
    }
    for (const rp of preparedPacks) {
      await addChecksum(rp.releaseStoragePath);
    }
    for (const h of hostedPlan) {
      await addChecksum(h.releaseStoragePath);
    }
    for (const dp of preparedDatapacks) {
      for (const f of dp.files) {
        await addChecksum(stagedServerDatapackFileRelativePath(f.path));
      }
    }
    checksumEntries.sort((a, b) => a.path.localeCompare(b.path));
    await writeJsonAtomic(path.join(tmpDir, "checksums.json"), {
      schemaVersion: 1,
      product: "SweetCraft",
      packVersion,
      entries: checksumEntries
    });

    const checksumsSha256 = await hashFile(path.join(tmpDir, "checksums.json"), "sha256");
    const clientSha256 = checksumEntries.find(e => e.path === "client-manifest.json")!.sha256;
    const serverSha256 = checksumEntries.find(e => e.path === "server-manifest.json")!.sha256;

    const signer = opts.signer ?? defaultReleaseSigner();
    // Default null (assigned at channel publish). Optional candidate sequence for local RC staging.
    let releaseSequence: number | null = null;
    if (opts.releaseSequence !== undefined && opts.releaseSequence !== null) {
      if (!Number.isInteger(opts.releaseSequence) || opts.releaseSequence < 1) {
        throw new StageError(`releaseSequence invalide: ${opts.releaseSequence}`);
      }
      releaseSequence = opts.releaseSequence;
    }
    const signPayload = buildReleaseSigningPayload({
      product: "SweetCraft",
      packVersion,
      minecraft: catalog.generatedFor.minecraft,
      fabricLoader: catalog.generatedFor.fabricLoader,
      server: catalog.generatedFor.server,
      packManagerVersion: VERSION,
      catalogSchemaVersion: catalog.schemaVersion,
      manifestSchemaVersion: MANIFEST_SCHEMA_VERSION,
      releaseSchemaVersion: RELEASE_SCHEMA_VERSION,
      configBase: RELEASE_FILES_BASE,
      releaseSequence,
      clientManifestSha256: clientSha256,
      serverManifestSha256: serverSha256,
      checksumsSha256
    });
    const signed = await signer.sign(signPayload);
    const signatureStatus = signed ? ("signed" as const) : ("unsigned-dev" as const);

    const releaseJson = {
      schemaVersion: RELEASE_SCHEMA_VERSION,
      product: "SweetCraft",
      packVersion,
      minecraft: catalog.generatedFor.minecraft,
      fabricLoader: catalog.generatedFor.fabricLoader,
      server: catalog.generatedFor.server,
      createdAt,
      packManagerVersion: VERSION,
      catalogSchemaVersion: catalog.schemaVersion,
      manifestSchemaVersion: MANIFEST_SCHEMA_VERSION,
      configBase: RELEASE_FILES_BASE,
      antiRollback: {
        packVersion,
        releaseSequence,
        note:
          releaseSequence == null
            ? "releaseSequence is reserved for published channels; unset at local staging"
            : "candidate releaseSequence set at local staging; unsigned-dev until production sign/publish"
      },
      artefacts: {
        clientManifest: { path: "client-manifest.json", sha256: clientSha256 },
        serverManifest: { path: "server-manifest.json", sha256: serverSha256 },
        checksums: { path: "checksums.json", sha256: checksumsSha256 }
      },
      signature: {
        status: signatureStatus,
        algorithm: "ed25519",
        publicKeyId: signed?.publicKeyId ?? null,
        payload: RELEASE_SIGNING_PAYLOAD_ID,
        value: signed?.signatureBase64 ?? null,
        signer: signer.name
      },
      stats: {
        clientMods: clientManifest.mods.length,
        serverMods: serverManifest.mods.length,
        configsStaged: toStage.length,
        excludedInCatalog: excluded
        // releaseHostedMods / resourcePacks intentionally omitted from release schema 2 stats
        // (hosted mods appear as normal HTTPS provider URLs in manifests; keep release payload stable)
      }
    };
    await writeJsonAtomic(path.join(tmpDir, "release.json"), releaseJson);

    if (force) await rmrf(destDir);
    await fs.rename(tmpDir, destDir);

    return {
      releaseDir: destDir,
      packVersion,
      clientMods: clientManifest.mods.length,
      serverMods: serverManifest.mods.length,
      configsStaged: toStage.length,
      resourcePacksStaged: preparedPacks.length,
      serverDatapacksStaged: preparedDatapacks.length,
      releaseHostedModsStaged: hostedPlan.length,
      excluded,
      checksumEntries: checksumEntries.length,
      signatureStatus,
      publicKeyId: signed?.publicKeyId ?? null,
      releaseReady: true
    };
  } catch (e) {
    await rmrf(tmpDir);
    throw e;
  }
}

export function digestPayloadSha256(payload: Buffer): string {
  return sha256Buffer(payload);
}
