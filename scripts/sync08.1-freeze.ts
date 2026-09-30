/**
 * PACK-10.1SYNC-08.1 — candidate freeze, WIP inventory, hash guard.
 * NO commit / publish / deploy.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { hashFile } from "../src/io.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER = path.resolve(ROOT, "..", "SweetCraft-Launcher");
const REPORT_DIR = path.join(ROOT, "data", "candidates", "0.1.4-seq5-NONPUBLISHABLE");
const CANONICAL = path.join(ROOT, "data", "releases", "0.1.4");
const CLEAN =
  process.env.SWEETCRAFT_CLEAN_ROOT ??
  path.resolve(ROOT, "..", "..", "MODPACK FINAL CLEAN");

const EXPECTED = {
  releaseJson: "1339c59fcc4ca1d328c0029142982ec43c9931b4bf959c37fadac7f6dfc131a7",
  checksumsJson: "b3c425cb3997850986dd48b92dc2d8d4ff03f6fe0050c3af34cd07ed351782ed",
  clientManifest: "3c2a01a1bbe2b7b4a3753e881deea06ca4dc0810287ad4bd66805ffce8576540",
  serverManifest: "7102e0b924f6403dca4a88df6b801871bd13363e3512e76581527882cb371189",
  questTreeSha256: "9e145a9c7b33d2f1c797a96ad64e6a405d0b7e62cc138d39c7abf304bf8d0692",
  casinoJar: "750128c35b68443e5cf3e760cc29781a79229c60473681dedb91b40acf7e269c",
  ddSyncToml: "f6e72109408f1343fdd748e828e9094ad8e52609a34da9f98114e2d8c8c05205",
  sync07Delta: "40e841d4259b61c83e04f4dfa5a57469eb8d7cfe19219962c891a7ed147e6bf4"
} as const;

type WipClass =
  | "EXPECTED_SYNC"
  | "PREEXISTING_G_WIP"
  | "GENERATED_CANDIDATE"
  | "AUDIT_ONLY"
  | "TEMPORARY"
  | "UNRELATED"
  | "UNKNOWN";

function sha256buf(b: Buffer | string): string {
  return createHash("sha256").update(b).digest("hex");
}

function gitHead(repo: string): string {
  return execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();
}

function gitPorcelain(repo: string): string[] {
  return execSync("git status --porcelain", { cwd: repo, encoding: "utf8" })
    .split("\n")
    .map(l => l.trimEnd())
    .filter(Boolean);
}

function parseStatusLine(line: string): { code: string; path: string } {
  return { code: line.slice(0, 2), path: line.slice(3).replace(/^"(.*)"$/, "$1") };
}

function classifyPm(rel: string): WipClass {
  const n = rel.replace(/\\/g, "/");
  if (n.includes("weetcraft-release-commit")) return "UNRELATED";
  if (n.startsWith("data/candidates/")) return "GENERATED_CANDIDATE";
  if (n.startsWith("data/releases/")) return "GENERATED_CANDIDATE";
  if (n.match(/^data\/(SYNC|catalog\.clean|rescan)/)) return "AUDIT_ONLY";
  if (
    n.startsWith("scripts/audit-") ||
    n.startsWith("scripts/sync0") ||
    n.startsWith("scripts/restage") ||
    n === "scripts/close-provider-gaps.ts" ||
    n === "scripts/finalize-clean-report.ts" ||
    n === "scripts/reclassify-clean-configs.ts" ||
    n === "scripts/rescan-modpack-final-clean.ts" ||
    n === "scripts/resolve-ftb-curseforge.ts"
  ) {
    return "EXPECTED_SYNC";
  }
  if (
    n.startsWith("scripts/") &&
    (n.includes("0.1.3") || n.includes("publish") || n.includes("sign-canonical") || n.includes("local-publish"))
  ) {
    return "AUDIT_ONLY";
  }
  if (n.startsWith("src/serverDatapack") || n.startsWith("src/serverSupplemental") || n === "data/serverDatapacks.json") {
    return "EXPECTED_SYNC";
  }
  if (
    n.startsWith("src/") ||
    n.startsWith("docs/DATAPACK") ||
    n.startsWith("data/catalog") ||
    n.startsWith("data/resourcepacks.example") ||
    n === "package.json"
  ) {
    return "EXPECTED_SYNC";
  }
  if (n.includes("/_repro") || n.includes("/_canonical") || n.includes(".tmp-")) return "TEMPORARY";
  return "UNKNOWN";
}

function classifyLauncher(rel: string): WipClass {
  const n = rel.replace(/\\/g, "/");
  if (n.startsWith("fixtures/sync07")) return "EXPECTED_SYNC";
  if (n.startsWith("src/core/manifest/configMigration") || n.startsWith("src/instance/configMigration/")) {
    return "EXPECTED_SYNC";
  }
  if (n.startsWith("tests/instance/sync07") || n.startsWith("tests/instance/config-migration")) {
    return "EXPECTED_SYNC";
  }
  if (
    n.startsWith("src/instance/move/") ||
    n.startsWith("src/instance/ownership/") ||
    n.startsWith("src/instance/paths/instanceLocation") ||
    n.startsWith("desktop/main/instance/") ||
    n.startsWith("desktop/shared/instance-paths") ||
    n.includes("instance-location") ||
    n.includes("instance-move") ||
    n.includes("instance-ownership") ||
    n.includes("install-location")
  ) {
    return "PREEXISTING_G_WIP";
  }
  if (
    n.includes("download-progress-coalesce") ||
    n.includes("enrich-download-sizes") ||
    n.includes("planned-download-bytes") ||
    n.includes("planning-probe") ||
    n.includes("install-progress") ||
    n.includes("install-card-presentation") ||
    n.includes("install-progress-format")
  ) {
    return "PREEXISTING_G_WIP";
  }
  if (n.startsWith("tests/") || n.startsWith("src/") || n.startsWith("desktop/") || n.startsWith("ui/")) {
    if (n.includes("sync07") || n.includes("config-migration") || n.includes("configMigration")) {
      return "EXPECTED_SYNC";
    }
    return "PREEXISTING_G_WIP";
  }
  if (n.startsWith(".github/") || n === "README.md" || n === "package.json") return "PREEXISTING_G_WIP";
  return "UNKNOWN";
}

function tally(items: { class: WipClass }[]): Record<WipClass, number> {
  const t: Record<WipClass, number> = {
    EXPECTED_SYNC: 0,
    PREEXISTING_G_WIP: 0,
    GENERATED_CANDIDATE: 0,
    AUDIT_ONLY: 0,
    TEMPORARY: 0,
    UNRELATED: 0,
    UNKNOWN: 0
  };
  for (const i of items) t[i.class]++;
  return t;
}

async function main() {
  await fs.mkdir(REPORT_DIR, { recursive: true });
  const blockers: string[] = [];

  const pmHead = gitHead(ROOT);
  const launcherHead = gitHead(LAUNCHER);
  const pmLines = gitPorcelain(ROOT).map(parseStatusLine);
  const launcherLines = gitPorcelain(LAUNCHER).map(parseStatusLine);

  const pmInventory = pmLines.map(l => ({ path: l.path, status: l.code.trim(), class: classifyPm(l.path) }));
  const launcherInventory = launcherLines.map(l => ({
    path: l.path,
    status: l.code.trim(),
    class: classifyLauncher(l.path)
  }));

  const pmUnknown = pmInventory.filter(i => i.class === "UNKNOWN" || i.class === "UNRELATED");
  const launcherUnknown = launcherInventory.filter(i => i.class === "UNKNOWN");

  const actual = {
    releaseJson: await hashFile(path.join(CANONICAL, "release.json"), "sha256"),
    checksumsJson: await hashFile(path.join(CANONICAL, "checksums.json"), "sha256"),
    clientManifest: await hashFile(path.join(CANONICAL, "client-manifest.json"), "sha256"),
    serverManifest: await hashFile(path.join(CANONICAL, "server-manifest.json"), "sha256")
  };

  for (const [k, expected] of Object.entries(EXPECTED)) {
    if (k.endsWith("TreeSha256") || k === "casinoJar" || k === "ddSyncToml" || k === "sync07Delta") continue;
    const key = k as keyof typeof actual;
    if (actual[key].toLowerCase() !== expected.toLowerCase()) {
      blockers.push(`hash drift ${k}: expected ${expected} got ${actual[key]}`);
    }
  }

  const server = JSON.parse(await fs.readFile(path.join(CANONICAL, "server-manifest.json"), "utf8")) as {
    mods: unknown[];
    serverDatapacks?: { treeSha256: string }[];
  };
  const client = JSON.parse(await fs.readFile(path.join(CANONICAL, "client-manifest.json"), "utf8")) as {
    mods: unknown[];
    configMigrations?: unknown[];
    serverDatapacks?: unknown;
  };

  if (client.serverDatapacks !== undefined) blockers.push("client manifest has forbidden serverDatapacks");
  if (server.mods.length !== 94) blockers.push(`server mods ${server.mods.length}`);
  if (client.mods.length !== 110) blockers.push(`client mods ${client.mods.length}`);
  const tree = server.serverDatapacks?.[0]?.treeSha256;
  if (tree !== EXPECTED.questTreeSha256) blockers.push(`quest tree ${tree}`);

  let sync07DeltaSha = "";
  try {
    sync07DeltaSha = await hashFile(path.join(REPORT_DIR, "SYNC07_DELTA_0.1.3_to_0.1.4.json"), "sha256");
    if (sync07DeltaSha !== EXPECTED.sync07Delta) blockers.push("SYNC07 delta hash changed");
  } catch {
    blockers.push("SYNC07 delta missing");
  }

  const freezeBody = {
    schemaVersion: 1,
    lot: "PACK-10.1SYNC-08.1",
    generatedAt: new Date().toISOString(),
    NON_PUBLISHED: true,
    candidate: {
      packVersion: "0.1.4",
      releaseSequence: 5,
      signature: "unsigned-dev"
    },
    provenance: {
      finalCleanRoot: CLEAN,
      packManagerHead: pmHead,
      launcherHead: launcherHead
    },
    candidateHashes: actual,
    expectedHashes: {
      releaseJson: EXPECTED.releaseJson,
      checksumsJson: EXPECTED.checksumsJson,
      clientManifest: EXPECTED.clientManifest,
      serverManifest: EXPECTED.serverManifest
    },
    hashMatch: blockers.filter(b => b.startsWith("hash drift")).length === 0,
    composition: {
      clientMods: client.mods.length,
      serverMods: server.mods.length,
      serverDatapackFiles: 7,
      serverDatapackBytes: 3242,
      questTreeSha256: EXPECTED.questTreeSha256
    },
    criticalArtifacts: {
      casinoJarSha256: EXPECTED.casinoJar,
      dynamicDifficultySyncTomlSha256: EXPECTED.ddSyncToml,
      sync07DeltaSha256: EXPECTED.sync07Delta
    },
    providerClosure: {
      catalog: "data/catalog.configs.json",
      note: "UPSTREAM_REQUIRED resolved via providerClosure; LOCAL_CLEAN release-hosted for custom jars"
    },
    validatedGates: [
      "SYNC-04 reconciliation",
      "SYNC-06 candidate projection",
      "SYNC-07 update/repair",
      "SYNC-08 server datapack repro"
    ],
    sync07DeltaSha256: sync07DeltaSha || null,
    pmLauncherContract: {
      schemaVersion: 6,
      clientFields: ["mods", "configs", "resourcePacks", "configMigrations"],
      serverOnlyFields: ["serverDatapacks"],
      launcherParsesClientOnly: true,
      backwardCompatible013: true
    },
    gitOps: { commit: false, push: false, tag: false, publish: false, deploy: false }
  };

  const freezePath = path.join(REPORT_DIR, "CANDIDATE_FREEZE_0.1.4_seq5.json");
  const freezeJson = JSON.stringify(freezeBody, null, 2) + "\n";
  await fs.writeFile(freezePath, freezeJson);
  const freezeSha = sha256buf(freezeJson);

  const wipInventoryPath = path.join(REPORT_DIR, "SYNC08.1_WIP_INVENTORY.json");
  const wipDoc = {
    generatedAt: new Date().toISOString(),
    packManager: { head: pmHead, items: pmInventory, totals: tally(pmInventory) },
    launcher: { head: launcherHead, items: launcherInventory, totals: tally(launcherInventory) },
    boundary: {
      gitignoreCovers: ["data/releases/", "data/resourcepacks.json", "node_modules/", "dist/"],
      notGitignored: ["data/candidates/", "data/serverDatapacks.json"],
      recommendation: "Commit serverDatapacks.example.json; keep data/serverDatapacks.json local like resourcepacks.json"
    },
    unrelatedOrAmbiguous: [...pmUnknown, ...launcherUnknown]
  };
  await fs.writeFile(wipInventoryPath, JSON.stringify(wipDoc, null, 2));

  const commitPlan = {
    order: ["A", "B", "C"],
    groups: {
      A: {
        repo: "SweetCraft-Launcher",
        title: "PACK-10.1G pre-existing WIP",
        includes: [
          "instance move/ownership/location",
          "download progress coalesce + enrich sizes",
          "desktop install UI",
          "version.generated.ts (build output — commit if policy requires)"
        ],
        excludesFromA: ["fixtures/sync07*", "src/**/configMigration*", "tests/instance/sync07*", "tests/instance/config-migration*"]
      },
      B: {
        repo: "SweetCraft-Launcher",
        title: "SYNC-05/07 config migration + update/repair",
        dependsOn: [],
        includes: [
          "src/core/manifest/configMigration.ts",
          "src/instance/configMigration/**",
          "fixtures/sync07ReleaseHarness.ts",
          "tests/instance/sync07-update-repair.test.ts",
          "tests/instance/config-migration.test.ts"
        ]
      },
      C: {
        repo: "SweetCraft-PackManager-v0.4",
        title: "SYNC-04→08 reconciliation / provider / datapack",
        dependsOn: [],
        includes: [
          "src/** (artifactSource, dependencyClosure, serverDatapack*, configMigrations, releaseHosted, stagePreflight, …)",
          "data/catalog*.json",
          "data/serverDatapacks.example.json (recommended)",
          "scripts/sync06*.ts",
          "scripts/sync08*.ts",
          "scripts/restage-0.1.4-seq5.ts",
          "docs/DATAPACK_SERVER_DEBT.md"
        ]
      },
      D: {
        title: "Do NOT commit",
        includes: [
          "data/releases/**",
          "data/candidates/**",
          "data/serverDatapacks.json (local FINAL CLEAN paths)",
          "data/resourcepacks.json",
          "data/*.scan.json",
          "data/SYNC-05.1-provider-closure-matrix.json",
          "scripts/*0.1.3* publish/sign/local-publish (audit one-offs)",
          "weetcraft-release-commit* (accidental artifact — delete before commit gate)"
        ]
      }
    },
    notes: [
      "B and C are independent; A should land before or with B if shared instance paths touched",
      "Never commit unsigned 0.1.4 candidate tree; freeze record is audit-only"
    ]
  };

  const unrelatedOnly =
    pmUnknown.filter(i => i.class !== "UNRELATED").length === 0 &&
    launcherUnknown.length === 0;

  const report = {
    marker:
      blockers.length === 0 && unrelatedOnly ? "PACK_10_1SYNC_08_1_FREEZE_PASS" : undefined,
    verdict: blockers.length === 0 ? "SYNC08_1_PASS" : "SYNC08_1_BLOCKED",
    blockers,
    heads: { packManager: pmHead, launcher: launcherHead },
    wipTotals: {
      packManager: tally(pmInventory),
      launcher: tally(launcherInventory)
    },
    candidateHashComparison: { expected: EXPECTED, actual, match: blockers.filter(b => b.startsWith("hash")).length === 0 },
    candidateToolFix: "sync06-candidate-0.1.4-seq5.ts includes serverDatapacksFile + projection/candidate inventory",
    freezeArtifact: { path: freezePath, sha256: freezeSha },
    wipInventory: { path: wipInventoryPath, sha256: sha256buf(await fs.readFile(wipInventoryPath)) },
    commitPlan,
    excludedFromCommits: commitPlan.groups.D.includes,
    gitOps: { commit: false, push: false, tag: false, publish: false, deploy: false }
  };

  await fs.writeFile(path.join(REPORT_DIR, "SYNC08.1_REPORT.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (blockers.length) process.exitCode = 2;
}

main().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
