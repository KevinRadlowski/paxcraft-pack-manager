import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { stageRelease } from "./stage.js";
import { UNIT_TEST_STAGE_BYPASS } from "./releasePreflightTypes.js";
import { publishRelease, PublishError } from "./publish.js";
import { createEphemeralEd25519Signer, UnsignedDevSigner } from "./releaseSigning.js";
import { verifyRelease } from "./verifyRelease.js";
import { verifyChannelDescriptor, assertSafeReleasePath } from "./verifyChannel.js";
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sc-pub-"));
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

async function stageMini(dir: string, version = "0.1.0") {
  const source = path.join(dir, "pack");
  const outDir = path.join(dir, "releases");
  const body = "cfg-body";
  const sha = await writeConfig(source, "config/demo.json", body);
  const catalog = readyCatalog([
    cfg({ path: "config/demo.json", policy: "SERVER_FORCE", target: "BOTH", sha256: sha, size_bytes: body.length })
  ]);
  const staged = await stageRelease({
      assemblyGate: { mode: "unit-test-bypass" as const, token: UNIT_TEST_STAGE_BYPASS },
    catalog,
    packVersion: version,
    sourceRoot: source,
    outDir,
    createdAt: "2026-01-01T00:00:00.000Z",
    signer: new UnsignedDevSigner()
  });
  return staged;
}

describe("assertSafeReleasePath", () => {
  it("accepts canonical path", () => {
    assert.doesNotThrow(() => assertSafeReleasePath("releases/0.1.0/release.json", "0.1.0"));
  });
  it("rejects traversal and absolute", () => {
    assert.throws(() => assertSafeReleasePath("releases/../x/release.json"));
    assert.throws(() => assertSafeReleasePath("C:/releases/0.1.0/release.json"));
    assert.throws(() => assertSafeReleasePath("releases/0.1.0/release.json", "9.9.9"));
  });
});

