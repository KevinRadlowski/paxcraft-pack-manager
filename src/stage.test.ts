import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  assertSafeConfigPath,
  StageError,
  stageRelease,
  stagedConfigRelativePath
} from "./stage.js";
import { UNIT_TEST_STAGE_BYPASS } from "./releasePreflightTypes.js";
import { UnsignedDevSigner, createEphemeralEd25519Signer, verifyEd25519Pem } from "./releaseSigning.js";
import { buildReleaseSigningPayload } from "./releasePayload.js";
import { CATALOG_SCHEMA_VERSION } from "./types.js";
import type { Catalog, ConfigRecord, ModRecord } from "./types.js";

function mod(partial: Partial<ModRecord> & Pick<ModRecord, "mod_id" | "side_class">): ModRecord {
  return {
    jar: `${partial.mod_id}.jar`,
    name: partial.mod_id,
    version: "1",
    size_bytes: 1,
    sha256: "a".repeat(64),
    sha512: "b".repeat(128),
    install_client: partial.side_class !== "SERVER_ONLY",
    install_server: partial.side_class !== "CLIENT_ONLY",
    distribution_policy: "UPSTREAM_PREFERRED",
    modrinth_file_url: "https://example.test/mod.jar",
    ...partial
  };
}

function cfg(partial: Partial<ConfigRecord> & Pick<ConfigRecord, "path" | "policy" | "target" | "sha256">): ConfigRecord {
  return {
    size_bytes: 1,
    owner_mod_id: null,
    ...partial
  };
}

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sc-stage-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function writeConfig(root: string, rel: string, content: string | Buffer) {
  const abs = path.join(root, ...rel.split("/"));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
  return createHash("sha256").update(typeof content === "string" ? Buffer.from(content) : content).digest("hex");
}

function readyCatalog(configs: ConfigRecord[], mods: ModRecord[] = [mod({ mod_id: "demo", side_class: "BOTH_REQUIRED" })]): Catalog {
  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    generatedFor: { product: "SweetCraft", minecraft: "26.1.2", fabricLoader: "0.19.3", server: "test" },
    mods,
    configs
  };
}

describe("path safety", () => {
  it("accepts config/ relative paths", () => {
    assert.doesNotThrow(() => assertSafeConfigPath("config/alexsmobs/x.json"));
  });
  it("rejects traversal and absolute", () => {
    assert.throws(() => assertSafeConfigPath("config/../secret"), StageError);
    assert.throws(() => assertSafeConfigPath("C:/config/x.json"), StageError);
    assert.throws(() => assertSafeConfigPath("/etc/passwd"), StageError);
    assert.throws(() => assertSafeConfigPath("config\\win.json"), StageError);
  });
  it("staged path uses files/ prefix", () => {
    assert.equal(stagedConfigRelativePath("config/a.json"), "files/config/a.json");
  });
});

