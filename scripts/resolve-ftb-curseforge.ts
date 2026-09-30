/**
 * Resolve the 5 FTB PROVIDER_REQUIRED mods via CurseForge SHA-1 exact match.
 * Requires CURSEFORGE_API_KEY in the process environment.
 * Does NOT stage/publish/commit. Never prints the API key.
 */
import path from "node:path";
import { readCatalog, writeJson } from "../src/io.js";
import { resolveCurseForgeExact, curseforgeApiKeyPresent } from "../src/curseforge.js";
import { resolveAllArtifactSources } from "../src/artifactSource.js";
import { runStagePreflight } from "../src/stagePreflight.js";
import { validate } from "../src/validate.js";

const FTB_IDS = new Set([
  "ftbfiltersystem",
  "ftblibrary",
  "ftbquests",
  "ftbteams",
  "ftbxmodcompat"
]);

const CLEAN = "H:/Users/kevin/Downloads/Dev/XBase/MODPACK FINAL CLEAN";
const OUT_REPORT = "data/candidates/0.1.3-seq4-NONPUBLISHABLE/FTB_CURSEFORGE_RESOLVE.json";

async function main() {
  const present = curseforgeApiKeyPresent();
  console.log(`CURSEFORGE_API_KEY_PRESENT=${present ? "YES" : "NO"}`);

  const catalog = await readCatalog("data/catalog.configs.json");
  const targets = catalog.mods.filter(m => FTB_IDS.has(m.mod_id));
  console.log(
    JSON.stringify(
      {
        targets: targets.map(m => ({
          mod_id: m.mod_id,
          jar: m.jar,
          version: m.version,
          sha256: m.sha256,
          sha1: m.sha1,
          size: m.size_bytes,
          side: m.side_class,
          dist: m.distribution_policy,
          curseforge_project_id: m.curseforge_project_id ?? null,
          curseforge_file_id: m.curseforge_file_id ?? null
        }))
      },
      null,
      2
    )
  );

  if (!present) {
    const report = {
      verdict: "CURSEFORGE_AUTH_MISSING",
      CURSEFORGE_API_KEY_PRESENT: "NO",
      preflight: "NOT_RUN",
      note: "No catalog provider updates performed. Set CURSEFORGE_API_KEY in the process env and re-run."
    };
    await writeJson(OUT_REPORT, report);
    console.log("CURSEFORGE_AUTH_MISSING");
    console.log(`Rapport: ${OUT_REPORT}`);
    process.exitCode = 2;
    return;
  }

  const resolved = await resolveCurseForgeExact(catalog, { onlyModIds: FTB_IDS });
  // Merge resolved FTB entries into full catalog
  const byId = new Map(resolved.catalog.mods.map(m => [m.mod_id, m]));
  const merged = {
    ...catalog,
    mods: catalog.mods.map(m => (FTB_IDS.has(m.mod_id) ? byId.get(m.mod_id) ?? m : m))
  };

  const matches = resolved.rows.filter(r => r.status === "FTB_PROVIDER_EXACT_MATCH").length;
  const notFound = resolved.rows.filter(r => r.status === "FTB_PROVIDER_NOT_FOUND").length;
  const mismatch = resolved.rows.filter(r => r.status === "FTB_PROVIDER_HASH_MISMATCH").length;

  if (matches === 5) {
    await writeJson("data/catalog.configs.json", merged);
    await writeJson("data/catalog.providers.json", merged);
    await writeJson("data/catalog.curated.json", merged);
    await writeJson("data/catalog.modrinth.json", {
      ...merged,
      // keep modrinth catalog shape; FTB entries now have CF urls
    });
  }

  const sources = resolveAllArtifactSources(merged.mods);
  const counts = {
    provider: sources.filter(s => s.kind === "PROVIDER").length,
    localClean: sources.filter(s => s.kind === "LOCAL_CLEAN").length,
    customLocal: sources.filter(s => s.kind === "CUSTOM_LOCAL").length,
    unresolved: sources.filter(s => s.kind === "UNRESOLVED").length
  };

  let preflight = null;
  if (matches === 5) {
    preflight = await runStagePreflight({
      catalog: merged,
      cleanRoot: CLEAN,
      configSourceRoot: path.join(CLEAN, "client"),
      resourcePacksFile: "data/resourcepacks.json",
      packVersion: "0.1.3"
    });
  }

  const findings = validate(merged);
  const report = {
    CURSEFORGE_API_KEY_PRESENT: "YES",
    rows: resolved.rows.map(r => ({
      ...r
      // no secrets
    })),
    FTB_PROVIDER_EXACT_MATCH: matches,
    FTB_PROVIDER_NOT_FOUND: notFound,
    FTB_PROVIDER_HASH_MISMATCH: mismatch,
    counts,
    catalogErrors: findings.filter(f => f.severity === "ERROR").length,
    preflight: preflight
      ? { verdict: preflight.verdict, blockers: preflight.blockers, counts: preflight.counts }
      : null,
    LOCAL_ARTIFACT_PUBLICATION_READY: "NO",
    localDebt: [
      "dynamic_difficulty: LOCAL_CLEAN — no launcher URL yet",
      "fallen: CUSTOM_LOCAL — no launcher URL yet",
      "xbase-casino: CUSTOM_LOCAL — no launcher URL yet"
    ],
    catalogsUpdated: matches === 5
  };
  await writeJson(OUT_REPORT, report);
  if (preflight) {
    await writeJson(
      "data/candidates/0.1.3-seq4-NONPUBLISHABLE/STAGE_PREFLIGHT.json",
      preflight
    );
  }

  console.log(
    JSON.stringify(
      {
        matches,
        notFound,
        mismatch,
        counts,
        preflight: preflight?.verdict ?? "SKIPPED",
        urlResolved: resolved.rows.map(r => ({ id: r.mod_id, url: r.urlResolved, fileId: r.fileId }))
      },
      null,
      2
    )
  );

  if (matches !== 5 || preflight?.verdict !== "STAGE_PREFLIGHT_READY") {
    process.exitCode = 2;
  }
}

main().catch(e => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
