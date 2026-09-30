/**
 * Isolated dry-run: stage release-hosted local mods WITHOUT writing data/releases/0.1.3.
 * Output under data/candidates/0.1.3-seq4-NONPUBLISHABLE/dry-run-release-hosted/
 * No publish, sign-for-prod, upload, or channel update.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stageRelease } from "../src/stage.js";
import { verifyRelease } from "../src/verifyRelease.js";
import { UnsignedDevSigner } from "../src/releaseSigning.js";
import {
  countArtifactKinds,
  planReleaseHostedMods
} from "../src/releaseHosted.js";
import { DEFAULT_ORIGIN } from "../src/remotePaths.js";
import type { Catalog } from "../src/types.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLEAN =
  process.env.SWEETCRAFT_CLEAN_ROOT ??
  path.resolve(ROOT, "..", "..", "MODPACK FINAL CLEAN");
const CATALOG = path.join(ROOT, "data", "catalog.configs.json");
const OUT_PARENT = path.join(
  ROOT,
  "data",
  "candidates",
  "0.1.3-seq4-NONPUBLISHABLE",
  "dry-run-release-hosted"
);
const PACK_VERSION = "0.1.3";
const HOSTED_IDS = ["dynamic_difficulty", "fallen", "xbasecasino"] as const;

async function listFilesRecursive(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string) {
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (e.isFile()) out.push(abs);
    }
  }
  await walk(dir);
  return out;
}

/** Merge CLEAN client+server config/ into one ephemeral pack root (configs only). */
async function materializeMergedConfigSource(cleanRoot: string, destRoot: string): Promise<void> {
  await fs.mkdir(path.join(destRoot, "config"), { recursive: true });
  for (const side of ["client", "server"] as const) {
    const cfgRoot = path.join(cleanRoot, side, "config");
    const files = await listFilesRecursive(cfgRoot);
    for (const abs of files) {
      const rel = path.relative(cfgRoot, abs).split(path.sep).join("/");
      const dest = path.join(destRoot, "config", ...rel.split("/"));
      await fs.mkdir(path.dirname(dest), { recursive: true });
      // Prefer first write (client); server fills gaps only
      try {
        await fs.access(dest);
      } catch {
        await fs.copyFile(abs, dest);
      }
    }
  }
}

