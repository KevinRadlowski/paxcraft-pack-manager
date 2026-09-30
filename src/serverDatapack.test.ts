import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  computeDatapackTreeSha256,
  prepareServerDatapacksFromConfig,
  ServerDatapackError,
  toManifestServerDatapack
} from "./serverDatapack.js";
import {
  assertSafeServerDatapackId,
  assertSafeServerDatapackServerPath,
  assertSafeServerDatapackTargetPath,
  stagedServerDatapackFileRelativePath
} from "./serverDatapackPaths.js";
import { PathSafetyError } from "./paths.js";
import { assertSafeFilesPayloadPath } from "./resourcePackPaths.js";
import { stageRelease } from "./stage.js";
import { UNIT_TEST_STAGE_BYPASS } from "./releasePreflightTypes.js";
import { verifyRelease } from "./verifyRelease.js";
import { UnsignedDevSigner } from "./releaseSigning.js";
import { CATALOG_SCHEMA_VERSION, MANIFEST_SCHEMA_VERSION } from "./types.js";
import type { Catalog, ConfigRecord, ModRecord } from "./types.js";

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sc-sdp-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

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

function readyCatalog(configs: ConfigRecord[]): Catalog {
  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    generatedFor: { product: "SweetCraft", minecraft: "26.1.2", fabricLoader: "0.19.3", server: "test" },
    mods: [mod({ mod_id: "demo", side_class: "SERVER_ONLY" })],
    configs
  };
}

async function writeMinimalDatapack(root: string, targetPath: string, extra?: Record<string, string>): Promise<void> {
  const mcmeta = path.join(root, "pack.mcmeta");
  await fs.mkdir(path.dirname(mcmeta), { recursive: true });
  await fs.writeFile(mcmeta, JSON.stringify({ pack: { description: "test", pack_format: 48 } }));
  if (extra) {
    for (const [rel, content] of Object.entries(extra)) {
      const abs = path.join(root, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content);
    }
  }
}

describe("serverDatapack path safety", () => {
  it("rejects traversal and absolute paths", () => {
    assert.throws(() => assertSafeServerDatapackTargetPath("../world/datapacks/evil"), PathSafetyError);
    assert.throws(() => assertSafeServerDatapackTargetPath("/world/datapacks/x"), PathSafetyError);
    assert.throws(() => assertSafeServerDatapackTargetPath("config/foo"), PathSafetyError);
    assert.throws(() => assertSafeServerDatapackServerPath("world/datapacks/../region/x"), PathSafetyError);
  });

  it("accepts valid world/datapacks paths", () => {
    const t = "world/datapacks/SweetCraft_Quest_Support";
    assert.doesNotThrow(() => assertSafeServerDatapackTargetPath(t));
    assert.doesNotThrow(() => assertSafeServerDatapackServerPath(`${t}/pack.mcmeta`));
    assert.equal(stagedServerDatapackFileRelativePath(`${t}/pack.mcmeta`), `files/${t}/pack.mcmeta`);
    assert.doesNotThrow(() => assertSafeFilesPayloadPath(`${t}/pack.mcmeta`));
  });

  it("rejects invalid ids", () => {
    assert.throws(() => assertSafeServerDatapackId("Bad ID"), PathSafetyError);
    assert.doesNotThrow(() => assertSafeServerDatapackId("sweetcraft-quest-support"));
  });
});

