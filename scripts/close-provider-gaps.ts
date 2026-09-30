/**
 * SYNC-05.1 — Close provider gaps: Modrinth + validated CF + write release catalogues.
 * Does NOT stage/publish 0.1.4.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveAllArtifactSources } from "../src/artifactSource.js";
import { resolveCurseForge } from "../src/curseforge.js";
import { resolveGitHub } from "../src/github.js";
import { writeJson } from "../src/io.js";
import { resolveModrinth } from "../src/modrinth.js";
import {
  applyValidatedCurseForgeClosure,
  loadValidatedCurseForgeFixture,
  mergeProviderMetadata,
  restorePhysicalSideFields,
  summarizeProviderClosure,
  VALIDATED_CF_FIXTURE_0_1_3_SEQ4
} from "../src/providerClosure.js";
import { runStagePreflight } from "../src/stagePreflight.js";
import { readCatalog } from "../src/io.js";

const CLEAN = "H:/Users/kevin/Downloads/Dev/XBase/MODPACK FINAL CLEAN";
const MATRIX_OUT = "data/SYNC-05.1-provider-closure-matrix.json";

function sha256File(abs: string): string {
  return createHash("sha256").update(readFileSync(abs)).digest("hex");
}

async function main() {
  /** SYNC-04 authoritative side/install identity from rescan baseline (not provider-enriched catalog). */
  const sideSource = await readCatalog("data/catalog.baseline.json");
  const policySource = await readCatalog("data/catalog.configs.json");
  let resolved = policySource;

  const mr = await resolveModrinth(resolved, "data/cache/modrinth");
  resolved = mergeProviderMetadata(policySource, mr.catalog);
  const cf = await resolveCurseForge(resolved);
  resolved = mergeProviderMetadata(policySource, cf.catalog);
  const gh = await resolveGitHub(resolved);
  let catalog = mergeProviderMetadata(policySource, gh.catalog);

  const validatedCf = loadValidatedCurseForgeFixture(VALIDATED_CF_FIXTURE_0_1_3_SEQ4);
  const cfClosure = applyValidatedCurseForgeClosure(catalog, validatedCf);
  catalog = restorePhysicalSideFields(sideSource, cfClosure.catalog);
  catalog = { ...catalog, configs: policySource.configs, schemaVersion: policySource.schemaVersion };

  await writeJson("data/catalog.providers.json", catalog);
  await writeJson("data/catalog.configs.json", catalog);
  await writeJson("data/catalog.curated.json", catalog);

  const summary = summarizeProviderClosure(catalog);
  const rows = catalog.mods.map(m => {
    const src = resolveAllArtifactSources([m])[0]!;
    const side =
      m.install_client && m.install_server ? "both" : m.install_client ? "client" : "server";
    let cleanShaMatch: boolean | null = null;
    if (src.cleanRelativePath) {
      const abs = path.join(CLEAN, src.cleanRelativePath.replace(/\//g, path.sep));
      cleanShaMatch = existsSync(abs) ? sha256File(abs) === m.sha256 : false;
    }
    return {
      mod_id: m.mod_id,
      jar: m.jar,
      side,
      sha256: m.sha256,
      size_bytes: m.size_bytes,
      distribution_policy: m.distribution_policy,
      stagingKind: src.kind,
      stagingDecision: src.decision,
      hasProviderUrl: !!(m.modrinth_file_url || m.curseforge_file_url || m.author_file_url),
      provider_resolution_status: m.provider_resolution_status ?? null,
      cleanShaMatch
    };
  });

  writeFileSync(
    MATRIX_OUT,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        modrinth: { found: mr.found, missing: mr.missing },
        curseforge: { found: cf.found, needsApiKey: cf.needsApiKey },
        validatedCfApplied: cfClosure.applied,
        validatedCfSkipped: cfClosure.skipped,
        summary,
        rows
      },
      null,
      2
    )
  );

  const matrixSha = createHash("sha256").update(readFileSync(MATRIX_OUT)).digest("hex");

  console.log("=== SYNC-05.1 PROVIDER CLOSURE ===");
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Matrix: ${MATRIX_OUT}`);
  console.log(`Matrix SHA-256: ${matrixSha}`);

  const preflight = await runStagePreflight({
    catalog,
    cleanRoot: CLEAN,
    configSourceRoot: path.join(CLEAN, "client"),
    resourcePacksFile: path.resolve("data/resourcepacks.json"),
    packVersion: "0.0.0-sync051-dry"
  });
  console.log(`Preflight: ${preflight.verdict} unresolved=${preflight.counts.unresolved}`);
  if (preflight.blockers.length) {
    for (const b of preflight.blockers.slice(0, 20)) console.log(` BLOCK ${b}`);
  }

  if (summary.artifactSources.unresolved > 0) {
    process.exitCode = 2;
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