async function main() {
  const catalog = JSON.parse(await fs.readFile(CATALOG, "utf8")) as Catalog;
  const kinds = countArtifactKinds(catalog);
  const plan = planReleaseHostedMods(catalog, {
    packVersion: PACK_VERSION,
    productOrigin: DEFAULT_ORIGIN
  });

  await fs.rm(OUT_PARENT, { recursive: true, force: true });
  await fs.mkdir(OUT_PARENT, { recursive: true });
  const mergedSource = path.join(OUT_PARENT, "_merged-config-source");
  await materializeMergedConfigSource(CLEAN, mergedSource);

  let resourcePacksFile: string | undefined;
  const rp = path.join(ROOT, "data", "resourcepacks.json");
  try {
    await fs.access(rp);
    resourcePacksFile = rp;
  } catch {
    /* optional */
  }

  const staged = await stageRelease({
    catalog,
    packVersion: PACK_VERSION,
    sourceRoot: mergedSource,
    outDir: OUT_PARENT,
    force: true,
    cleanRoot: CLEAN,
    productOrigin: DEFAULT_ORIGIN,
    resourcePacksFile,
    createdAt: "2026-09-12T00:00:00.000Z",
    signer: new UnsignedDevSigner()
  });

  const verify = await verifyRelease({
    releaseDir: staged.releaseDir,
    allowUnsignedDev: true
  });

  const client = JSON.parse(
    await fs.readFile(path.join(staged.releaseDir, "client-manifest.json"), "utf8")
  ) as {
    schemaVersion: number;
    mods: {
      id: string;
      provider: { type: string; url: string | null };
      sha256: string;
      size: number;
      file: string;
    }[];
  };
  const server = JSON.parse(
    await fs.readFile(path.join(staged.releaseDir, "server-manifest.json"), "utf8")
  ) as { schemaVersion: number; mods: { id: string }[] };
  const release = JSON.parse(
    await fs.readFile(path.join(staged.releaseDir, "release.json"), "utf8")
  ) as { schemaVersion: number; stats: Record<string, unknown> };
  const checksums = JSON.parse(
    await fs.readFile(path.join(staged.releaseDir, "checksums.json"), "utf8")
  ) as { entries: { path: string; sha256: string; size: number }[] };

  const hostedInManifest = HOSTED_IDS.map(id => {
    const m = client.mods.find(x => x.id === id);
    const p = plan.find(x => x.mod_id === id)!;
    return {
      mod_id: id,
      sourceKind: p.sourceKind,
      file: m?.file ?? null,
      sha256: m?.sha256 ?? null,
      size: m?.size ?? null,
      providerType: m?.provider.type ?? null,
      url: m?.provider.url ?? null,
      expectedUrl: p.publicUrl,
      target: p.releaseStoragePath,
      urlMatch: m?.provider.url === p.publicUrl,
      shaMatch: m?.sha256 === p.sha256,
      sizeMatch: m?.size === p.size_bytes
    };
  });

  // Tamper detection: mutate one hosted jar, expect verify fail, restore bytes
  const tamperPath = path.join(staged.releaseDir, "files", "mods", plan[0]!.jar);
  const original = await fs.readFile(tamperPath);
  await fs.writeFile(tamperPath, Buffer.concat([original, Buffer.from("X")]));
  const tamperVerify = await verifyRelease({
    releaseDir: staged.releaseDir,
    allowUnsignedDev: true
  });
  await fs.writeFile(tamperPath, original);
  const restoreVerify = await verifyRelease({
    releaseDir: staged.releaseDir,
    allowUnsignedDev: true
  });

  const report = {
    verdict:
      verify.ok &&
      restoreVerify.ok &&
      !tamperVerify.ok &&
      staged.releaseHostedModsStaged === 3 &&
      kinds.provider === 124 &&
      kinds.localClean === 1 &&
      kinds.customLocal === 2 &&
      kinds.unresolved === 0 &&
      catalog.mods.length === 127 &&
      client.mods.length === 117 &&
      server.mods.length === 100 &&
      client.schemaVersion === 6 &&
      release.schemaVersion === 2 &&
      release.stats.releaseHostedMods === undefined &&
      hostedInManifest.every(h => h.urlMatch && h.shaMatch && h.sizeMatch)
        ? "LOCAL_ARTIFACT_PUBLICATION_READY"
        : "LOCAL_ARTIFACT_PUBLICATION_BLOCKED",
    note: "DRY-RUN only — not data/releases/0.1.3 official stage; unsigned-dev; no publish",
    cleanRoot: CLEAN,
    mergedConfigSource: mergedSource,
    releaseDir: staged.releaseDir,
    counts: {
      ...kinds,
      catalogMods: catalog.mods.length,
      clientMods: client.mods.length,
      serverMods: server.mods.length,
      releaseHostedStaged: staged.releaseHostedModsStaged,
      checksumEntries: staged.checksumEntries
    },
    schemas: {
      manifest: client.schemaVersion,
      release: release.schemaVersion,
      expectedManifest: 6,
      expectedRelease: 2
    },
    hosted: hostedInManifest,
    checksumHostedPaths: checksums.entries
      .map(e => e.path)
      .filter(p => p.startsWith("files/mods/")),
    verify: {
      ok: verify.ok,
      releaseIntegrity: verify.releaseIntegrity,
      signature: verify.signature,
      errors: verify.errors
    },
    tamper: {
      detected: !tamperVerify.ok,
      restoredOk: restoreVerify.ok,
      errorsSample: tamperVerify.errors.slice(0, 3)
    },
    NO_PROTOCOL_CHANGE: true
  };

  const reportPath = path.join(OUT_PARENT, "DRY_RUN_REPORT.json");
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nWrote ${reportPath}`);
  if (report.verdict !== "LOCAL_ARTIFACT_PUBLICATION_READY") process.exitCode = 2;
}

main().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
