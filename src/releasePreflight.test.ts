/**
 * STEP-4.6-M7 — release preflight fixture + regression tests (disposable trees).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import AdmZip from "adm-zip";
import {
  formatReleasePreflightSummary,
  gateCasino,
  gateConfigPolicy,
  gateVersions,
  runReleasePreflight
} from "./releasePreflight.js";
import {
  PREFLIGHT_EXIT,
  UNIT_TEST_STAGE_BYPASS,
  type CasinoProvenanceProof
} from "./releasePreflightTypes.js";
import { StageError, stageRelease } from "./stage.js";
import { CATALOG_SCHEMA_VERSION } from "./types.js";
import type { Catalog, ConfigRecord, ModRecord } from "./types.js";
import { UnsignedDevSigner } from "./releaseSigning.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PM_ROOT = path.resolve(HERE, "..");

/** Locate sweetcraft-content tools for fixture bootstrap (workspace or cert sibling). */
function resolveContentToolsRoot(): string {
  const candidates = [
    process.env.SWEETCRAFT_CONTENT_ROOT,
    path.resolve(PM_ROOT, "..", "..", "sweetcraft-content"),
    path.resolve(PM_ROOT, "..", "content-clean"),
    "H:\\Users\\kevin\\Downloads\\Dev\\XBase\\sweetcraft-content"
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    const sync = path.join(c, "tools", "sync-to-mfc", "lib.mjs");
    const pack = path.join(c, "tools", "pack-rp", "lib.mjs");
    if (existsSync(sync) && existsSync(pack)) return c;
  }
  throw new Error(
    `Cannot locate sweetcraft-content tools (tried ${candidates.join(" | ")})`
  );
}

const REAL_CONTENT = resolveContentToolsRoot();

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sc-m7-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function write(abs: string, body: string | Buffer) {
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, body);
}

function sha256(buf: Buffer | string) {
  return createHash("sha256").update(buf).digest("hex");
}

function jarWithFabricMod(version: string, extra = "x"): Buffer {
  const zip = new AdmZip();
  zip.addFile(
    "fabric.mod.json",
    Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        id: "xbasecasino",
        version,
        name: "XBASE Casino",
        environment: "*"
      }),
      "utf8"
    )
  );
  zip.addFile("META-INF/dummy.txt", Buffer.from(extra));
  return zip.toBuffer();
}

async function copyTools(contentRoot: string) {
  for (const tool of ["sync-to-mfc", "pack-rp"]) {
    const src = path.join(REAL_CONTENT, "tools", tool);
    const dest = path.join(contentRoot, "tools", tool);
    await fs.cp(src, dest, { recursive: true });
  }
}

async function loadPackRp(contentRoot: string) {
  const lib = path.join(contentRoot, "tools", "pack-rp", "lib.mjs");
  return import(pathToFileURL(lib).href);
}