describe("publishRelease", () => {
  it("signed dev publication", async () => {
    await withTemp(async dir => {
      const staged = await stageMini(dir);
      const signer = createEphemeralEd25519Signer("test-pub-1");
      const r = await publishRelease({
        releaseDir: staged.releaseDir,
        channel: "dev",
        sequence: 1,
        outDir: path.join(dir, "publish"),
        signer,
        trustedKeys: { "test-pub-1": signer.publicKeyPem }
      });
      assert.equal(r.releaseSignature, "SIGNED");
      assert.equal(r.channelSignature, "SIGNED");
      assert.equal(r.releaseSequence, 1);
      assert.equal(r.remoteUpload, "NOT_PERFORMED");
      const vr = await verifyRelease({
        releaseDir: r.releaseDir,
        trustedKeys: { "test-pub-1": signer.publicKeyPem }
      });
      assert.equal(vr.signature, "SIGNED_OK");
      assert.equal(vr.ok, true);
      const vc = await verifyChannelDescriptor({
        channelFile: r.channelFile,
        root: path.join(dir, "publish"),
        trustedKeys: { "test-pub-1": signer.publicKeyPem }
      });
      assert.equal(vc.ok, true);
      assert.equal(vc.channelSignature, "SIGNED_OK");
    });
  });

  it("unsigned dev with flag", async () => {
    await withTemp(async dir => {
      const staged = await stageMini(dir);
      const r = await publishRelease({
        releaseDir: staged.releaseDir,
        channel: "dev",
        sequence: 1,
        outDir: path.join(dir, "publish"),
        allowUnsignedDev: true
      });
      assert.equal(r.releaseSignature, "UNSIGNED_DEV");
      assert.equal(r.channelSignature, "UNSIGNED_DEV");
    });
  });

  it("unsigned dev without flag => ERROR", async () => {
    await withTemp(async dir => {
      const staged = await stageMini(dir);
      await assert.rejects(
        () =>
          publishRelease({
            releaseDir: staged.releaseDir,
            channel: "dev",
            sequence: 1,
            outDir: path.join(dir, "publish")
          }),
        PublishError
      );
    });
  });

  it("unsigned beta => ERROR", async () => {
    await withTemp(async dir => {
      const staged = await stageMini(dir);
      await assert.rejects(
        () =>
          publishRelease({
            releaseDir: staged.releaseDir,
            channel: "beta",
            sequence: 1,
            outDir: path.join(dir, "publish"),
            allowUnsignedDev: true,
            signer: new UnsignedDevSigner()
          }),
        /unsigned|beta|dev/i
      );
    });
  });

  it("unsigned stable => ERROR", async () => {
    await withTemp(async dir => {
      const staged = await stageMini(dir);
      await assert.rejects(
        () =>
          publishRelease({
            releaseDir: staged.releaseDir,
            channel: "stable",
            sequence: 1,
            outDir: path.join(dir, "publish"),
            signer: new UnsignedDevSigner()
          }),
        PublishError
      );
    });
  });

  it("sequence rules", async () => {
    await withTemp(async dir => {
      const staged = await stageMini(dir, "0.1.0");
      const signer = createEphemeralEd25519Signer("k");
      const keys = { k: signer.publicKeyPem };
      const outDir = path.join(dir, "publish");
      await publishRelease({
        releaseDir: staged.releaseDir,
        channel: "dev",
        sequence: 1,
        outDir,
        signer,
        trustedKeys: keys
      });
      // same packVersion immutable — need new staging version for next publish of different release
      const staged2 = await stageMini(dir, "0.2.0");
      await assert.rejects(
        () =>
          publishRelease({
            releaseDir: staged2.releaseDir,
            channel: "dev",
            sequence: 1,
            outDir,
            signer,
            trustedKeys: keys
          }),
        /strictement supérieure/
      );
      await assert.rejects(
        () =>
          publishRelease({
            releaseDir: staged2.releaseDir,
            channel: "dev",
            sequence: 0,
            outDir,
            signer,
            trustedKeys: keys
          }),
        /entier positif/
      );
      await publishRelease({
        releaseDir: staged2.releaseDir,
        channel: "dev",
        sequence: 2,
        outDir,
        signer,
        trustedKeys: keys
      });
    });
  });

  it("existing release immutable", async () => {
    await withTemp(async dir => {
      const staged = await stageMini(dir);
      const signer = createEphemeralEd25519Signer("k");
      const outDir = path.join(dir, "publish");
      await publishRelease({
        releaseDir: staged.releaseDir,
        channel: "dev",
        sequence: 1,
        outDir,
        signer,
        trustedKeys: { k: signer.publicKeyPem }
      });
      // republish same packVersion to another channel still blocked by immutability
      await assert.rejects(
        () =>
          publishRelease({
            releaseDir: staged.releaseDir,
            channel: "beta",
            sequence: 1,
            outDir,
            signer,
            trustedKeys: { k: signer.publicKeyPem }
          }),
        /immutable/
      );
    });
  });

  it("checksums staging == published; staging unchanged", async () => {
    await withTemp(async dir => {
      const staged = await stageMini(dir);
      const beforeChecksums = await fs.readFile(path.join(staged.releaseDir, "checksums.json"));
      const beforeRelease = await fs.readFile(path.join(staged.releaseDir, "release.json"));
      const signer = createEphemeralEd25519Signer("k");
      const r = await publishRelease({
        releaseDir: staged.releaseDir,
        channel: "dev",
        sequence: 1,
        outDir: path.join(dir, "publish"),
        signer,
        trustedKeys: { k: signer.publicKeyPem }
      });
      const afterChecksums = await fs.readFile(path.join(r.releaseDir, "checksums.json"));
      assert.deepEqual(afterChecksums, beforeChecksums);
      const stagingStill = await fs.readFile(path.join(staged.releaseDir, "release.json"));
      assert.deepEqual(stagingStill, beforeRelease);
      const pubRelease = JSON.parse(await fs.readFile(path.join(r.releaseDir, "release.json"), "utf8"));
      assert.equal(pubRelease.antiRollback.releaseSequence, 1);
      assert.equal(pubRelease.signature.status, "signed");
    });
  });

  it("tamper sequence after sign => verify FAIL", async () => {
    await withTemp(async dir => {
      const staged = await stageMini(dir);
      const signer = createEphemeralEd25519Signer("k");
      const r = await publishRelease({
        releaseDir: staged.releaseDir,
        channel: "dev",
        sequence: 1,
        outDir: path.join(dir, "publish"),
        signer,
        trustedKeys: { k: signer.publicKeyPem }
      });
      const p = path.join(r.releaseDir, "release.json");
      const rel = JSON.parse(await fs.readFile(p, "utf8"));
      rel.antiRollback.releaseSequence = 99;
      await fs.writeFile(p, JSON.stringify(rel, null, 2) + "\n");
      const vr = await verifyRelease({
        releaseDir: r.releaseDir,
        trustedKeys: { k: signer.publicKeyPem }
      });
      assert.equal(vr.signature, "FAIL");
    });
  });

  it("tamper channel / path / sha => FAIL", async () => {
    await withTemp(async dir => {
      const staged = await stageMini(dir);
      const signer = createEphemeralEd25519Signer("k");
      const outDir = path.join(dir, "publish");
      const r = await publishRelease({
        releaseDir: staged.releaseDir,
        channel: "dev",
        sequence: 1,
        outDir,
        signer,
        trustedKeys: { k: signer.publicKeyPem }
      });
      const chPath = r.channelFile;
      const ch = JSON.parse(await fs.readFile(chPath, "utf8"));

      ch.releaseSequence = 2;
      await fs.writeFile(chPath, JSON.stringify(ch, null, 2) + "\n");
      let vc = await verifyChannelDescriptor({
        channelFile: chPath,
        root: outDir,
        trustedKeys: { k: signer.publicKeyPem }
      });
      assert.equal(vc.ok, false);

      // restore from republish not available — rewrite original-like tamper path
      ch.releaseSequence = 1;
      ch.releasePath = "releases/evil/release.json";
      await fs.writeFile(chPath, JSON.stringify(ch, null, 2) + "\n");
      vc = await verifyChannelDescriptor({
        channelFile: chPath,
        root: outDir,
        trustedKeys: { k: signer.publicKeyPem }
      });
      assert.equal(vc.ok, false);

      ch.releasePath = "releases/0.1.0/release.json";
      ch.releaseSha256 = "0".repeat(64);
      await fs.writeFile(chPath, JSON.stringify(ch, null, 2) + "\n");
      vc = await verifyChannelDescriptor({
        channelFile: chPath,
        root: outDir,
        trustedKeys: { k: signer.publicKeyPem }
      });
      assert.equal(vc.ok, false);
    });
  });

  it("wrong key / unknown key id => FAIL", async () => {
    await withTemp(async dir => {
      const staged = await stageMini(dir);
      const signer = createEphemeralEd25519Signer("k");
      const other = createEphemeralEd25519Signer("k");
      const r = await publishRelease({
        releaseDir: staged.releaseDir,
        channel: "dev",
        sequence: 1,
        outDir: path.join(dir, "publish"),
        signer,
        trustedKeys: { k: signer.publicKeyPem }
      });
      let vr = await verifyRelease({
        releaseDir: r.releaseDir,
        trustedKeys: { k: other.publicKeyPem }
      });
      assert.equal(vr.signature, "FAIL");
      vr = await verifyRelease({
        releaseDir: r.releaseDir,
        trustedKeys: { other: signer.publicKeyPem }
      });
      assert.equal(vr.signature, "FAIL");
    });
  });

  it("E2E: publish then config tamper fails verify", async () => {
    await withTemp(async dir => {
      const staged = await stageMini(dir);
      const signer = createEphemeralEd25519Signer("e2e-key");
      const outDir = path.join(dir, "publish");
      const r = await publishRelease({
        releaseDir: staged.releaseDir,
        channel: "dev",
        sequence: 1,
        outDir,
        signer,
        trustedKeys: { "e2e-key": signer.publicKeyPem }
      });
      const vc = await verifyChannelDescriptor({
        channelFile: r.channelFile,
        root: outDir,
        trustedKeys: { "e2e-key": signer.publicKeyPem }
      });
      assert.equal(vc.ok, true);
      await fs.writeFile(path.join(r.releaseDir, "files", "config", "demo.json"), "TAMPER");
      const vr = await verifyRelease({
        releaseDir: r.releaseDir,
        trustedKeys: { "e2e-key": signer.publicKeyPem }
      });
      assert.equal(vr.ok, false);
      assert.ok(vr.errors.some(e => /SHA-256/i.test(e)));
    });
  });

  it("publication failure leaves no partial state", async () => {
    await withTemp(async dir => {
      const staged = await stageMini(dir);
      const outDir = path.join(dir, "publish");
      await assert.rejects(
        () =>
          publishRelease({
            releaseDir: staged.releaseDir,
            channel: "stable",
            sequence: 1,
            outDir,
            signer: new UnsignedDevSigner()
          }),
        PublishError
      );
      const entries = await fs.readdir(outDir).catch(() => [] as string[]);
      assert.ok(!entries.some(e => e.startsWith(".tmp-publish-")));
      assert.ok(!(await fs.access(path.join(outDir, "releases", "0.1.0")).then(() => true).catch(() => false)));
      assert.ok(!(await fs.access(path.join(outDir, "channels", "stable.json")).then(() => true).catch(() => false)));
    });
  });

  it("channel update: newer packVersion + higher sequence replaces pointer; old release kept", async () => {
    await withTemp(async dir => {
      const signer = createEphemeralEd25519Signer("ch-upd");
      const keys = { "ch-upd": signer.publicKeyPem };
      const outDir = path.join(dir, "publish");
      const a = await stageMini(dir, "0.1.0");
      await publishRelease({
        releaseDir: a.releaseDir,
        channel: "dev",
        sequence: 1,
        outDir,
        signer,
        trustedKeys: keys
      });
      const b = await stageMini(dir, "0.1.1");
      const r2 = await publishRelease({
        releaseDir: b.releaseDir,
        channel: "dev",
        sequence: 2,
        outDir,
        signer,
        trustedKeys: keys
      });
      const ch = JSON.parse(await fs.readFile(r2.channelFile, "utf8"));
      assert.equal(ch.packVersion, "0.1.1");
      assert.equal(ch.releaseSequence, 2);
      assert.equal(ch.releasePath, "releases/0.1.1/release.json");
      await fs.access(path.join(outDir, "releases", "0.1.0", "release.json"));
      await fs.access(path.join(outDir, "releases", "0.1.1", "release.json"));
      const vc = await verifyChannelDescriptor({
        channelFile: r2.channelFile,
        root: outDir,
        trustedKeys: keys
      });
      assert.equal(vc.ok, true);
    });
  });

  it("same/lower sequence after existing channel => FAIL; channel preserved", async () => {
    await withTemp(async dir => {
      const signer = createEphemeralEd25519Signer("seq-fail");
      const keys = { "seq-fail": signer.publicKeyPem };
      const outDir = path.join(dir, "publish");
      const a = await stageMini(dir, "0.1.0");
      await publishRelease({
        releaseDir: a.releaseDir,
        channel: "dev",
        sequence: 3,
        outDir,
        signer,
        trustedKeys: keys
      });
      const before = await fs.readFile(path.join(outDir, "channels", "dev.json"), "utf8");
      const b = await stageMini(dir, "0.1.1");
      await assert.rejects(
        () =>
          publishRelease({
            releaseDir: b.releaseDir,
            channel: "dev",
            sequence: 3,
            outDir,
            signer,
            trustedKeys: keys
          }),
        /strictement supérieure|CHANNEL_SEQUENCE_RACE/
      );
      await assert.rejects(
        () =>
          publishRelease({
            releaseDir: b.releaseDir,
            channel: "dev",
            sequence: 2,
            outDir,
            signer,
            trustedKeys: keys
          }),
        /strictement supérieure|CHANNEL_SEQUENCE_RACE/
      );
      const after = await fs.readFile(path.join(outDir, "channels", "dev.json"), "utf8");
      assert.equal(after, before);
      assert.ok(!(await fs.access(path.join(outDir, "releases", "0.1.1")).then(() => true).catch(() => false)));
    });
  });

  it("race: higher sequence discovered before channel commit => CHANNEL_SEQUENCE_RACE, no orphan", async () => {
    await withTemp(async dir => {
      const signer = createEphemeralEd25519Signer("race-k");
      const keys = { "race-k": signer.publicKeyPem };
      const outDir = path.join(dir, "publish");

      // Seed channel at sequence 4 via pack 0.0.4
      const seed = await stageMini(dir, "0.0.4");
      await publishRelease({
        releaseDir: seed.releaseDir,
        channel: "dev",
        sequence: 4,
        outDir,
        signer,
        trustedKeys: keys
      });

      const low = await stageMini(dir, "0.0.5");
      const high = await stageMini(dir, "0.0.6");

      await assert.rejects(
        () =>
          publishRelease({
            releaseDir: low.releaseDir,
            channel: "dev",
            sequence: 5,
            outDir,
            signer,
            trustedKeys: keys,
            testHooks: {
              afterReleaseMovedBeforeChannelCommit: async () => {
                // Concurrent publisher B commits sequence 6
                await publishRelease({
                  releaseDir: high.releaseDir,
                  channel: "dev",
                  sequence: 6,
                  outDir,
                  signer,
                  trustedKeys: keys
                });
              }
            }
          }),
        (err: unknown) => {
          assert.ok(err instanceof PublishError);
          assert.match(err.message, /CHANNEL_SEQUENCE_RACE/);
          return true;
        }
      );

      const ch = JSON.parse(await fs.readFile(path.join(outDir, "channels", "dev.json"), "utf8"));
      assert.equal(ch.releaseSequence, 6);
      assert.equal(ch.packVersion, "0.0.6");
      // Losing publisher's release must be rolled back (no orphan)
      assert.ok(!(await fs.access(path.join(outDir, "releases", "0.0.5")).then(() => true).catch(() => false)));
      // Winner's release remains
      await fs.access(path.join(outDir, "releases", "0.0.6", "release.json"));
      // Seed release remains
      await fs.access(path.join(outDir, "releases", "0.0.4", "release.json"));

      const vc = await verifyChannelDescriptor({
        channelFile: path.join(outDir, "channels", "dev.json"),
        root: outDir,
        trustedKeys: keys
      });
      assert.equal(vc.ok, true);
    });
  });
});

describe("replaceFileAtomically", () => {
  it("creates and replaces on real temp filesystem", async () => {
    const { replaceFileAtomically } = await import("./publish.js");
    await withTemp(async dir => {
      const src1 = path.join(dir, "a.json");
      const src2 = path.join(dir, "b.json");
      const dest = path.join(dir, "channels", "dev.json");
      await fs.writeFile(src1, '{"v":1}\n');
      await replaceFileAtomically(src1, dest);
      assert.equal(await fs.readFile(dest, "utf8"), '{"v":1}\n');
      await fs.writeFile(src2, '{"v":2}\n');
      await replaceFileAtomically(src2, dest);
      assert.equal(await fs.readFile(dest, "utf8"), '{"v":2}\n');
    });
  });
});
