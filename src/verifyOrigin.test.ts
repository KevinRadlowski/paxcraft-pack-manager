import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { stageRelease } from "./stage.js";
import { UNIT_TEST_STAGE_BYPASS } from "./releasePreflightTypes.js";
import { publishRelease } from "./publish.js";
import { createEphemeralEd25519Signer, UnsignedDevSigner } from "./releaseSigning.js";
import { OriginVerifyError, verifyOrigin, originVerifyToJson } from "./verifyOrigin.js";
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sc-origin-"));
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

async function stageMini(dir: string, version: string) {
  const source = path.join(dir, "pack");
  const outDir = path.join(dir, "releases-stage");
  const body = `cfg-${version}`;
  const sha = await writeConfig(source, "config/demo.json", body);
  const catalog = readyCatalog([
    cfg({ path: "config/demo.json", policy: "SERVER_FORCE", target: "BOTH", sha256: sha, size_bytes: body.length })
  ]);
  return stageRelease({
      assemblyGate: { mode: "unit-test-bypass" as const, token: UNIT_TEST_STAGE_BYPASS },
    catalog,
    packVersion: version,
    sourceRoot: source,
    outDir,
    createdAt: "2026-01-01T00:00:00.000Z",
    signer: new UnsignedDevSigner()
  });
}

async function signedTransaction(
  dir: string,
  opts: { version?: string; channel?: "dev" | "beta" | "stable"; sequence?: number } = {}
) {
  const version = opts.version ?? "0.1.0";
  const channel = opts.channel ?? "dev";
  const sequence = opts.sequence ?? 1;
  const signer = createEphemeralEd25519Signer("origin-test-key");
  const keys = { "origin-test-key": signer.publicKeyPem };
  const staged = await stageMini(dir, version);
  const outDir = path.join(dir, "publish");
  await publishRelease({
    releaseDir: staged.releaseDir,
    channel,
    sequence,
    outDir,
    signer,
    trustedKeys: keys
  });
  // Transaction layout mirrors publish root
  const tx = path.join(dir, "incoming", "tx1");
  await fs.cp(outDir, tx, { recursive: true });
  return { tx, keys, signer, outDir, version, channel, sequence };
}

