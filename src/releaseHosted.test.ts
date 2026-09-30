import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  applyReleaseHostedUrlsToCatalog,
  countArtifactKinds,
  materializeReleaseHostedMod,
  planReleaseHostedMods,
  publicReleaseHostedModUrl,
  RELEASE_HOSTED_PROVIDER_TYPE,
  stagedReleaseHostedModPath
} from "./releaseHosted.js";
import { PathSafetyError } from "./paths.js";
import { LocalCleanError } from "./localClean.js";
import { assertSafeFilesPayloadPath } from "./resourcePackPaths.js";
import { stageRelease, StageError } from "./stage.js";
import { UNIT_TEST_STAGE_BYPASS } from "./releasePreflightTypes.js";
import { verifyRelease } from "./verifyRelease.js";
import { UnsignedDevSigner } from "./releaseSigning.js";
import { buildClientManifest, buildServerManifest } from "./manifest.js";
import {
  CATALOG_SCHEMA_VERSION,
  MANIFEST_SCHEMA_VERSION,
  RELEASE_SCHEMA_VERSION
} from "./types.js";
import type { Catalog, ConfigRecord, ModRecord } from "./types.js";

function sha256(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sc-rh-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function baseMod(partial: Partial<ModRecord> & Pick<ModRecord, "mod_id" | "jar" | "sha256" | "size_bytes">): ModRecord {
  return {
    name: partial.mod_id,
    version: "1",
    sha512: "b".repeat(128),
    install_client: true,
    install_server: true,
    side_class: "BOTH_REQUIRED",
    distribution_policy: "UPSTREAM_PREFERRED",
    ...partial
  };
}

function providerMod(id: string): ModRecord {
  return baseMod({
    mod_id: id,
    jar: `${id}.jar`,
    sha256: "c".repeat(64),
    size_bytes: 10,
    modrinth_file_url: `https://cdn.modrinth.com/data/${id}/file.jar`,
    distribution_policy: "UPSTREAM_PREFERRED"
  });
}

function catalogOf(mods: ModRecord[], configs: ConfigRecord[] = []): Catalog {
  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    generatedFor: {
      product: "SweetCraft",
      minecraft: "26.1.2",
      fabricLoader: "0.19.3",
      server: "test"
    },
    mods,
    configs
  };
}