describe("stageRelease", () => {
  it("stages nominal release byte-for-byte with matching sha256", async () => {
    await withTemp(async dir => {
      const source = path.join(dir, "pack");
      const outDir = path.join(dir, "releases");
      const body = Buffer.from('{"spawn":true}\n');
      const sha = await writeConfig(source, "config/demo.json", body);
      const catalog = readyCatalog([
        cfg({ path: "config/demo.json", policy: "SERVER_FORCE", target: "BOTH", sha256: sha, size_bytes: body.length })
      ]);
      const result = await stageRelease({
        assemblyGate: { mode: "unit-test-bypass", token: UNIT_TEST_STAGE_BYPASS },
        catalog,
        packVersion: "0.1.0",
        sourceRoot: source,
        outDir,
        createdAt: "2026-01-01T00:00:00.000Z",
        signer: new UnsignedDevSigner()
      });
      assert.equal(result.configsStaged, 1);
      assert.equal(result.signatureStatus, "unsigned-dev");
      const staged = path.join(result.releaseDir, "files", "config", "demo.json");
      const copied = await fs.readFile(staged);
      assert.deepEqual(copied, body);
      const release = JSON.parse(await fs.readFile(path.join(result.releaseDir, "release.json"), "utf8"));
      assert.equal(release.packVersion, "0.1.0");
      assert.equal(release.configBase, "files/");
      assert.equal(release.signature.status, "unsigned-dev");
      assert.equal(release.antiRollback.releaseSequence, null);
      const client = JSON.parse(await fs.readFile(path.join(result.releaseDir, "client-manifest.json"), "utf8"));
      assert.equal(client.configBase, "files/");
      assert.ok(client.configs.some((c: { path: string }) => c.path === "config/demo.json"));
      const checksums = JSON.parse(await fs.readFile(path.join(result.releaseDir, "checksums.json"), "utf8"));
      assert.ok(checksums.entries.some((e: { path: string }) => e.path === "files/config/demo.json"));
    });
  });

  it("hash mismatch => ERROR and temp cleaned", async () => {
    await withTemp(async dir => {
      const source = path.join(dir, "pack");
      const outDir = path.join(dir, "releases");
      await writeConfig(source, "config/demo.json", "real");
      const catalog = readyCatalog([
        cfg({ path: "config/demo.json", policy: "SERVER_FORCE", target: "BOTH", sha256: "0".repeat(64) })
      ]);
      await assert.rejects(
        () => stageRelease({
        assemblyGate: { mode: "unit-test-bypass", token: UNIT_TEST_STAGE_BYPASS }, catalog, packVersion: "0.1.0", sourceRoot: source, outDir, signer: new UnsignedDevSigner() }),
        /SHA-256 mismatch/
      );
      const entries = await fs.readdir(outDir).catch(() => [] as string[]);
      assert.ok(!entries.some(e => e.startsWith(".tmp-")));
      assert.ok(!entries.includes("0.1.0"));
    });
  });

  it("missing source => ERROR", async () => {
    await withTemp(async dir => {
      const source = path.join(dir, "pack");
      await fs.mkdir(source, { recursive: true });
      const catalog = readyCatalog([
        cfg({ path: "config/missing.json", policy: "SERVER_FORCE", target: "BOTH", sha256: "a".repeat(64) })
      ]);
      await assert.rejects(
        () => stageRelease({
        assemblyGate: { mode: "unit-test-bypass", token: UNIT_TEST_STAGE_BYPASS },
          catalog,
          packVersion: "0.1.0",
          sourceRoot: source,
          outDir: path.join(dir, "releases"),
          signer: new UnsignedDevSigner()
        }),
        /absent/
      );
    });
  });

  it("EXCLUDED never staged", async () => {
    await withTemp(async dir => {
      const source = path.join(dir, "pack");
      const outDir = path.join(dir, "releases");
      const keep = await writeConfig(source, "config/keep.json", "keep");
      await writeConfig(source, "config/secret.json", "secret");
      const catalog = readyCatalog([
        cfg({ path: "config/keep.json", policy: "SERVER_FORCE", target: "BOTH", sha256: keep }),
        cfg({ path: "config/secret.json", policy: "EXCLUDED", target: "NONE", sha256: "c".repeat(64) })
      ]);
      const result = await stageRelease({
        assemblyGate: { mode: "unit-test-bypass", token: UNIT_TEST_STAGE_BYPASS },
        catalog,
        packVersion: "0.1.0",
        sourceRoot: source,
        outDir,
        createdAt: "2026-01-01T00:00:00.000Z",
        signer: new UnsignedDevSigner()
      });
      assert.equal(result.configsStaged, 1);
      assert.equal(result.excluded, 1);
      await assert.rejects(fs.access(path.join(result.releaseDir, "files", "config", "secret.json")));
    });
  });

  it("destination exists refused without --force", async () => {
    await withTemp(async dir => {
      const source = path.join(dir, "pack");
      const outDir = path.join(dir, "releases");
      const sha = await writeConfig(source, "config/demo.json", "x");
      const catalog = readyCatalog([
        cfg({ path: "config/demo.json", policy: "CLIENT_DEFAULT", target: "CLIENT", sha256: sha })
      ]);
      await stageRelease({
        assemblyGate: { mode: "unit-test-bypass", token: UNIT_TEST_STAGE_BYPASS },
        catalog,
        packVersion: "0.1.0",
        sourceRoot: source,
        outDir,
        createdAt: "2026-01-01T00:00:00.000Z",
        signer: new UnsignedDevSigner()
      });
      await assert.rejects(
        () => stageRelease({
        assemblyGate: { mode: "unit-test-bypass", token: UNIT_TEST_STAGE_BYPASS },
          catalog,
          packVersion: "0.1.0",
          sourceRoot: source,
          outDir,
          createdAt: "2026-01-01T00:00:00.000Z",
          signer: new UnsignedDevSigner()
        }),
        /déjà présente/
      );
    });
  });

  it("RELEASE_READY false => staging refused", async () => {
    await withTemp(async dir => {
      const catalog = readyCatalog([
        cfg({ path: "config/x.json", policy: "COMMON_FORCE_REVIEW", target: "BOTH", sha256: "d".repeat(64) })
      ]);
      await assert.rejects(
        () => stageRelease({
        assemblyGate: { mode: "unit-test-bypass", token: UNIT_TEST_STAGE_BYPASS },
          catalog,
          packVersion: "0.1.0",
          sourceRoot: path.join(dir, "pack"),
          outDir: path.join(dir, "releases"),
          signer: new UnsignedDevSigner()
        }),
        /RELEASE_READY=NO/
      );
    });
  });

  it("checksums deterministic across two runs with fixed createdAt", async () => {
    await withTemp(async dir => {
      const source = path.join(dir, "pack");
      const sha = await writeConfig(source, "config/demo.json", Buffer.from([1, 2, 3, 4]));
      const catalog = readyCatalog([
        cfg({ path: "config/demo.json", policy: "SERVER_FORCE", target: "SERVER", sha256: sha })
      ]);
      const a = await stageRelease({
        assemblyGate: { mode: "unit-test-bypass", token: UNIT_TEST_STAGE_BYPASS },
        catalog,
        packVersion: "0.2.0",
        sourceRoot: source,
        outDir: path.join(dir, "r1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        signer: new UnsignedDevSigner()
      });
      const b = await stageRelease({
        assemblyGate: { mode: "unit-test-bypass", token: UNIT_TEST_STAGE_BYPASS },
        catalog,
        packVersion: "0.2.0",
        sourceRoot: source,
        outDir: path.join(dir, "r2"),
        createdAt: "2026-01-01T00:00:00.000Z",
        signer: new UnsignedDevSigner()
      });
      const ca = await fs.readFile(path.join(a.releaseDir, "checksums.json"), "utf8");
      const cb = await fs.readFile(path.join(b.releaseDir, "checksums.json"), "utf8");
      assert.equal(ca, cb);
      const ma = await fs.readFile(path.join(a.releaseDir, "client-manifest.json"), "utf8");
      const mb = await fs.readFile(path.join(b.releaseDir, "client-manifest.json"), "utf8");
      // generatedAt is fixed only on release.json; manifests use Date.now — compare configs/mods structure via parse
      const ja = JSON.parse(ma);
      const jb = JSON.parse(mb);
      assert.deepEqual(ja.configs, jb.configs);
      assert.deepEqual(ja.mods, jb.mods);
      assert.equal(ja.configBase, jb.configBase);
    });
  });

  it("optional Ed25519 signer can sign digest", async () => {
    await withTemp(async dir => {
      const source = path.join(dir, "pack");
      const sha = await writeConfig(source, "config/demo.json", "signed");
      const catalog = readyCatalog([
        cfg({ path: "config/demo.json", policy: "SERVER_FORCE", target: "BOTH", sha256: sha })
      ]);
      const signer = createEphemeralEd25519Signer();
      const result = await stageRelease({
        assemblyGate: { mode: "unit-test-bypass", token: UNIT_TEST_STAGE_BYPASS },
        catalog,
        packVersion: "0.3.0",
        sourceRoot: source,
        outDir: path.join(dir, "releases"),
        createdAt: "2026-01-01T00:00:00.000Z",
        signer
      });
      assert.equal(result.signatureStatus, "signed");
      const release = JSON.parse(await fs.readFile(path.join(result.releaseDir, "release.json"), "utf8"));
      assert.ok(release.signature.value);
      assert.equal(release.signature.payload, "SWEETCRAFT-RELEASE-SIGNATURE-V1");
      const payload = buildReleaseSigningPayload({
        product: "SweetCraft",
        packVersion: "0.3.0",
        minecraft: catalog.generatedFor.minecraft,
        fabricLoader: catalog.generatedFor.fabricLoader,
        server: catalog.generatedFor.server,
        packManagerVersion: release.packManagerVersion,
        catalogSchemaVersion: release.catalogSchemaVersion,
        manifestSchemaVersion: release.manifestSchemaVersion,
        releaseSchemaVersion: release.schemaVersion,
        configBase: release.configBase,
        releaseSequence: release.antiRollback.releaseSequence,
        clientManifestSha256: release.artefacts.clientManifest.sha256,
        serverManifestSha256: release.artefacts.serverManifest.sha256,
        checksumsSha256: release.artefacts.checksums.sha256
      });
      assert.ok(verifyEd25519Pem(signer.publicKeyPem, payload, release.signature.value));
    });
  });
});