describe("verifyOrigin", () => {
  it("transaction valide signée => PASS", async () => {
    await withTemp(async dir => {
      const { tx, keys, version, sequence } = await signedTransaction(dir);
      const r = await verifyOrigin({ transactionDir: tx, channel: "dev", trustedKeys: keys });
      assert.equal(r.ok, true);
      assert.equal(r.packVersion, version);
      assert.equal(r.releaseSequence, sequence);
      assert.equal(r.releaseSignature, "SIGNED_OK");
      assert.equal(r.channelSignature, "SIGNED_OK");
      assert.ok(r.filesChecked >= 3);
      const j = originVerifyToJson(r);
      assert.equal(j.ok, true);
      assert.ok(!JSON.stringify(j).includes("PRIVATE"));
    });
  });

  it("release signature invalide => FAIL", async () => {
    await withTemp(async dir => {
      const { tx, keys } = await signedTransaction(dir);
      const p = path.join(tx, "releases", "0.1.0", "release.json");
      const rel = JSON.parse(await fs.readFile(p, "utf8"));
      rel.minecraft = "9.9.9";
      await fs.writeFile(p, JSON.stringify(rel, null, 2) + "\n");
      await assert.rejects(
        () => verifyOrigin({ transactionDir: tx, channel: "dev", trustedKeys: keys }),
        OriginVerifyError
      );
    });
  });

  it("channel signature invalide => FAIL", async () => {
    await withTemp(async dir => {
      const { tx, keys } = await signedTransaction(dir);
      const p = path.join(tx, "channels", "dev.json");
      const ch = JSON.parse(await fs.readFile(p, "utf8"));
      ch.releaseSequence = 99;
      await fs.writeFile(p, JSON.stringify(ch, null, 2) + "\n");
      await assert.rejects(
        () => verifyOrigin({ transactionDir: tx, channel: "dev", trustedKeys: keys }),
        OriginVerifyError
      );
    });
  });

  it("trusted key inconnue => FAIL", async () => {
    await withTemp(async dir => {
      const { tx, signer } = await signedTransaction(dir);
      await assert.rejects(
        () =>
          verifyOrigin({
            transactionDir: tx,
            channel: "dev",
            trustedKeys: { "other-id": signer.publicKeyPem }
          }),
        /inconnue|ORIGIN|clé/i
      );
    });
  });

  it("releaseSha256 invalide => FAIL", async () => {
    await withTemp(async dir => {
      const { tx, keys } = await signedTransaction(dir);
      const p = path.join(tx, "channels", "dev.json");
      const ch = JSON.parse(await fs.readFile(p, "utf8"));
      // Keep signature fields but break hash — signature will also fail; still covers path
      ch.releaseSha256 = "0".repeat(64);
      await fs.writeFile(p, JSON.stringify(ch, null, 2) + "\n");
      await assert.rejects(
        () => verifyOrigin({ transactionDir: tx, channel: "dev", trustedKeys: keys }),
        OriginVerifyError
      );
    });
  });

  it("checksums invalides => FAIL", async () => {
    await withTemp(async dir => {
      const { tx, keys } = await signedTransaction(dir);
      await fs.writeFile(path.join(tx, "releases", "0.1.0", "checksums.json"), "{}\n");
      await assert.rejects(
        () => verifyOrigin({ transactionDir: tx, channel: "dev", trustedKeys: keys }),
        OriginVerifyError
      );
    });
  });

  it("manifest invalide => FAIL", async () => {
    await withTemp(async dir => {
      const { tx, keys } = await signedTransaction(dir);
      const p = path.join(tx, "releases", "0.1.0", "client-manifest.json");
      const m = JSON.parse(await fs.readFile(p, "utf8"));
      m.packVersion = "9.9.9";
      await fs.writeFile(p, JSON.stringify(m, null, 2) + "\n");
      await assert.rejects(
        () => verifyOrigin({ transactionDir: tx, channel: "dev", trustedKeys: keys }),
        OriginVerifyError
      );
    });
  });

  it("mauvais releasePath => FAIL", async () => {
    await withTemp(async dir => {
      const { tx, keys } = await signedTransaction(dir);
      const p = path.join(tx, "channels", "dev.json");
      const ch = JSON.parse(await fs.readFile(p, "utf8"));
      ch.releasePath = "releases/evil/release.json";
      await fs.writeFile(p, JSON.stringify(ch, null, 2) + "\n");
      await assert.rejects(
        () => verifyOrigin({ transactionDir: tx, channel: "dev", trustedKeys: keys }),
        /releasePath/i
      );
    });
  });

  it("mauvais packVersion => FAIL", async () => {
    await withTemp(async dir => {
      const { tx, keys } = await signedTransaction(dir);
      const p = path.join(tx, "channels", "dev.json");
      const ch = JSON.parse(await fs.readFile(p, "utf8"));
      ch.packVersion = "9.9.9";
      ch.releasePath = "releases/9.9.9/release.json";
      await fs.writeFile(p, JSON.stringify(ch, null, 2) + "\n");
      await assert.rejects(
        () => verifyOrigin({ transactionDir: tx, channel: "dev", trustedKeys: keys }),
        /packVersion/i
      );
    });
  });

  it("mauvais releaseSequence => FAIL", async () => {
    await withTemp(async dir => {
      const { tx, keys } = await signedTransaction(dir);
      const p = path.join(tx, "channels", "dev.json");
      const ch = JSON.parse(await fs.readFile(p, "utf8"));
      ch.releaseSequence = 2;
      await fs.writeFile(p, JSON.stringify(ch, null, 2) + "\n");
      await assert.rejects(
        () => verifyOrigin({ transactionDir: tx, channel: "dev", trustedKeys: keys }),
        OriginVerifyError
      );
    });
  });

  it("unsigned dev refusé", async () => {
    await withTemp(async dir => {
      const staged = await stageMini(dir, "0.1.0");
      const outDir = path.join(dir, "publish");
      await publishRelease({
        releaseDir: staged.releaseDir,
        channel: "dev",
        sequence: 1,
        outDir,
        allowUnsignedDev: true
      });
      const tx = path.join(dir, "tx");
      await fs.cp(outDir, tx, { recursive: true });
      await assert.rejects(
        () => verifyOrigin({ transactionDir: tx, channel: "dev", trustedKeys: { k: "-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE\n-----END PUBLIC KEY-----\n" } }),
        /unsigned|signature|trusted|invalide|PEM/i
      );
    });
  });

  it("unsigned beta/stable impossible via publish; unsigned file refused", async () => {
    await withTemp(async dir => {
      const staged = await stageMini(dir, "0.1.0");
      const outDir = path.join(dir, "publish");
      await publishRelease({
        releaseDir: staged.releaseDir,
        channel: "dev",
        sequence: 1,
        outDir,
        allowUnsignedDev: true
      });
      // rename channel to beta for origin check
      const tx = path.join(dir, "tx");
      await fs.cp(outDir, tx, { recursive: true });
      await fs.rename(path.join(tx, "channels", "dev.json"), path.join(tx, "channels", "beta.json"));
      const ch = JSON.parse(await fs.readFile(path.join(tx, "channels", "beta.json"), "utf8"));
      ch.channel = "beta";
      await fs.writeFile(path.join(tx, "channels", "beta.json"), JSON.stringify(ch, null, 2) + "\n");
      await assert.rejects(
        () =>
          verifyOrigin({
            transactionDir: tx,
            channel: "beta",
            trustedKeys: { x: "-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----\n" }
          }),
        /unsigned|signature|invalide|PEM|interdit|refusé/i
      );
    });
  });

  it("symlink refusé", async () => {
    await withTemp(async dir => {
      const { tx, keys } = await signedTransaction(dir);
      try {
        await fs.symlink(
          path.join(tx, "releases", "0.1.0", "release.json"),
          path.join(tx, "releases", "0.1.0", "link.json")
        );
      } catch {
        // Windows may require privilege — skip soft if symlink unsupported
        return;
      }
      await assert.rejects(
        () => verifyOrigin({ transactionDir: tx, channel: "dev", trustedKeys: keys }),
        /symlink/i
      );
    });
  });

  it("fichier .pem refusé", async () => {
    await withTemp(async dir => {
      const { tx, keys } = await signedTransaction(dir);
      await fs.writeFile(path.join(tx, "releases", "0.1.0", "secret.pem"), "nope");
      await assert.rejects(
        () => verifyOrigin({ transactionDir: tx, channel: "dev", trustedKeys: keys }),
        /interdit|\.pem/i
      );
    });
  });

  it("fichier caché refusé", async () => {
    await withTemp(async dir => {
      const { tx, keys } = await signedTransaction(dir);
      await fs.writeFile(path.join(tx, "releases", "0.1.0", ".hidden"), "x");
      await assert.rejects(
        () => verifyOrigin({ transactionDir: tx, channel: "dev", trustedKeys: keys }),
        /interdit|caché|\.hidden/i
      );
    });
  });

  it("plusieurs releases refusées", async () => {
    await withTemp(async dir => {
      const { tx, keys } = await signedTransaction(dir, { version: "0.1.0" });
      await fs.cp(path.join(tx, "releases", "0.1.0"), path.join(tx, "releases", "0.2.0"), {
        recursive: true
      });
      await assert.rejects(
        () => verifyOrigin({ transactionDir: tx, channel: "dev", trustedKeys: keys }),
        /plusieurs releases/i
      );
    });
  });

  it("channel absent", async () => {
    await withTemp(async dir => {
      const { tx, keys } = await signedTransaction(dir);
      await fs.rm(path.join(tx, "channels", "dev.json"));
      await assert.rejects(
        () => verifyOrigin({ transactionDir: tx, channel: "dev", trustedKeys: keys }),
        /channel absent/i
      );
    });
  });

  it("release absente", async () => {
    await withTemp(async dir => {
      const { tx, keys } = await signedTransaction(dir);
      await fs.rm(path.join(tx, "releases"), { recursive: true });
      await assert.rejects(
        () => verifyOrigin({ transactionDir: tx, channel: "dev", trustedKeys: keys }),
        /release absente/i
      );
    });
  });
});