describe("release-hosted planning", () => {
  it("1. LOCAL_CLEAN → RELEASE_HOSTED plan entry", () => {
    const body = Buffer.from("local-clean-jar");
    const m = baseMod({
      mod_id: "dynamic_difficulty",
      jar: "dynamic_difficulty.jar",
      sha256: sha256(body),
      size_bytes: body.length,
      distribution_policy: "UPSTREAM_PREFERRED"
    });
    const plan = planReleaseHostedMods(catalogOf([m]), {
      packVersion: "0.1.3",
      productOrigin: "https://cdn.xnosweet.fr/sweetcraft"
    });
    assert.equal(plan.length, 1);
    assert.equal(plan[0]!.sourceKind, "LOCAL_CLEAN");
    assert.equal(plan[0]!.releaseStoragePath, "files/mods/dynamic_difficulty.jar");
  });

  it("2. CUSTOM_LOCAL → RELEASE_HOSTED plan entry", () => {
    const body = Buffer.from("custom-local-jar");
    const m = baseMod({
      mod_id: "fallen",
      jar: "fallen.jar",
      sha256: sha256(body),
      size_bytes: body.length,
      distribution_policy: "SWEETCRAFT_ALLOWED"
    });
    const plan = planReleaseHostedMods(catalogOf([m]), {
      packVersion: "0.1.3",
      productOrigin: "https://cdn.xnosweet.fr/sweetcraft"
    });
    assert.equal(plan.length, 1);
    assert.equal(plan[0]!.sourceKind, "CUSTOM_LOCAL");
  });

  it("8. final HTTPS URL deterministic", () => {
    const url = publicReleaseHostedModUrl(
      "https://cdn.xnosweet.fr/sweetcraft",
      "0.1.3",
      "fallen-1.3.0+mc26.1.2.jar"
    );
    assert.equal(
      url,
      "https://cdn.xnosweet.fr/sweetcraft/releases/0.1.3/files/mods/fallen-1.3.0+mc26.1.2.jar"
    );
  });

  it("9. product origin trailing slash normalized", () => {
    const a = publicReleaseHostedModUrl(
      "https://cdn.xnosweet.fr/sweetcraft/",
      "0.1.3",
      "x.jar"
    );
    const b = publicReleaseHostedModUrl(
      "https://cdn.xnosweet.fr/sweetcraft",
      "0.1.3",
      "x.jar"
    );
    assert.equal(a, b);
    assert.equal(a, "https://cdn.xnosweet.fr/sweetcraft/releases/0.1.3/files/mods/x.jar");
  });

  it("6. unsafe target path fail", () => {
    assert.throws(() => stagedReleaseHostedModPath("../evil.jar"), PathSafetyError);
    assert.throws(() => stagedReleaseHostedModPath("a/b.jar"), PathSafetyError);
    assert.throws(() => assertSafeFilesPayloadPath("mods/../x.jar"), PathSafetyError);
    assert.throws(() => assertSafeFilesPayloadPath("mods/nested/x.jar"), PathSafetyError);
  });

  it("7. duplicate mod path fail", () => {
    const body = Buffer.from("dup");
    const sha = sha256(body);
    const a = baseMod({
      mod_id: "a",
      jar: "same.jar",
      sha256: sha,
      size_bytes: body.length,
      distribution_policy: "SWEETCRAFT_ALLOWED"
    });
    const b = baseMod({
      mod_id: "b",
      jar: "same.jar",
      sha256: sha,
      size_bytes: body.length,
      distribution_policy: "SWEETCRAFT_ALLOWED"
    });
    assert.throws(
      () =>
        planReleaseHostedMods(catalogOf([a, b]), {
          packVersion: "0.1.3",
          productOrigin: "https://cdn.xnosweet.fr/sweetcraft"
        }),
      PathSafetyError
    );
  });

  it("10. provider mods remain external (not planned)", () => {
    const local = baseMod({
      mod_id: "fallen",
      jar: "fallen.jar",
      sha256: "d".repeat(64),
      size_bytes: 1,
      distribution_policy: "SWEETCRAFT_ALLOWED"
    });
    const catalog = catalogOf([providerMod("fabric-api"), providerMod("sodium"), local]);
    const kinds = countArtifactKinds(catalog);
    assert.equal(kinds.provider, 2);
    assert.equal(kinds.customLocal, 1);
    const plan = planReleaseHostedMods(catalog, {
      packVersion: "0.1.3",
      productOrigin: "https://cdn.xnosweet.fr/sweetcraft"
    });
    assert.equal(plan.length, 1);
    assert.equal(plan[0]!.mod_id, "fallen");
  });

  it("16. no schema change constants", () => {
    assert.equal(MANIFEST_SCHEMA_VERSION, 6);
    assert.equal(RELEASE_SCHEMA_VERSION, 2);
  });
});