describe("serverDatapack inventory", () => {
  it("rejects symlink entries", async () => {
    await withTemp(async tmp => {
      const dpRoot = path.join(tmp, "dp");
      await writeMinimalDatapack(dpRoot, "world/datapacks/test");
      const secret = path.join(tmp, "secret.txt");
      await fs.writeFile(secret, "leak");
      await fs.symlink(secret, path.join(dpRoot, "link.txt"));
      const cfgFile = path.join(tmp, "cfg.json");
      await fs.writeFile(
        cfgFile,
        JSON.stringify({
          serverDatapacks: [
            {
              id: "test-dp",
              displayName: "Test",
              version: "1",
              sourcePath: dpRoot,
              targetPath: "world/datapacks/test"
            }
          ]
        })
      );
      await assert.rejects(() => prepareServerDatapacksFromConfig(cfgFile), ServerDatapackError);
    });
  });

  it("rejects duplicate ids", async () => {
    await withTemp(async tmp => {
      const dpRoot = path.join(tmp, "dp");
      await writeMinimalDatapack(dpRoot, "world/datapacks/a");
      const cfgFile = path.join(tmp, "cfg.json");
      await fs.writeFile(
        cfgFile,
        JSON.stringify({
          serverDatapacks: [
            {
              id: "dup",
              displayName: "A",
              version: "1",
              sourcePath: dpRoot,
              targetPath: "world/datapacks/a"
            },
            {
              id: "dup",
              displayName: "B",
              version: "1",
              sourcePath: dpRoot,
              targetPath: "world/datapacks/a"
            }
          ]
        })
      );
      await assert.rejects(() => prepareServerDatapacksFromConfig(cfgFile), /duplicate/);
    });
  });

  it("computes deterministic treeSha256", async () => {
    await withTemp(async tmp => {
      const dpRoot = path.join(tmp, "dp");
      await writeMinimalDatapack(dpRoot, "world/datapacks/test", {
        "data/demo/tags/item/foo.json": "{}"
      });
      const cfgFile = path.join(tmp, "cfg.json");
      await fs.writeFile(
        cfgFile,
        JSON.stringify({
          serverDatapacks: [
            {
              id: "test-dp",
              displayName: "Test",
              version: "1",
              sourcePath: dpRoot,
              targetPath: "world/datapacks/test"
            }
          ]
        })
      );
      const [a, b] = await Promise.all([
        prepareServerDatapacksFromConfig(cfgFile),
        prepareServerDatapacksFromConfig(cfgFile)
      ]);
      assert.equal(a[0]!.treeSha256, b[0]!.treeSha256);
      assert.equal(a[0]!.treeSha256, computeDatapackTreeSha256(a[0]!.files));
      const manifest = toManifestServerDatapack(a[0]!);
      assert.ok(!("sourcePath" in manifest));
      assert.ok(!("sourceAbsolutePath" in manifest));
    });
  });
});

describe("serverDatapack staging", () => {
  it("stages folder tree under files/world/datapacks and verifyRelease passes", async () => {
    await withTemp(async tmp => {
      const dpRoot = path.join(tmp, "dp");
      await writeMinimalDatapack(dpRoot, "world/datapacks/quest", {
        "data/sweetcraft/tags/item/beds.json": "[]"
      });
      const sourceRoot = path.join(tmp, "src");
      await fs.mkdir(path.join(sourceRoot, "config"), { recursive: true });
      const cfgPath = "config/demo.toml";
      const cfgData = Buffer.from("x=1\n");
      await fs.writeFile(path.join(sourceRoot, cfgPath), cfgData);
      const sha = createHash("sha256").update(cfgData).digest("hex");
      const catalog = readyCatalog([
        cfg({ path: cfgPath, policy: "MANAGED", target: "SERVER", sha256: sha, size_bytes: cfgData.length })
      ]);
      const staged = await stageRelease({
      assemblyGate: { mode: "unit-test-bypass" as const, token: UNIT_TEST_STAGE_BYPASS },
        catalog,
        packVersion: "9.9.9-test",
        sourceRoot,
        outDir: path.join(tmp, "releases"),
        force: true,
        serverDatapacks: await prepareServerDatapacksFromConfig(
          await (async () => {
            const f = path.join(tmp, "sdp.json");
            await fs.writeFile(
              f,
              JSON.stringify({
                serverDatapacks: [
                  {
                    id: "quest",
                    displayName: "Quest",
                    version: "1",
                    sourcePath: dpRoot,
                    targetPath: "world/datapacks/quest"
                  }
                ]
              })
            );
            return f;
          })()
        ),
        createdAt: "2026-01-01T00:00:00.000Z",
        signer: new UnsignedDevSigner()
      });
      assert.equal(staged.serverDatapacksStaged, 1);
      const server = JSON.parse(
        await fs.readFile(path.join(staged.releaseDir, "server-manifest.json"), "utf8")
      ) as { schemaVersion: number; serverDatapacks?: { id: string; files: { path: string }[] }[] };
      assert.equal(server.schemaVersion, MANIFEST_SCHEMA_VERSION);
      assert.equal(server.serverDatapacks?.length, 1);
      for (const f of server.serverDatapacks![0]!.files) {
        const stagedPath = path.join(staged.releaseDir, "files", ...f.path.split("/"));
        await fs.access(stagedPath);
      }
      const client = JSON.parse(await fs.readFile(path.join(staged.releaseDir, "client-manifest.json"), "utf8"));
      assert.equal(client.serverDatapacks, undefined);
      await verifyRelease({ releaseDir: staged.releaseDir, allowUnsignedDev: true });
    });
  });
});