async function buildValidFixture(dir: string, opts?: { withProvenance?: boolean; mismatchCasino?: boolean }) {
  const content = path.join(dir, "content");
  const mfc = path.join(dir, "mfc");
  await copyTools(content);

  // Quests — one managed file pair
  const qBody = '{ id: "i___demo" }\n';
  await write(path.join(content, "quests/ftbquests/quests/chapters/i___demo.json5"), qBody);
  await write(path.join(content, "quests/ftbquests/quests/data.json5"), "{}\n");
  await write(path.join(content, "quests/ftbquests/quests/chapter_groups.json5"), "{}\n");
  await write(path.join(mfc, "server/config/ftbquests/quests/chapters/i___demo.json5"), qBody);
  await write(path.join(mfc, "server/config/ftbquests/quests/data.json5"), "{}\n");
  await write(path.join(mfc, "server/config/ftbquests/quests/chapter_groups.json5"), "{}\n");

  // Datapack
  const dp = "pack.mcmeta";
  const dpBody = '{"pack":{"pack_format":61,"description":"t"}}\n';
  await write(path.join(content, "datapacks/SweetCraft_Quest_Support", dp), dpBody);
  await write(path.join(content, "datapacks/SweetCraft_Quest_Support/data/sc/tags/x.json"), "{}\n");
  await write(path.join(mfc, "server/world/datapacks/SweetCraft_Quest_Support", dp), dpBody);
  await write(
    path.join(mfc, "server/world/datapacks/SweetCraft_Quest_Support/data/sc/tags/x.json"),
    "{}\n"
  );

  // FR RP
  await write(path.join(content, "resourcepacks/sweetcraft-fr/pack.mcmeta"), dpBody);
  await write(path.join(content, "resourcepacks/sweetcraft-fr/assets/sc/lang/fr_fr.json"), '{"a":"b"}\n');
  const pack = await loadPackRp(content);
  const srcRoot = pack.resolveStrict(content, ...String(pack.RP_SOURCE_REL).split(path.sep));
  const built = pack.buildZipBuffer(srcRoot) as { buffer: Buffer; sha256: string };
  const zipBuf = built.buffer;
  const zipSha = built.sha256;
  const zipDest = path.join(mfc, "client/resourcepacks/SweetCraft-FR-v2.7-DETAIL-PASS.zip");
  await write(zipDest, zipBuf);

  // Casino jars
  const ver = "0.9.17-B2.7.2.1+mc26.1.2";
  const jarName = `xbase-casino-${ver}.jar`;
  const jarA = jarWithFabricMod(ver, "same");
  const jarB = opts?.mismatchCasino ? jarWithFabricMod(ver, "DIFF") : jarA;
  const cSha = sha256(jarA);
  await write(path.join(mfc, "client/mods", jarName), jarA);
  await write(path.join(mfc, "server/mods", jarName), jarB);

  const catalog: Catalog = {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    generatedFor: {
      product: "SweetCraft",
      minecraft: "26.1.2",
      fabricLoader: "0.19.3",
      server: "test"
    },
    mods: [
      {
        jar: jarName,
        mod_id: "xbasecasino",
        name: "Casino",
        version: ver,
        size_bytes: jarA.length,
        sha256: cSha,
        side_class: "BOTH_REQUIRED",
        install_client: true,
        install_server: true,
        distribution_policy: "SWEETCRAFT_ALLOWED",
        depends: { java: ">=25", "fabric-api": ">=0.155.2+26.1.2" }
      } as ModRecord,
      {
        jar: "fabric-api-0.155.2+26.1.2.jar",
        mod_id: "fabric-api",
        name: "Fabric API",
        version: "0.155.2+26.1.2",
        size_bytes: 1,
        sha256: "a".repeat(64),
        side_class: "BOTH_REQUIRED",
        install_client: true,
        install_server: true,
        distribution_policy: "UPSTREAM_PREFERRED",
        depends: { java: ">=25" }
      } as ModRecord
    ],
    configs: [
      {
        path: "config/demo.json",
        policy: "SERVER_FORCE",
        target: "BOTH",
        sha256: "b".repeat(64),
        size_bytes: 1,
        owner_mod_id: null
      } as ConfigRecord,
      {
        path: "config/secret.json",
        policy: "EXCLUDED",
        target: "NONE",
        sha256: "c".repeat(64),
        size_bytes: 1,
        owner_mod_id: null
      } as ConfigRecord
    ]
  };
  const catalogPath = path.join(dir, "catalog.json");
  await write(catalogPath, JSON.stringify(catalog, null, 2));

  let provenancePath: string | null = null;
  if (opts?.withProvenance) {
    provenancePath = path.join(dir, "casino-provenance.json");
    const proof: CasinoProvenanceProof = {
      schemaVersion: 1,
      approvedSourceCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      certifiedArtifactSha256: cSha,
      certifiedVersion: ver,
      attestationRef: "fixture://attestation",
      bomRef: "fixture://bom"
    };
    await write(provenancePath, JSON.stringify(proof, null, 2));
  }

  return { content, mfc, catalogPath, catalog, zipSha, cSha, ver, jarName, provenancePath };
}