describe("release-hosted materialize + stage", () => {
  it("3. exact byte copy + 11 checksums + 12 fileset + 14 verify", async () => {
    await withTemp(async dir => {
      const clean = path.join(dir, "CLEAN");
      const jarName = "fallen.jar";
      const body = Buffer.from("exact-fallen-bytes-v1");
      const sha = sha256(body);
      await fs.mkdir(path.join(clean, "client", "mods"), { recursive: true });
      await fs.mkdir(path.join(clean, "server", "mods"), { recursive: true });
      await fs.writeFile(path.join(clean, "client", "mods", jarName), body);
      await fs.writeFile(path.join(clean, "server", "mods", jarName), body);

      const cfgBody = Buffer.from('{"ok":true}\n');
      const cfgSha = sha256(cfgBody);
      const source = path.join(dir, "pack");
      await fs.mkdir(path.join(source, "config"), { recursive: true });
      await fs.writeFile(path.join(source, "config", "demo.json"), cfgBody);

      const local = baseMod({
        mod_id: "fallen",
        jar: jarName,
        sha256: sha,
        size_bytes: body.length,
        distribution_policy: "SWEETCRAFT_ALLOWED"
      });
      const catalog = catalogOf(
        [providerMod("sodium"), local],
        [
          {
            path: "config/demo.json",
            policy: "SERVER_FORCE",
            target: "BOTH",
            sha256: cfgSha,
            size_bytes: cfgBody.length,
            owner_mod_id: null
          }
        ]
      );

      const outDir = path.join(dir, "releases");
      const result = await stageRelease({
      assemblyGate: { mode: "unit-test-bypass" as const, token: UNIT_TEST_STAGE_BYPASS },
        catalog,
        packVersion: "0.1.3",
        sourceRoot: source,
        outDir,
        cleanRoot: clean,
        productOrigin: "https://cdn.xnosweet.fr/sweetcraft/",
        createdAt: "2026-01-01T00:00:00.000Z",
        signer: new UnsignedDevSigner()
      });
      assert.equal(result.releaseHostedModsStaged, 1);

      const stagedJar = path.join(result.releaseDir, "files", "mods", jarName);
      const staged = await fs.readFile(stagedJar);
      assert.deepEqual(staged, body);
      assert.equal(sha256(staged), sha);

      const checksums = JSON.parse(
        await fs.readFile(path.join(result.releaseDir, "checksums.json"), "utf8")
      ) as { entries: { path: string; sha256: string; size: number }[] };
      const entry = checksums.entries.find(e => e.path === `files/mods/${jarName}`);
      assert.ok(entry);
      assert.equal(entry!.sha256, sha);
      assert.equal(entry!.size, body.length);

      assert.doesNotThrow(() => assertSafeFilesPayloadPath(`mods/${jarName}`));

      const client = JSON.parse(
        await fs.readFile(path.join(result.releaseDir, "client-manifest.json"), "utf8")
      ) as {
        schemaVersion: number;
        mods: { id: string; provider: { type: string; url: string }; sha256: string; size: number }[];
      };
      assert.equal(client.schemaVersion, 6);
      const fallen = client.mods.find(m => m.id === "fallen");
      assert.ok(fallen);
      assert.equal(fallen!.provider.type, RELEASE_HOSTED_PROVIDER_TYPE);
      assert.equal(
        fallen!.provider.url,
        "https://cdn.xnosweet.fr/sweetcraft/releases/0.1.3/files/mods/fallen.jar"
      );
      assert.equal(fallen!.sha256, sha);
      assert.equal(fallen!.size, body.length);
      const sodium = client.mods.find(m => m.id === "sodium");
      assert.ok(sodium);
      assert.equal(sodium!.provider.type, "modrinth");
      assert.match(sodium!.provider.url, /^https:\/\/cdn\.modrinth\.com\//);

      const release = JSON.parse(
        await fs.readFile(path.join(result.releaseDir, "release.json"), "utf8")
      ) as { schemaVersion: number; stats: Record<string, unknown> };
      assert.equal(release.schemaVersion, 2);
      assert.equal(release.stats.releaseHostedMods, undefined);

      const v = await verifyRelease({
        releaseDir: result.releaseDir,
        allowUnsignedDev: true
      });
      assert.equal(v.ok, true);
      assert.equal(v.releaseIntegrity, "OK");
    });
  });

  it("4. hash mismatch fail", async () => {
    await withTemp(async dir => {
      const clean = path.join(dir, "CLEAN");
      const jarName = "badhash.jar";
      const body = Buffer.from("bytes");
      await fs.mkdir(path.join(clean, "client", "mods"), { recursive: true });
      await fs.writeFile(path.join(clean, "client", "mods", jarName), body);
      const m = baseMod({
        mod_id: "badhash",
        jar: jarName,
        sha256: "a".repeat(64),
        size_bytes: body.length,
        distribution_policy: "SWEETCRAFT_ALLOWED",
        install_server: false,
        side_class: "CLIENT_ONLY"
      });
      const plan = planReleaseHostedMods(catalogOf([m]), {
        packVersion: "0.1.3",
        productOrigin: "https://cdn.xnosweet.fr/sweetcraft"
      });
      await assert.rejects(
        () => materializeReleaseHostedMod(clean, plan[0]!, path.join(dir, "tmp")),
        (e: unknown) => e instanceof LocalCleanError || e instanceof StageError
      );
    });
  });

  it("5. size mismatch fail", async () => {
    await withTemp(async dir => {
      const clean = path.join(dir, "CLEAN");
      const jarName = "badsize.jar";
      const body = Buffer.from("bytes");
      await fs.mkdir(path.join(clean, "client", "mods"), { recursive: true });
      await fs.writeFile(path.join(clean, "client", "mods", jarName), body);
      const m = baseMod({
        mod_id: "badsize",
        jar: jarName,
        sha256: sha256(body),
        size_bytes: body.length + 99,
        distribution_policy: "SWEETCRAFT_ALLOWED",
        install_server: false,
        side_class: "CLIENT_ONLY"
      });
      const plan = planReleaseHostedMods(catalogOf([m]), {
        packVersion: "0.1.3",
        productOrigin: "https://cdn.xnosweet.fr/sweetcraft"
      });
      await assert.rejects(
        () => materializeReleaseHostedMod(clean, plan[0]!, path.join(dir, "tmp")),
        LocalCleanError
      );
    });
  });

  it("13. orphan local mod rejected by verifyRelease", async () => {
    await withTemp(async dir => {
      const clean = path.join(dir, "CLEAN");
      const jarName = "ok.jar";
      const body = Buffer.from("ok-jar");
      const sha = sha256(body);
      await fs.mkdir(path.join(clean, "client", "mods"), { recursive: true });
      await fs.writeFile(path.join(clean, "client", "mods", jarName), body);

      const cfgBody = Buffer.from("{}");
      const cfgSha = sha256(cfgBody);
      const source = path.join(dir, "pack");
      await fs.mkdir(path.join(source, "config"), { recursive: true });
      await fs.writeFile(path.join(source, "config", "demo.json"), cfgBody);

      const catalog = catalogOf(
        [
          baseMod({
            mod_id: "ok",
            jar: jarName,
            sha256: sha,
            size_bytes: body.length,
            distribution_policy: "SWEETCRAFT_ALLOWED",
            install_server: false,
            side_class: "CLIENT_ONLY"
          })
        ],
        [
          {
            path: "config/demo.json",
            policy: "SERVER_FORCE",
            target: "BOTH",
            sha256: cfgSha,
            size_bytes: cfgBody.length,
            owner_mod_id: null
          }
        ]
      );
      const result = await stageRelease({
      assemblyGate: { mode: "unit-test-bypass" as const, token: UNIT_TEST_STAGE_BYPASS },
        catalog,
        packVersion: "0.1.3",
        sourceRoot: source,
        outDir: path.join(dir, "releases"),
        cleanRoot: clean,
        signer: new UnsignedDevSigner()
      });
      await fs.writeFile(
        path.join(result.releaseDir, "files", "mods", "orphan.jar"),
        Buffer.from("orphan")
      );
      const v = await verifyRelease({ releaseDir: result.releaseDir, allowUnsignedDev: true });
      assert.equal(v.ok, false);
      assert.ok(v.errors.some(e => /inattendu|orphan/i.test(e) || e.includes("files/mods/orphan.jar")));
    });
  });

  it("15. tampered hosted mod fails verify", async () => {
    await withTemp(async dir => {
      const clean = path.join(dir, "CLEAN");
      const jarName = "tamper.jar";
      const body = Buffer.from("good");
      const sha = sha256(body);
      await fs.mkdir(path.join(clean, "client", "mods"), { recursive: true });
      await fs.writeFile(path.join(clean, "client", "mods", jarName), body);

      const cfgBody = Buffer.from("{}");
      const cfgSha = sha256(cfgBody);
      const source = path.join(dir, "pack");
      await fs.mkdir(path.join(source, "config"), { recursive: true });
      await fs.writeFile(path.join(source, "config", "demo.json"), cfgBody);

      const catalog = catalogOf(
        [
          baseMod({
            mod_id: "tamper",
            jar: jarName,
            sha256: sha,
            size_bytes: body.length,
            distribution_policy: "SWEETCRAFT_ALLOWED",
            install_server: false,
            side_class: "CLIENT_ONLY"
          })
        ],
        [
          {
            path: "config/demo.json",
            policy: "SERVER_FORCE",
            target: "BOTH",
            sha256: cfgSha,
            size_bytes: cfgBody.length,
            owner_mod_id: null
          }
        ]
      );
      const result = await stageRelease({
      assemblyGate: { mode: "unit-test-bypass" as const, token: UNIT_TEST_STAGE_BYPASS },
        catalog,
        packVersion: "0.1.3",
        sourceRoot: source,
        outDir: path.join(dir, "releases"),
        cleanRoot: clean,
        signer: new UnsignedDevSigner()
      });
      await fs.writeFile(path.join(result.releaseDir, "files", "mods", jarName), Buffer.from("EVIL"));
      const v = await verifyRelease({ releaseDir: result.releaseDir, allowUnsignedDev: true });
      assert.equal(v.ok, false);
      assert.ok(v.errors.some(e => /SHA-256 mismatch|taille mismatch/i.test(e)));
    });
  });

  it("17. 127 logical mods preserved in apply + manifests (mini fixture)", () => {
    const mods: ModRecord[] = [];
    for (let i = 0; i < 124; i++) mods.push(providerMod(`p${i}`));
    mods.push(
      baseMod({
        mod_id: "dynamic_difficulty",
        jar: "dd.jar",
        sha256: "e".repeat(64),
        size_bytes: 1,
        distribution_policy: "UPSTREAM_PREFERRED"
      }),
      baseMod({
        mod_id: "fallen",
        jar: "fallen.jar",
        sha256: "f".repeat(64),
        size_bytes: 1,
        distribution_policy: "SWEETCRAFT_ALLOWED"
      }),
      baseMod({
        mod_id: "xbasecasino",
        jar: "casino.jar",
        sha256: "1".repeat(64),
        size_bytes: 1,
        distribution_policy: "SWEETCRAFT_ALLOWED"
      })
    );
    const catalog = catalogOf(mods);
    assert.equal(catalog.mods.length, 127);
    const kinds = countArtifactKinds(catalog);
    assert.equal(kinds.provider, 124);
    assert.equal(kinds.localClean, 1);
    assert.equal(kinds.customLocal, 2);
    assert.equal(kinds.unresolved, 0);
    const plan = planReleaseHostedMods(catalog, {
      packVersion: "0.1.3",
      productOrigin: "https://cdn.xnosweet.fr/sweetcraft"
    });
    assert.equal(plan.length, 3);
    const patched = applyReleaseHostedUrlsToCatalog(catalog, plan);
    const client = buildClientManifest(patched, "0.1.3");
    const server = buildServerManifest(patched, "0.1.3");
    assert.equal(client.mods.length, 127);
    assert.equal(server.mods.length, 127);
    for (const id of ["dynamic_difficulty", "fallen", "xbasecasino"]) {
      const cm = client.mods.find((m: { id: string }) => m.id === id)!;
      assert.equal(cm.provider.type, "sweetcraft");
      assert.match(cm.provider.url, /^https:\/\/cdn\.xnosweet\.fr\/sweetcraft\/releases\/0\.1\.3\/files\/mods\//);
    }
    const providerKept = client.mods.filter((m: { provider: { type: string } }) => m.provider.type === "modrinth");
    assert.equal(providerKept.length, 124);
  });

  it("stage fails without cleanRoot when hosted mods needed", async () => {
    await withTemp(async dir => {
      const source = path.join(dir, "pack");
      await fs.mkdir(path.join(source, "config"), { recursive: true });
      const catalog = catalogOf([
        baseMod({
          mod_id: "fallen",
          jar: "fallen.jar",
          sha256: "a".repeat(64),
          size_bytes: 1,
          distribution_policy: "SWEETCRAFT_ALLOWED"
        })
      ]);
      await assert.rejects(
        () =>
          stageRelease({
      assemblyGate: { mode: "unit-test-bypass" as const, token: UNIT_TEST_STAGE_BYPASS },
            catalog,
            packVersion: "0.1.3",
            sourceRoot: source,
            outDir: path.join(dir, "releases"),
            signer: new UnsignedDevSigner()
          }),
        StageError
      );
    });
  });
});
