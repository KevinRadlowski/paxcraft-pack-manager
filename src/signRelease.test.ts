import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { stageRelease } from "./stage.js";
import { UNIT_TEST_STAGE_BYPASS } from "./releasePreflightTypes.js";
import { signStagedRelease, SignReleaseError } from "./signRelease.js";
import { verifyRelease } from "./verifyRelease.js";
import { createEphemeralEd25519Signer, UnsignedDevSigner } from "./releaseSigning.js";
import { CATALOG_SCHEMA_VERSION } from "./types.js";
import type { Catalog, ConfigRecord, ModRecord } from "./types.js";

function sha(s: string | Buffer) {
  return createHash("sha256").update(s).digest("hex");
}

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sc-signrel-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("signStagedRelease", () => {
  it("signs unsigned staging in place; payload files unchanged; publishable", async () => {
    await withTemp(async dir => {
      const source = path.join(dir, "pack");
      const body = Buffer.from('{"a":1}\n');
      const bodySha = sha(body);
      await fs.mkdir(path.join(source, "config"), { recursive: true });
      await fs.writeFile(path.join(source, "config", "demo.json"), body);

      const mod: ModRecord = {
        mod_id: "demo",
        jar: "demo.jar",
        name: "demo",
        version: "1",
        size_bytes: 1,
        sha256: "a".repeat(64),
        sha512: "b".repeat(128),
        install_client: true,
        install_server: true,
        side_class: "BOTH_REQUIRED",
        distribution_policy: "UPSTREAM_PREFERRED",
        modrinth_file_url: "https://example.test/demo.jar"
      };
      const cfg: ConfigRecord = {
        path: "config/demo.json",
        policy: "SERVER_FORCE",
        target: "BOTH",
        sha256: bodySha,
        size_bytes: body.length,
        owner_mod_id: null
      };
      const catalog: Catalog = {
        schemaVersion: CATALOG_SCHEMA_VERSION,
        generatedFor: {
          product: "SweetCraft",
          minecraft: "26.1.2",
          fabricLoader: "0.19.3",
          server: "test"
        },
        mods: [mod],
        configs: [cfg]
      };

      const staged = await stageRelease({
      assemblyGate: { mode: "unit-test-bypass" as const, token: UNIT_TEST_STAGE_BYPASS },
        catalog,
        packVersion: "0.1.3",
        sourceRoot: source,
        outDir: path.join(dir, "releases"),
        createdAt: "2026-01-01T00:00:00.000Z",
        releaseSequence: 4,
        signer: new UnsignedDevSigner()
      });

      const checksumBefore = await fs.readFile(path.join(staged.releaseDir, "checksums.json"));
      const clientBefore = await fs.readFile(path.join(staged.releaseDir, "client-manifest.json"));

      const signer = createEphemeralEd25519Signer("sweetcraft-release-2026-01");
      const r = await signStagedRelease({
        releaseDir: staged.releaseDir,
        signer,
        trustedKeys: { [signer.publicKeyId]: signer.publicKeyPem },
        expectPackVersion: "0.1.3",
        expectReleaseSequence: 4
      });

      assert.equal(r.signatureStatus, "signed");
      assert.equal(r.publishableStable, true);
      assert.equal(r.verify.signature, "SIGNED_OK");

      const checksumAfter = await fs.readFile(path.join(staged.releaseDir, "checksums.json"));
      const clientAfter = await fs.readFile(path.join(staged.releaseDir, "client-manifest.json"));
      assert.ok(checksumBefore.equals(checksumAfter));
      assert.ok(clientBefore.equals(clientAfter));

      const release = JSON.parse(
        await fs.readFile(path.join(staged.releaseDir, "release.json"), "utf8")
      );
      assert.equal(release.signature.status, "signed");
      assert.equal(release.signature.publicKeyId, "sweetcraft-release-2026-01");
      assert.equal(release.antiRollback.releaseSequence, 4);

      await assert.rejects(
        () =>
          signStagedRelease({
            releaseDir: staged.releaseDir,
            signer,
            trustedKeys: { [signer.publicKeyId]: signer.publicKeyPem }
          }),
        SignReleaseError
      );

      const v = await verifyRelease({
        releaseDir: staged.releaseDir,
        trustedKeys: { [signer.publicKeyId]: signer.publicKeyPem },
        allowUnsignedDev: false
      });
      assert.equal(v.ok, true);
      assert.equal(v.publishableStable, true);
    });
  });
});
