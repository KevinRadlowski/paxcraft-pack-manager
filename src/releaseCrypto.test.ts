import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { stageRelease } from "./stage.js";
import { UNIT_TEST_STAGE_BYPASS } from "./releasePreflightTypes.js";
import {
  createEphemeralEd25519Signer,
  UnsignedDevSigner,
  verifyEd25519Pem
} from "./releaseSigning.js";
import { buildReleaseSigningPayload } from "./releasePayload.js";
import { signingFieldsFromRelease, verifyRelease } from "./verifyRelease.js";
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
  return { size_bytes: 1, owner_mod_id: null, ...partial };
}

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sc-crypto-"));
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

function readyCatalog(configs: ConfigRecord[]): Catalog {
  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    generatedFor: { product: "SweetCraft", minecraft: "26.1.2", fabricLoader: "0.19.3", server: "test" },
    mods: [mod({ mod_id: "demo", side_class: "BOTH_REQUIRED" })],
    configs
  };
}

describe("release crypto contract", () => {
  it("valid signature => PASS", async () => {
    await withTemp(async dir => {
      const source = path.join(dir, "pack");
      const sha = await writeConfig(source, "config/demo.json", "signed-ok");
      const catalog = readyCatalog([
        cfg({ path: "config/demo.json", policy: "SERVER_FORCE", target: "BOTH", sha256: sha })
      ]);
      const signer = createEphemeralEd25519Signer("test-key-1");
      const staged = await stageRelease({
      assemblyGate: { mode: "unit-test-bypass" as const, token: UNIT_TEST_STAGE_BYPASS },
        catalog,
        packVersion: "0.9.0",
        sourceRoot: source,
        outDir: path.join(dir, "releases"),
        createdAt: "2026-01-01T00:00:00.000Z",
        signer
      });
      const r = await verifyRelease({
        releaseDir: staged.releaseDir,
        trustedKeys: { "test-key-1": signer.publicKeyPem }
      });
      assert.equal(r.signature, "SIGNED_OK");
      assert.equal(r.releaseIntegrity, "OK");
      assert.equal(r.publishableStable, false); // sequence still null
      assert.equal(r.ok, true);
    });
  });

  it("modified release metadata => FAIL", async () => {
    await withTemp(async dir => {
      const source = path.join(dir, "pack");
      const sha = await writeConfig(source, "config/demo.json", "meta");
      const catalog = readyCatalog([
        cfg({ path: "config/demo.json", policy: "SERVER_FORCE", target: "BOTH", sha256: sha })
      ]);
      const signer = createEphemeralEd25519Signer("test-key-1");
      const staged = await stageRelease({
      assemblyGate: { mode: "unit-test-bypass" as const, token: UNIT_TEST_STAGE_BYPASS },
        catalog,
        packVersion: "0.9.1",
        sourceRoot: source,
        outDir: path.join(dir, "releases"),
        createdAt: "2026-01-01T00:00:00.000Z",
        signer
      });
      const releasePath = path.join(staged.releaseDir, "release.json");
      const release = JSON.parse(await fs.readFile(releasePath, "utf8"));
      release.minecraft = "99.0.0";
      await fs.writeFile(releasePath, JSON.stringify(release, null, 2) + "\n");
      const r = await verifyRelease({
        releaseDir: staged.releaseDir,
        trustedKeys: { "test-key-1": signer.publicKeyPem }
      });
      assert.equal(r.signature, "FAIL");
      assert.ok(r.errors.some(e => /INVALIDE|signature/i.test(e)));
    });
  });

  it("modified checksums hash => FAIL", async () => {
    await withTemp(async dir => {
      const source = path.join(dir, "pack");
      const sha = await writeConfig(source, "config/demo.json", "chk");
      const catalog = readyCatalog([
        cfg({ path: "config/demo.json", policy: "SERVER_FORCE", target: "BOTH", sha256: sha })
      ]);
      const signer = createEphemeralEd25519Signer("test-key-1");
      const staged = await stageRelease({
      assemblyGate: { mode: "unit-test-bypass" as const, token: UNIT_TEST_STAGE_BYPASS },
        catalog,
        packVersion: "0.9.2",
        sourceRoot: source,
        outDir: path.join(dir, "releases"),
        createdAt: "2026-01-01T00:00:00.000Z",
        signer
      });
      const releasePath = path.join(staged.releaseDir, "release.json");
      const release = JSON.parse(await fs.readFile(releasePath, "utf8"));
      release.artefacts.checksums.sha256 = "0".repeat(64);
      await fs.writeFile(releasePath, JSON.stringify(release, null, 2) + "\n");
      const r = await verifyRelease({
        releaseDir: staged.releaseDir,
        trustedKeys: { "test-key-1": signer.publicKeyPem }
      });
      assert.equal(r.ok, false);
      assert.ok(r.errors.some(e => /checksums\.json hash mismatch/i.test(e)));
    });
  });

  it("modified config => FAIL", async () => {
    await withTemp(async dir => {
      const source = path.join(dir, "pack");
      const sha = await writeConfig(source, "config/demo.json", "cfg");
      const catalog = readyCatalog([
        cfg({ path: "config/demo.json", policy: "SERVER_FORCE", target: "BOTH", sha256: sha })
      ]);
      const signer = createEphemeralEd25519Signer("test-key-1");
      const staged = await stageRelease({
      assemblyGate: { mode: "unit-test-bypass" as const, token: UNIT_TEST_STAGE_BYPASS },
        catalog,
        packVersion: "0.9.3",
        sourceRoot: source,
        outDir: path.join(dir, "releases"),
        createdAt: "2026-01-01T00:00:00.000Z",
        signer
      });
      await fs.writeFile(path.join(staged.releaseDir, "files", "config", "demo.json"), "TAMPERED");
      const r = await verifyRelease({
        releaseDir: staged.releaseDir,
        trustedKeys: { "test-key-1": signer.publicKeyPem }
      });
      assert.equal(r.ok, false);
      assert.ok(r.errors.some(e => /SHA-256 mismatch/i.test(e)));
    });
  });

  it("modified manifest => FAIL", async () => {
    await withTemp(async dir => {
      const source = path.join(dir, "pack");
      const sha = await writeConfig(source, "config/demo.json", "man");
      const catalog = readyCatalog([
        cfg({ path: "config/demo.json", policy: "SERVER_FORCE", target: "BOTH", sha256: sha })
      ]);
      const signer = createEphemeralEd25519Signer("test-key-1");
      const staged = await stageRelease({
      assemblyGate: { mode: "unit-test-bypass" as const, token: UNIT_TEST_STAGE_BYPASS },
        catalog,
        packVersion: "0.9.4",
        sourceRoot: source,
        outDir: path.join(dir, "releases"),
        createdAt: "2026-01-01T00:00:00.000Z",
        signer
      });
      const p = path.join(staged.releaseDir, "client-manifest.json");
      const m = JSON.parse(await fs.readFile(p, "utf8"));
      m.packVersion = "9.9.9";
      await fs.writeFile(p, JSON.stringify(m, null, 2) + "\n");
      const r = await verifyRelease({
        releaseDir: staged.releaseDir,
        trustedKeys: { "test-key-1": signer.publicKeyPem }
      });
      assert.equal(r.ok, false);
    });
  });

  it("wrong public key => FAIL", async () => {
    await withTemp(async dir => {
      const source = path.join(dir, "pack");
      const sha = await writeConfig(source, "config/demo.json", "wrongkey");
      const catalog = readyCatalog([
        cfg({ path: "config/demo.json", policy: "SERVER_FORCE", target: "BOTH", sha256: sha })
      ]);
      const signer = createEphemeralEd25519Signer("test-key-1");
      const other = createEphemeralEd25519Signer("test-key-1");
      const staged = await stageRelease({
      assemblyGate: { mode: "unit-test-bypass" as const, token: UNIT_TEST_STAGE_BYPASS },
        catalog,
        packVersion: "0.9.5",
        sourceRoot: source,
        outDir: path.join(dir, "releases"),
        createdAt: "2026-01-01T00:00:00.000Z",
        signer
      });
      const r = await verifyRelease({
        releaseDir: staged.releaseDir,
        trustedKeys: { "test-key-1": other.publicKeyPem }
      });
      assert.equal(r.signature, "FAIL");
    });
  });

  it("unknown key ID => FAIL", async () => {
    await withTemp(async dir => {
      const source = path.join(dir, "pack");
      const sha = await writeConfig(source, "config/demo.json", "unk");
      const catalog = readyCatalog([
        cfg({ path: "config/demo.json", policy: "SERVER_FORCE", target: "BOTH", sha256: sha })
      ]);
      const signer = createEphemeralEd25519Signer("test-key-1");
      const staged = await stageRelease({
      assemblyGate: { mode: "unit-test-bypass" as const, token: UNIT_TEST_STAGE_BYPASS },
        catalog,
        packVersion: "0.9.6",
        sourceRoot: source,
        outDir: path.join(dir, "releases"),
        createdAt: "2026-01-01T00:00:00.000Z",
        signer
      });
      const r = await verifyRelease({
        releaseDir: staged.releaseDir,
        trustedKeys: { "other-id": signer.publicKeyPem }
      });
      assert.equal(r.signature, "FAIL");
      assert.ok(r.errors.some(e => /inconnue/i.test(e)));
    });
  });

  it("modified sequence breaks signature", async () => {
    await withTemp(async dir => {
      const source = path.join(dir, "pack");
      const sha = await writeConfig(source, "config/demo.json", "seq");
      const catalog = readyCatalog([
        cfg({ path: "config/demo.json", policy: "SERVER_FORCE", target: "BOTH", sha256: sha })
      ]);
      const signer = createEphemeralEd25519Signer("test-key-1");
      const staged = await stageRelease({
      assemblyGate: { mode: "unit-test-bypass" as const, token: UNIT_TEST_STAGE_BYPASS },
        catalog,
        packVersion: "0.9.7",
        sourceRoot: source,
        outDir: path.join(dir, "releases"),
        createdAt: "2026-01-01T00:00:00.000Z",
        signer
      });
      const releasePath = path.join(staged.releaseDir, "release.json");
      const release = JSON.parse(await fs.readFile(releasePath, "utf8"));
      release.antiRollback.releaseSequence = 99;
      await fs.writeFile(releasePath, JSON.stringify(release, null, 2) + "\n");
      const r = await verifyRelease({
        releaseDir: staged.releaseDir,
        trustedKeys: { "test-key-1": signer.publicKeyPem }
      });
      assert.equal(r.signature, "FAIL");
    });
  });

  it("unsigned-dev => integrity OK, publishable false", async () => {
    await withTemp(async dir => {
      const source = path.join(dir, "pack");
      const sha = await writeConfig(source, "config/demo.json", "udev");
      const catalog = readyCatalog([
        cfg({ path: "config/demo.json", policy: "SERVER_FORCE", target: "BOTH", sha256: sha })
      ]);
      const staged = await stageRelease({
      assemblyGate: { mode: "unit-test-bypass" as const, token: UNIT_TEST_STAGE_BYPASS },
        catalog,
        packVersion: "0.9.8",
        sourceRoot: source,
        outDir: path.join(dir, "releases"),
        createdAt: "2026-01-01T00:00:00.000Z",
        signer: new UnsignedDevSigner()
      });
      assert.equal(staged.signatureStatus, "unsigned-dev");
      const r = await verifyRelease({ releaseDir: staged.releaseDir });
      assert.equal(r.ok, true);
      assert.equal(r.signature, "UNSIGNED_DEV");
      assert.equal(r.publishableStable, false);
      assert.equal(r.publishableBeta, false);
    });
  });

  it("explicit UnsignedDevSigner ignores SWEETCRAFT_RELEASE_ED25519_PRIVATE_KEY_PEM", async () => {
    await withTemp(async dir => {
      const source = path.join(dir, "pack");
      const sha = await writeConfig(source, "config/demo.json", "udev-env");
      const catalog = readyCatalog([
        cfg({ path: "config/demo.json", policy: "SERVER_FORCE", target: "BOTH", sha256: sha })
      ]);

      const envKey = "SWEETCRAFT_RELEASE_ED25519_PRIVATE_KEY_PEM";
      const prev = process.env[envKey];
      // Ephemeral throwaway PEM only — never read or log a real operator key.
      const { privateKey } = generateKeyPairSync("ed25519");
      const ephemeralPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
      process.env[envKey] = ephemeralPem;
      try {
        const staged = await stageRelease({
      assemblyGate: { mode: "unit-test-bypass" as const, token: UNIT_TEST_STAGE_BYPASS },
          catalog,
          packVersion: "0.9.8-env",
          sourceRoot: source,
          outDir: path.join(dir, "releases"),
          createdAt: "2026-01-01T00:00:00.000Z",
          signer: new UnsignedDevSigner()
        });
        assert.equal(staged.signatureStatus, "unsigned-dev");
        assert.equal(staged.publicKeyId, null);
        const release = JSON.parse(await fs.readFile(path.join(staged.releaseDir, "release.json"), "utf8"));
        assert.equal(release.signature.status, "unsigned-dev");
        assert.equal(release.signature.value, null);
        const r = await verifyRelease({ releaseDir: staged.releaseDir });
        assert.equal(r.signature, "UNSIGNED_DEV");
        assert.equal(r.ok, true);
      } finally {
        if (prev === undefined) delete process.env[envKey];
        else process.env[envKey] = prev;
      }
    });
  });

  it("unexpected file in files/ => ERROR", async () => {
    await withTemp(async dir => {
      const source = path.join(dir, "pack");
      const sha = await writeConfig(source, "config/demo.json", "extra");
      const catalog = readyCatalog([
        cfg({ path: "config/demo.json", policy: "SERVER_FORCE", target: "BOTH", sha256: sha })
      ]);
      const staged = await stageRelease({
      assemblyGate: { mode: "unit-test-bypass" as const, token: UNIT_TEST_STAGE_BYPASS },
        catalog,
        packVersion: "0.9.9",
        sourceRoot: source,
        outDir: path.join(dir, "releases"),
        createdAt: "2026-01-01T00:00:00.000Z",
        signer: new UnsignedDevSigner()
      });
      await fs.writeFile(path.join(staged.releaseDir, "files", "config", "evil.json"), "nope");
      const r = await verifyRelease({ releaseDir: staged.releaseDir });
      assert.equal(r.ok, false);
      assert.ok(r.errors.some(e => /inattendu/i.test(e)));
    });
  });

  it("payload rebuild matches signer bytes (not JSON.stringify)", async () => {
    const signer = createEphemeralEd25519Signer("k");
    const fields = {
      product: "SweetCraft",
      packVersion: "1.0.0",
      minecraft: "26.1.2",
      fabricLoader: "0.19.3",
      server: "x",
      packManagerVersion: "0.5.0",
      catalogSchemaVersion: 2,
      manifestSchemaVersion: 5,
      releaseSchemaVersion: 2,
      configBase: "files/",
      releaseSequence: 3,
      clientManifestSha256: "11".repeat(32),
      serverManifestSha256: "22".repeat(32),
      checksumsSha256: "33".repeat(32)
    };
    const payload = buildReleaseSigningPayload(fields);
    const signed = await signer.sign(payload);
    assert.ok(signed);
    assert.ok(verifyEd25519Pem(signer.publicKeyPem, payload, signed.signatureBase64));
    // Same fields in different object key insertion order still same payload
    const payload2 = buildReleaseSigningPayload({
      checksumsSha256: fields.checksumsSha256,
      product: fields.product,
      packVersion: fields.packVersion,
      minecraft: fields.minecraft,
      fabricLoader: fields.fabricLoader,
      server: fields.server,
      packManagerVersion: fields.packManagerVersion,
      catalogSchemaVersion: fields.catalogSchemaVersion,
      manifestSchemaVersion: fields.manifestSchemaVersion,
      releaseSchemaVersion: fields.releaseSchemaVersion,
      configBase: fields.configBase,
      releaseSequence: fields.releaseSequence,
      clientManifestSha256: fields.clientManifestSha256,
      serverManifestSha256: fields.serverManifestSha256
    });
    assert.deepEqual(payload, payload2);
  });

  it("signingFieldsFromRelease feeds verify path", () => {
    const release = {
      schemaVersion: 2,
      product: "SweetCraft",
      packVersion: "0.1.0",
      minecraft: "26.1.2",
      fabricLoader: "0.19.3",
      server: "s",
      packManagerVersion: "0.5.0",
      catalogSchemaVersion: 2,
      manifestSchemaVersion: 5,
      configBase: "files/",
      antiRollback: { releaseSequence: null },
      artefacts: {
        clientManifest: { path: "client-manifest.json", sha256: "aa".repeat(32) },
        serverManifest: { path: "server-manifest.json", sha256: "bb".repeat(32) },
        checksums: { path: "checksums.json", sha256: "cc".repeat(32) }
      },
      signature: { status: "signed", algorithm: "ed25519", publicKeyId: "k", payload: "SWEETCRAFT-RELEASE-SIGNATURE-V1", value: "x" }
    };
    const p = buildReleaseSigningPayload(signingFieldsFromRelease(release as never));
    assert.ok(p.toString("utf8").includes("releaseSequence=\n"));
  });
});

describe("no private key fixtures", () => {
  it("ephemeral keys only in memory", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const payload = Buffer.from("ping\n");
    const sig = cryptoSign(null, payload, privateKey);
    assert.ok(sig.length > 0);
    assert.ok(publicKey);
  });
});