describe("releasePreflight M7", () => {
  it("fully valid certified fixture → PASS", async () => {
    await withTemp(async dir => {
      const fx = await buildValidFixture(dir, { withProvenance: true });
      const report = await runReleasePreflight({
        contentRoot: fx.content,
        mfcRoot: fx.mfc,
        catalogPath: fx.catalogPath,
        casinoProvenancePath: fx.provenancePath,
        packVersion: "0.1.9",
        releaseSequence: 9,
        approvedFrRpSha256: fx.zipSha,
        requireDatHostExternalVerify: false,
        generatedAt: "2026-09-20T12:00:00.000Z"
      });
      assert.equal(report.status, "PASS", report.summary);
      assert.equal(report.exitCode, PREFLIGHT_EXIT.PASS);
      assert.equal(report.casino.assemblyConsistency, "PASS");
      assert.equal(report.casino.certifiedProvenance, "PASS");
      assert.equal(report.mutable, false);
    });
  });

  it("quest drift → BLOCKED", async () => {
    await withTemp(async dir => {
      const fx = await buildValidFixture(dir, { withProvenance: true });
      await write(
        path.join(fx.content, "quests/ftbquests/quests/chapters/i___demo.json5"),
        "{ drifted }\n"
      );
      const report = await runReleasePreflight({
        contentRoot: fx.content,
        mfcRoot: fx.mfc,
        catalogPath: fx.catalogPath,
        casinoProvenancePath: fx.provenancePath,
        packVersion: "0.1.9",
        releaseSequence: 9,
        approvedFrRpSha256: fx.zipSha,
        requireDatHostExternalVerify: false
      });
      assert.equal(report.status, "BLOCKED");
      assert.ok(report.gates.find(g => g.id === "QUEST_PARITY")?.status === "BLOCKED");
    });
  });

  it("datapack drift → BLOCKED", async () => {
    await withTemp(async dir => {
      const fx = await buildValidFixture(dir, { withProvenance: true });
      await write(
        path.join(fx.mfc, "server/world/datapacks/SweetCraft_Quest_Support/pack.mcmeta"),
        "{drift}\n"
      );
      const report = await runReleasePreflight({
        contentRoot: fx.content,
        mfcRoot: fx.mfc,
        catalogPath: fx.catalogPath,
        casinoProvenancePath: fx.provenancePath,
        packVersion: "0.1.9",
        releaseSequence: 9,
        approvedFrRpSha256: fx.zipSha,
        requireDatHostExternalVerify: false
      });
      assert.equal(report.gates.find(g => g.id === "DATAPACK_PARITY")?.status, "BLOCKED");
      assert.equal(report.status, "BLOCKED");
    });
  });

  it("RP mismatch → BLOCKED", async () => {
    await withTemp(async dir => {
      const fx = await buildValidFixture(dir, { withProvenance: true });
      // Valid ZIP with different content (not matching approved SHA / source)
      await write(
        path.join(fx.content, "resourcepacks/sweetcraft-fr/assets/sc/lang/fr_fr.json"),
        '{"a":"DRIFT"}\n'
      );
      const report = await runReleasePreflight({
        contentRoot: fx.content,
        mfcRoot: fx.mfc,
        catalogPath: fx.catalogPath,
        casinoProvenancePath: fx.provenancePath,
        packVersion: "0.1.9",
        releaseSequence: 9,
        approvedFrRpSha256: fx.zipSha,
        requireDatHostExternalVerify: false
      });
      assert.equal(report.gates.find(g => g.id === "FR_RP")?.status, "BLOCKED");
    });
  });

  it("malformed config policy → BLOCKED", async () => {
    await withTemp(async dir => {
      const fx = await buildValidFixture(dir, { withProvenance: true });
      fx.catalog.configs.push({
        path: "config/bad.json",
        policy: "NOT_A_POLICY",
        target: "BOTH",
        sha256: "d".repeat(64),
        size_bytes: 1,
        owner_mod_id: null
      } as ConfigRecord);
      await write(fx.catalogPath, JSON.stringify(fx.catalog, null, 2));
      const report = await runReleasePreflight({
        contentRoot: fx.content,
        mfcRoot: fx.mfc,
        catalogPath: fx.catalogPath,
        casinoProvenancePath: fx.provenancePath,
        packVersion: "0.1.9",
        releaseSequence: 9,
        approvedFrRpSha256: fx.zipSha,
        requireDatHostExternalVerify: false
      });
      assert.equal(report.gates.find(g => g.id === "CONFIG_POLICY")?.status, "BLOCKED");
    });
  });

  it("EXCLUDED file leakage → BLOCKED", async () => {
    const catalog = {
      schemaVersion: CATALOG_SCHEMA_VERSION,
      generatedFor: { product: "x", minecraft: "26.1.2", fabricLoader: "0.19.3", server: "t" },
      mods: [],
      configs: [
        {
          path: "config/secret.json",
          policy: "EXCLUDED",
          target: "BOTH",
          sha256: "e".repeat(64),
          size_bytes: 1,
          owner_mod_id: null
        } as ConfigRecord
      ]
    } as Catalog;
    const g = gateConfigPolicy(catalog);
    assert.equal(g.status, "BLOCKED");
  });

  it("Casino client/server mismatch → BLOCKED", async () => {
    await withTemp(async dir => {
      const fx = await buildValidFixture(dir, { withProvenance: true, mismatchCasino: true });
      const { gate, evidence } = await gateCasino(fx.catalog, fx.mfc, fx.provenancePath);
      assert.equal(evidence.assemblyConsistency, "BLOCKED");
      assert.equal(gate.status, "BLOCKED");
    });
  });

  it("Casino provenance missing → BLOCKED", async () => {
    await withTemp(async dir => {
      const fx = await buildValidFixture(dir, { withProvenance: false });
      const report = await runReleasePreflight({
        contentRoot: fx.content,
        mfcRoot: fx.mfc,
        catalogPath: fx.catalogPath,
        casinoProvenancePath: null,
        packVersion: "0.1.9",
        releaseSequence: 9,
        approvedFrRpSha256: fx.zipSha,
        requireDatHostExternalVerify: false
      });
      assert.equal(report.casino.assemblyConsistency, "PASS");
      assert.equal(report.casino.certifiedProvenance, "BLOCKED");
      assert.equal(report.status, "BLOCKED");
      assert.match(report.casino.provenanceReason ?? "", /M6-B_PENDING/);
    });
  });

  it("Casino provenance forged/mismatched → BLOCKED", async () => {
    await withTemp(async dir => {
      const fx = await buildValidFixture(dir, { withProvenance: true });
      const forged: CasinoProvenanceProof = {
        schemaVersion: 1,
        approvedSourceCommit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        certifiedArtifactSha256: "f".repeat(64),
        certifiedVersion: fx.ver
      };
      await write(fx.provenancePath!, JSON.stringify(forged));
      const report = await runReleasePreflight({
        contentRoot: fx.content,
        mfcRoot: fx.mfc,
        catalogPath: fx.catalogPath,
        casinoProvenancePath: fx.provenancePath,
        packVersion: "0.1.9",
        releaseSequence: 9,
        approvedFrRpSha256: fx.zipSha,
        requireDatHostExternalVerify: false
      });
      assert.equal(report.casino.certifiedProvenance, "BLOCKED");
      assert.match(report.casino.provenanceReason ?? "", /forged|mismatch/i);
    });
  });

  it("incompatible version matrix → BLOCKED", () => {
    const catalog = {
      schemaVersion: CATALOG_SCHEMA_VERSION,
      generatedFor: { product: "x", minecraft: "26.1.2", fabricLoader: "0.19.3", server: "t" },
      mods: [
        {
          jar: "fabric-api.jar",
          mod_id: "fabric-api",
          name: "Fabric API",
          version: "0.155.2+1.20.1",
          size_bytes: 1,
          sha256: "a".repeat(64),
          side_class: "BOTH_REQUIRED",
          install_client: true,
          install_server: true,
          distribution_policy: "UPSTREAM_PREFERRED",
          depends: { java: ">=25" }
        } as ModRecord
      ],
      configs: []
    } as Catalog;
    const g = gateVersions(catalog, {
      packVersion: "0.1.0",
      releaseSequence: 1,
      requireDatHostExternalVerify: false
    });
    assert.equal(g.status, "BLOCKED");
  });

  it("external-only unknown → EXTERNAL_VERIFY", () => {
    const catalog = {
      schemaVersion: CATALOG_SCHEMA_VERSION,
      generatedFor: { product: "x", minecraft: "26.1.2", fabricLoader: "0.19.3", server: "t" },
      mods: [
        {
          jar: "fabric-api.jar",
          mod_id: "fabric-api",
          name: "Fabric API",
          version: "0.155.2+26.1.2",
          size_bytes: 1,
          sha256: "a".repeat(64),
          side_class: "BOTH_REQUIRED",
          install_client: true,
          install_server: true,
          distribution_policy: "UPSTREAM_PREFERRED",
          depends: { java: ">=25" }
        } as ModRecord
      ],
      configs: []
    } as Catalog;
    const g = gateVersions(catalog, {
      packVersion: "0.1.0",
      releaseSequence: 1,
      requireDatHostExternalVerify: true
    });
    assert.equal(g.status, "EXTERNAL_VERIFY");
  });

  it("missing source/invalid path → ERROR", async () => {
    const report = await runReleasePreflight({
      contentRoot: path.join(os.tmpdir(), "no-such-content-m7"),
      mfcRoot: path.join(os.tmpdir(), "no-such-mfc-m7"),
      catalogPath: path.join(os.tmpdir(), "no-such-catalog-m7.json"),
      generatedAt: "2026-09-20T12:00:00.000Z"
    });
    assert.equal(report.status, "ERROR");
    assert.equal(report.exitCode, PREFLIGHT_EXIT.ERROR);
  });

  it("deterministic repeated report", async () => {
    await withTemp(async dir => {
      const fx = await buildValidFixture(dir, { withProvenance: true });
      const opts = {
        contentRoot: fx.content,
        mfcRoot: fx.mfc,
        catalogPath: fx.catalogPath,
        casinoProvenancePath: fx.provenancePath,
        packVersion: "0.1.9",
        releaseSequence: 9,
        approvedFrRpSha256: fx.zipSha,
        requireDatHostExternalVerify: false,
        generatedAt: "2026-09-20T12:00:00.000Z"
      };
      const a = await runReleasePreflight(opts);
      const b = await runReleasePreflight(opts);
      assert.equal(JSON.stringify(a.gates), JSON.stringify(b.gates));
      assert.equal(a.bom.rpZipSha256, b.bom.rpZipSha256);
      assert.equal(a.status, b.status);
    });
  });

  it("preflight zero mutation", async () => {
    await withTemp(async dir => {
      const fx = await buildValidFixture(dir, { withProvenance: false });
      const before = sha256(await fs.readFile(fx.catalogPath));
      const jarBefore = sha256(await fs.readFile(path.join(fx.mfc, "client/mods", fx.jarName)));
      await runReleasePreflight({
        contentRoot: fx.content,
        mfcRoot: fx.mfc,
        catalogPath: fx.catalogPath,
        packVersion: "0.1.9",
        releaseSequence: 9,
        approvedFrRpSha256: fx.zipSha,
        requireDatHostExternalVerify: false
      });
      assert.equal(sha256(await fs.readFile(fx.catalogPath)), before);
      assert.equal(
        sha256(await fs.readFile(path.join(fx.mfc, "client/mods", fx.jarName))),
        jarBefore
      );
    });
  });

  it("stage blocked before any write (missing assemblyGate)", async () => {
    await withTemp(async dir => {
      const outDir = path.join(dir, "releases");
      await fs.mkdir(outDir, { recursive: true });
      const source = path.join(dir, "pack");
      await write(path.join(source, "config/demo.json"), "{}");
      await assert.rejects(
        () =>
          stageRelease({
            catalog: {
              schemaVersion: CATALOG_SCHEMA_VERSION,
              generatedFor: { product: "x", minecraft: "26.1.2", fabricLoader: "0.19.3", server: "t" },
              mods: [
                {
                  jar: "demo.jar",
                  mod_id: "demo",
                  name: "demo",
                  version: "1",
                  size_bytes: 1,
                  sha256: "a".repeat(64),
                  side_class: "BOTH_REQUIRED",
                  install_client: true,
                  install_server: true,
                  distribution_policy: "UPSTREAM_PREFERRED",
                  modrinth_file_url: "https://example.test/mod.jar"
                } as ModRecord
              ],
              configs: [
                {
                  path: "config/demo.json",
                  policy: "SERVER_FORCE",
                  target: "BOTH",
                  sha256: sha256("{}"),
                  size_bytes: 2,
                  owner_mod_id: null
                } as ConfigRecord
              ]
            },
            packVersion: "0.1.0",
            sourceRoot: source,
            outDir,
            signer: new UnsignedDevSigner()
          }),
        (e: unknown) => e instanceof StageError && /ASSEMBLY_PREFLIGHT_REQUIRED/.test(e.message)
      );
      const entries = await fs.readdir(outDir);
      assert.equal(entries.length, 0);
    });
  });

  it("stage blocked by BLOCKED preflight report before write", async () => {
    await withTemp(async dir => {
      const fx = await buildValidFixture(dir, { withProvenance: false });
      const outDir = path.join(dir, "releases");
      const source = path.join(dir, "pack");
      await write(path.join(source, "config/demo.json"), "{}");
      const report = await runReleasePreflight({
        contentRoot: fx.content,
        mfcRoot: fx.mfc,
        catalogPath: fx.catalogPath,
        packVersion: "0.1.9",
        releaseSequence: 9,
        approvedFrRpSha256: fx.zipSha,
        requireDatHostExternalVerify: false
      });
      assert.equal(report.status, "BLOCKED");
      await assert.rejects(
        () =>
          stageRelease({
            catalog: fx.catalog,
            packVersion: "0.1.9",
            sourceRoot: source,
            outDir,
            signer: new UnsignedDevSigner(),
            assemblyGate: { mode: "report", report }
          }),
        /ASSEMBLY_PREFLIGHT_BLOCKED/
      );
      assert.equal((await fs.readdir(outDir).catch(() => [])).length, 0);
    });
  });

  it("alternate stage entrypoint cannot bypass (no gate)", async () => {
    // Scripts calling stageRelease without assemblyGate fail closed — same as API.
    await withTemp(async dir => {
      await assert.rejects(
        () =>
          stageRelease({
            catalog: {
              schemaVersion: CATALOG_SCHEMA_VERSION,
              generatedFor: { product: "x", minecraft: "26.1.2", fabricLoader: "0.19.3", server: "t" },
              mods: [],
              configs: []
            },
            packVersion: "0.1.0",
            sourceRoot: dir,
            outDir: path.join(dir, "out"),
            signer: new UnsignedDevSigner()
          } as Parameters<typeof stageRelease>[0]),
        /ASSEMBLY_PREFLIGHT_REQUIRED/
      );
    });
  });

  it("unit-test bypass token required (invalid token rejected)", async () => {
    await withTemp(async dir => {
      await assert.rejects(
        () =>
          stageRelease({
            catalog: {
              schemaVersion: CATALOG_SCHEMA_VERSION,
              generatedFor: { product: "x", minecraft: "26.1.2", fabricLoader: "0.19.3", server: "t" },
              mods: [],
              configs: []
            },
            packVersion: "0.1.0",
            sourceRoot: dir,
            outDir: path.join(dir, "out"),
            signer: new UnsignedDevSigner(),
            assemblyGate: {
              mode: "unit-test-bypass",
              token: Symbol.for("wrong") as typeof UNIT_TEST_STAGE_BYPASS
            }
          }),
        /bypass token invalide/
      );
    });
  });

  it("summary formatter includes status", async () => {
    await withTemp(async dir => {
      const fx = await buildValidFixture(dir, { withProvenance: false });
      const report = await runReleasePreflight({
        contentRoot: fx.content,
        mfcRoot: fx.mfc,
        catalogPath: fx.catalogPath,
        packVersion: "0.1.9",
        releaseSequence: 9,
        approvedFrRpSha256: fx.zipSha,
        requireDatHostExternalVerify: false
      });
      const s = formatReleasePreflightSummary(report);
      assert.match(s, /BLOCKED/);
      assert.match(s, /CASINO/);
    });
  });
});
