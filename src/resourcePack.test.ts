import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import AdmZip from "adm-zip";
import {
  prepareResourcePacks,
  ResourcePackError,
  validateResourcePackZip,
  hashFileBytes,
  toManifestResourcePack
} from "./resourcePack.js";
import {
  assertSafeResourcePackTargetPath,
  stagedResourcePackRelativePath
} from "./resourcePackPaths.js";
import { PathSafetyError } from "./paths.js";
import { validateManifestResourcePacks, ManifestResourcePackError } from "./resourcePackManifest.js";
import { stageRelease } from "./stage.js";
import { UNIT_TEST_STAGE_BYPASS } from "./releasePreflightTypes.js";
import { verifyRelease } from "./verifyRelease.js";
import { UnsignedDevSigner, createEphemeralEd25519Signer } from "./releaseSigning.js";
import { publishRelease } from "./publish.js";
import { verifyChannelDescriptor } from "./verifyChannel.js";
import { CATALOG_SCHEMA_VERSION, MANIFEST_SCHEMA_VERSION } from "./types.js";
import type { Catalog, ConfigRecord, ModRecord } from "./types.js";
import type { ResourcePackSourceConfig } from "./resourcePackTypes.js";

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sc-rp-"));
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
    mods: [mod({ mod_id: "demo", side_class: "BOTH_REQUIRED" })],
    configs
  };
}

function modernMcmeta(): string {
  return JSON.stringify({
    pack: {
      description: "test pack",
      min_format: [84, 0],
      max_format: [84, 0]
    }
  });
}

function legacyMcmeta(): string {
  return JSON.stringify({
    pack: { description: "legacy", pack_format: 15 }
  });
}

async function writeValidZip(
  absZip: string,
  opts?: { mcmeta?: string; assets?: boolean; emptyAssetsDir?: boolean; extra?: Record<string, string | Buffer>; nestMcmeta?: boolean }
): Promise<Buffer> {
  const zip = new AdmZip();
  const mcmeta = opts?.mcmeta ?? modernMcmeta();
  if (opts?.nestMcmeta) {
    zip.addFile("nested/pack.mcmeta", Buffer.from(mcmeta));
  } else {
    zip.addFile("pack.mcmeta", Buffer.from(mcmeta));
  }
  if (opts?.emptyAssetsDir) {
    zip.addFile("assets/", Buffer.alloc(0));
  } else if (opts?.assets !== false) {
    zip.addFile("assets/demo/lang/fr_fr.json", Buffer.from('{"a":"b"}'));
  }
  if (opts?.extra) {
    for (const [k, v] of Object.entries(opts.extra)) {
      zip.addFile(k, typeof v === "string" ? Buffer.from(v) : v);
    }
  }
  const buf = zip.toBuffer();
  await fs.mkdir(path.dirname(absZip), { recursive: true });
  await fs.writeFile(absZip, buf);
  return buf;
}

/** Minimal ZIP local-file header with a controlled entry name (adm-zip normalizes some paths). */
function craftZipWithEntryNames(names: string[], payloads: Buffer[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (let i = 0; i < names.length; i++) {
    const name = Buffer.from(names[i], "utf8");
    const data = payloads[i];
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(0, 14); // crc placeholder
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    const crc = requireCrc32(data);
    local.writeUInt32LE(crc, 14);

    const cen = Buffer.alloc(46 + name.length);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    name.copy(cen, 46);

    parts.push(local, data);
    central.push(cen);
    offset += local.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, centralBuf, end]);
}

function requireCrc32(data: Buffer): number {
  // IEEE CRC-32
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c ^= data[i];
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function sourceEntry(absZip: string, overrides: Partial<ResourcePackSourceConfig> = {}): ResourcePackSourceConfig {
  return {
    id: "sweetcraft-fr",
    displayName: "SweetCraft FR",
    version: "1.0",
    sourcePath: absZip,
    target: "CLIENT",
    targetPath: "resourcepacks/SweetCraft-FR-v1.0.zip",
    autoEnable: true,
    ...overrides
  };
}

describe("resourcePack targetPath safety", () => {
  it("accepts resourcepacks/ posix zip path", () => {
    assert.doesNotThrow(() => assertSafeResourcePackTargetPath("resourcepacks/SweetCraft-FR-v1.0.zip"));
    assert.equal(
      stagedResourcePackRelativePath("resourcepacks/SweetCraft-FR-v1.0.zip"),
      "files/resourcepacks/SweetCraft-FR-v1.0.zip"
    );
  });
  it("rejects traversal / backslash / absolute / hors resourcepacks", () => {
    assert.throws(() => assertSafeResourcePackTargetPath("resourcepacks/../x.zip"), PathSafetyError);
    assert.throws(() => assertSafeResourcePackTargetPath("resourcepacks\\x.zip"), PathSafetyError);
    assert.throws(() => assertSafeResourcePackTargetPath("C:/resourcepacks/x.zip"), PathSafetyError);
    assert.throws(() => assertSafeResourcePackTargetPath("config/x.zip"), PathSafetyError);
  });
});

describe("validateResourcePackZip", () => {
  it("1. resource pack ZIP valide accepté", async () => {
    await withTemp(async dir => {
      const z = path.join(dir, "ok.zip");
      await writeValidZip(z, { extra: { "README.txt": "ok", "sweetcraft-fr-audit.json": "{}" } });
      assert.doesNotThrow(() => validateResourcePackZip(z));
    });
  });

  it("3. source non ZIP rejetée via prepare", async () => {
    await withTemp(async dir => {
      const f = path.join(dir, "x.txt");
      await fs.writeFile(f, "nope");
      await assert.rejects(
        () => prepareResourcePacks([sourceEntry(f)], dir),
        (e: unknown) => e instanceof ResourcePackError && /non ZIP/i.test(e.message)
      );
    });
  });

  it("2. source absente rejetée", async () => {
    await withTemp(async dir => {
      await assert.rejects(
        () => prepareResourcePacks([sourceEntry(path.join(dir, "missing.zip"))], dir),
        (e: unknown) => e instanceof ResourcePackError && /absente/i.test(e.message)
      );
    });
  });

  it("4. ZIP invalide rejeté", async () => {
    await withTemp(async dir => {
      const z = path.join(dir, "bad.zip");
      await fs.writeFile(z, Buffer.from("not-a-zip"));
      assert.throws(() => validateResourcePackZip(z), ResourcePackError);
    });
  });

  it("5. pack.mcmeta absent rejeté", async () => {
    await withTemp(async dir => {
      const z = path.join(dir, "nometa.zip");
      const zip = new AdmZip();
      zip.addFile("assets/a/lang/fr_fr.json", Buffer.from("{}"));
      await fs.writeFile(z, zip.toBuffer());
      assert.throws(() => validateResourcePackZip(z), /pack.mcmeta absent/);
    });
  });

  it("6. pack.mcmeta imbriqué rejeté", async () => {
    await withTemp(async dir => {
      const z = path.join(dir, "nested.zip");
      await writeValidZip(z, { nestMcmeta: true });
      assert.throws(() => validateResourcePackZip(z), /pack.mcmeta absent/);
    });
  });

  it("7. pack.mcmeta JSON invalide rejeté", async () => {
    await withTemp(async dir => {
      const z = path.join(dir, "badjson.zip");
      await writeValidZip(z, { mcmeta: "{not json" });
      assert.throws(() => validateResourcePackZip(z), /JSON invalide/);
    });
  });

  it("8. pack.mcmeta sans pack rejeté", async () => {
    await withTemp(async dir => {
      const z = path.join(dir, "nopack.zip");
      await writeValidZip(z, { mcmeta: JSON.stringify({ description: "x" }) });
      assert.throws(() => validateResourcePackZip(z), /sans objet pack/);
    });
  });

  it("9. format moderne min_format/max_format accepté", async () => {
    await withTemp(async dir => {
      const z = path.join(dir, "modern.zip");
      await writeValidZip(z, { mcmeta: modernMcmeta() });
      assert.doesNotThrow(() => validateResourcePackZip(z));
    });
  });

  it("10. ancien pack_format accepté", async () => {
    await withTemp(async dir => {
      const z = path.join(dir, "legacy.zip");
      await writeValidZip(z, { mcmeta: legacyMcmeta() });
      assert.doesNotThrow(() => validateResourcePackZip(z));
    });
  });

  it("11. assets absent rejeté", async () => {
    await withTemp(async dir => {
      const z = path.join(dir, "noassets.zip");
      const zip = new AdmZip();
      zip.addFile("pack.mcmeta", Buffer.from(modernMcmeta()));
      await fs.writeFile(z, zip.toBuffer());
      assert.throws(() => validateResourcePackZip(z), /assets/);
    });
  });

  it("12. assets vide rejeté", async () => {
    await withTemp(async dir => {
      const z = path.join(dir, "emptyassets.zip");
      await writeValidZip(z, { assets: false, emptyAssetsDir: true });
      assert.throws(() => validateResourcePackZip(z), /vide/);
    });
  });

  it("13. ZIP entry ../ traversal rejetée", async () => {
    await withTemp(async dir => {
      const z = path.join(dir, "trav.zip");
      const mc = Buffer.from(modernMcmeta());
      const asset = Buffer.from("{}");
      const evil = Buffer.from("x");
      const buf = craftZipWithEntryNames(
        ["pack.mcmeta", "assets/x.json", "../evil.txt"],
        [mc, asset, evil]
      );
      await fs.writeFile(z, buf);
      assert.throws(() => validateResourcePackZip(z), /traversal/);
    });
  });

  it("14. ZIP absolute path rejetée", async () => {
    await withTemp(async dir => {
      const z = path.join(dir, "abs.zip");
      const mc = Buffer.from(modernMcmeta());
      const asset = Buffer.from("{}");
      const evil = Buffer.from("x");
      const buf = craftZipWithEntryNames(
        ["pack.mcmeta", "assets/x.json", "/etc/passwd"],
        [mc, asset, evil]
      );
      await fs.writeFile(z, buf);
      assert.throws(() => validateResourcePackZip(z), /absolue/);
    });
  });

  it("15. Windows drive path rejeté", async () => {
    await withTemp(async dir => {
      const z = path.join(dir, "drive.zip");
      const mc = Buffer.from(modernMcmeta());
      const asset = Buffer.from("{}");
      const evil = Buffer.from("x");
      const buf = craftZipWithEntryNames(
        ["pack.mcmeta", "assets/x.json", "C:/windows/evil.txt"],
        [mc, asset, evil]
      );
      await fs.writeFile(z, buf);
      assert.throws(() => validateResourcePackZip(z), /drive letter/);
    });
  });

  it("16-17. SHA et size calculés correctement", async () => {
    await withTemp(async dir => {
      const z = path.join(dir, "hash.zip");
      const buf = await writeValidZip(z);
      const expected = createHash("sha256").update(buf).digest("hex");
      const { sha256, size } = await hashFileBytes(z);
      assert.equal(sha256, expected);
      assert.equal(size, buf.length);
    });
  });
});

describe("manifest resourcePacks validation", () => {
  it("22/26/23-25. id dupliqué / autoEnable / targetPath invalid", () => {
    const base = {
      id: "sweetcraft-fr",
      displayName: "SweetCraft FR",
      version: "1.0",
      targetPath: "resourcepacks/SweetCraft-FR-v1.0.zip",
      sha256: "a".repeat(64),
      size: 1,
      autoEnable: true
    };
    assert.throws(
      () => validateManifestResourcePacks([base, { ...base }], "client"),
      /dupliqué/
    );
    assert.throws(
      () => validateManifestResourcePacks([{ ...base, autoEnable: "yes" as unknown as boolean }], "client"),
      ManifestResourcePackError
    );
    assert.throws(
      () => validateManifestResourcePacks([{ ...base, targetPath: "resourcepacks/../x.zip" }], "client"),
      /traversal|path/
    );
    assert.throws(
      () => validateManifestResourcePacks([{ ...base, targetPath: "resourcepacks\\x.zip" }], "client"),
      /backslash/
    );
    assert.throws(
      () => validateManifestResourcePacks([{ ...base, targetPath: "mods/x.zip" }], "client"),
      /resourcepacks/
    );
  });

  it("27-28. sourcePath / chemin Windows refusés dans manifest public", () => {
    const base = {
      id: "sweetcraft-fr",
      displayName: "SweetCraft FR",
      version: "1.0",
      targetPath: "resourcepacks/SweetCraft-FR-v1.0.zip",
      sha256: "a".repeat(64),
      size: 1,
      autoEnable: true,
      sourcePath: "H:\\Users\\kevin\\pack.zip"
    };
    assert.throws(() => validateManifestResourcePacks([base], "client"), /sourcePath/);
  });

  it("35. server avec packs échoue", () => {
    assert.throws(
      () =>
        validateManifestResourcePacks(
          [
            {
              id: "sweetcraft-fr",
              displayName: "X",
              version: "1",
              targetPath: "resourcepacks/x.zip",
              sha256: "a".repeat(64),
              size: 1,
              autoEnable: true
            }
          ],
          "server"
        ),
      /doit être \[\]/
    );
  });
});

describe("stage + verify resource packs", () => {
  it("18-21,29,37. staging byte-identical + schema 6 + checksums + verify OK", async () => {
    await withTemp(async dir => {
      const source = path.join(dir, "pack");
      const outDir = path.join(dir, "releases");
      const zipPath = path.join(dir, "SweetCraft-FR-v1.0.zip");
      const zipBuf = await writeValidZip(zipPath);
      const sha = createHash("sha256").update(zipBuf).digest("hex");
      const cfgBody = Buffer.from('{"a":1}\n');
      const cfgSha = createHash("sha256").update(cfgBody).digest("hex");
      await fs.mkdir(path.join(source, "config"), { recursive: true });
      await fs.writeFile(path.join(source, "config", "demo.json"), cfgBody);

      const prepared = await prepareResourcePacks([sourceEntry(zipPath)], dir);
      const result = await stageRelease({
      assemblyGate: { mode: "unit-test-bypass" as const, token: UNIT_TEST_STAGE_BYPASS },
        catalog: readyCatalog([
          cfg({ path: "config/demo.json", policy: "SERVER_FORCE", target: "BOTH", sha256: cfgSha, size_bytes: cfgBody.length })
        ]),
        packVersion: "0.9.0-test",
        sourceRoot: source,
        outDir,
        createdAt: "2026-01-01T00:00:00.000Z",
        signer: new UnsignedDevSigner(),
        resourcePacks: prepared
      });

      assert.equal(result.resourcePacksStaged, 1);
      const stagedZip = path.join(result.releaseDir, "files", "resourcepacks", "SweetCraft-FR-v1.0.zip");
      const stagedBuf = await fs.readFile(stagedZip);
      assert.deepEqual(stagedBuf, zipBuf);
      assert.equal(createHash("sha256").update(stagedBuf).digest("hex"), sha);

      const client = JSON.parse(await fs.readFile(path.join(result.releaseDir, "client-manifest.json"), "utf8"));
      const server = JSON.parse(await fs.readFile(path.join(result.releaseDir, "server-manifest.json"), "utf8"));
      assert.equal(client.schemaVersion, MANIFEST_SCHEMA_VERSION);
      assert.equal(server.schemaVersion, MANIFEST_SCHEMA_VERSION);
      assert.equal(client.resourcePacks.length, 1);
      assert.equal(client.resourcePacks[0].id, "sweetcraft-fr");
      assert.deepEqual(server.resourcePacks, []);
      assert.equal(client.resourcePacks[0].sourcePath, undefined);
      const clientStr = JSON.stringify(client);
      assert.ok(!clientStr.includes("sourcePath"));
      assert.ok(!/H:\\\\|Users\\\\kevin/i.test(clientStr));

      const checksums = JSON.parse(await fs.readFile(path.join(result.releaseDir, "checksums.json"), "utf8"));
      assert.ok(checksums.entries.some((e: { path: string }) => e.path === "files/resourcepacks/SweetCraft-FR-v1.0.zip"));

      const v = await verifyRelease({ releaseDir: result.releaseDir, allowUnsignedDev: true });
      assert.equal(v.ok, true, v.errors.join("; "));
    });
  });

  it("30. staged ZIP modifié → verifyRelease FAIL", async () => {
    await withTemp(async dir => {
      const { releaseDir } = await stageMinimalWithRp(dir);
      const stagedZip = path.join(releaseDir, "files", "resourcepacks", "SweetCraft-FR-v1.0.zip");
      await fs.appendFile(stagedZip, Buffer.from("X"));
      const v = await verifyRelease({ releaseDir, allowUnsignedDev: true });
      assert.equal(v.ok, false);
    });
  });

  it("31. staged ZIP supprimé → FAIL", async () => {
    await withTemp(async dir => {
      const { releaseDir } = await stageMinimalWithRp(dir);
      await fs.unlink(path.join(releaseDir, "files", "resourcepacks", "SweetCraft-FR-v1.0.zip"));
      const v = await verifyRelease({ releaseDir, allowUnsignedDev: true });
      assert.equal(v.ok, false);
    });
  });

  it("32. SHA manifest modifié → FAIL", async () => {
    await withTemp(async dir => {
      const { releaseDir } = await stageMinimalWithRp(dir);
      const clientPath = path.join(releaseDir, "client-manifest.json");
      const client = JSON.parse(await fs.readFile(clientPath, "utf8"));
      client.resourcePacks[0].sha256 = "b".repeat(64);
      await fs.writeFile(clientPath, JSON.stringify(client, null, 2) + "\n");
      const v = await verifyRelease({ releaseDir, allowUnsignedDev: true });
      assert.equal(v.ok, false);
    });
  });

  it("33. size manifest modifiée → FAIL", async () => {
    await withTemp(async dir => {
      const { releaseDir } = await stageMinimalWithRp(dir);
      const clientPath = path.join(releaseDir, "client-manifest.json");
      const client = JSON.parse(await fs.readFile(clientPath, "utf8"));
      client.resourcePacks[0].size = 1;
      await fs.writeFile(clientPath, JSON.stringify(client, null, 2) + "\n");
      const v = await verifyRelease({ releaseDir, allowUnsignedDev: true });
      assert.equal(v.ok, false);
    });
  });

  it("34. fichier resourcepack orphelin → strict fileset FAIL", async () => {
    await withTemp(async dir => {
      const { releaseDir } = await stageMinimalWithRp(dir);
      await fs.writeFile(path.join(releaseDir, "files", "resourcepacks", "orphan.zip"), Buffer.from("x"));
      const v = await verifyRelease({ releaseDir, allowUnsignedDev: true });
      assert.equal(v.ok, false);
      assert.ok(v.errors.some(e => /inattendu|orphan/i.test(e) || e.includes("orphan.zip")));
    });
  });

  it("35. server manifest contenant sweetcraft-fr → FAIL", async () => {
    await withTemp(async dir => {
      const { releaseDir } = await stageMinimalWithRp(dir);
      const serverPath = path.join(releaseDir, "server-manifest.json");
      const server = JSON.parse(await fs.readFile(serverPath, "utf8"));
      const client = JSON.parse(await fs.readFile(path.join(releaseDir, "client-manifest.json"), "utf8"));
      server.resourcePacks = client.resourcePacks;
      await fs.writeFile(serverPath, JSON.stringify(server, null, 2) + "\n");
      const v = await verifyRelease({ releaseDir, allowUnsignedDev: true });
      assert.equal(v.ok, false);
    });
  });

  it("36. client manifest duplicate ID → FAIL", async () => {
    await withTemp(async dir => {
      const { releaseDir } = await stageMinimalWithRp(dir);
      const clientPath = path.join(releaseDir, "client-manifest.json");
      const client = JSON.parse(await fs.readFile(clientPath, "utf8"));
      client.resourcePacks.push({ ...client.resourcePacks[0] });
      await fs.writeFile(clientPath, JSON.stringify(client, null, 2) + "\n");
      const v = await verifyRelease({ releaseDir, allowUnsignedDev: true });
      assert.equal(v.ok, false);
    });
  });

  it("38-39. publish signé avec resourcepack + verifyChannel OK", async () => {
    await withTemp(async dir => {
      const signer = createEphemeralEd25519Signer("test-key-rp");
      const { releaseDir } = await stageMinimalWithRp(dir, signer);
      const pubRoot = path.join(dir, "publish");
      const r = await publishRelease({
        releaseDir,
        channel: "dev",
        outDir: pubRoot,
        trustedKeys: { [signer.publicKeyId]: signer.publicKeyPem },
        signer,
        sequence: 1
      });
      assert.equal(r.releaseSignature, "SIGNED");
      const vr = await verifyRelease({
        releaseDir: r.releaseDir,
        trustedKeys: { [signer.publicKeyId]: signer.publicKeyPem }
      });
      assert.equal(vr.ok, true, vr.errors.join("; "));
      const ch = await verifyChannelDescriptor({
        channelFile: r.channelFile,
        root: pubRoot,
        trustedKeys: { [signer.publicKeyId]: signer.publicKeyPem }
      });
      assert.equal(ch.ok, true, ch.errors?.join("; ") ?? "");
    });
  });

  it("legacy manifest schema 5 still verifies (implicit resourcePacks=[])", async () => {
    await withTemp(async dir => {
      const { releaseDir } = await stageMinimalWithRp(dir);
      // Downgrade manifests + release to schema 5 without resourcePacks (historical shape)
      for (const name of ["client-manifest.json", "server-manifest.json"] as const) {
        const p = path.join(releaseDir, name);
        const doc = JSON.parse(await fs.readFile(p, "utf8"));
        doc.schemaVersion = 5;
        delete doc.resourcePacks;
        await fs.writeFile(p, JSON.stringify(doc, null, 2) + "\n");
      }
      // Remove resource pack from disk + checksums to match v5 era fileset
      await fs.rm(path.join(releaseDir, "files", "resourcepacks"), { recursive: true, force: true });
      const checksumsPath = path.join(releaseDir, "checksums.json");
      const checksums = JSON.parse(await fs.readFile(checksumsPath, "utf8"));
      checksums.entries = checksums.entries.filter(
        (e: { path: string }) => !e.path.startsWith("files/resourcepacks/")
      );
      for (const name of ["client-manifest.json", "server-manifest.json"] as const) {
        const abs = path.join(releaseDir, name);
        const st = await fs.stat(abs);
        const sha = createHash("sha256").update(await fs.readFile(abs)).digest("hex");
        const entry = checksums.entries.find((e: { path: string }) => e.path === name);
        entry.size = st.size;
        entry.sha256 = sha;
      }
      await fs.writeFile(checksumsPath, JSON.stringify(checksums, null, 2) + "\n");
      const releasePath = path.join(releaseDir, "release.json");
      const release = JSON.parse(await fs.readFile(releasePath, "utf8"));
      release.manifestSchemaVersion = 5;
      release.artefacts.clientManifest.sha256 = checksums.entries.find(
        (e: { path: string }) => e.path === "client-manifest.json"
      ).sha256;
      release.artefacts.serverManifest.sha256 = checksums.entries.find(
        (e: { path: string }) => e.path === "server-manifest.json"
      ).sha256;
      release.artefacts.checksums.sha256 = createHash("sha256")
        .update(await fs.readFile(checksumsPath))
        .digest("hex");
      await fs.writeFile(releasePath, JSON.stringify(release, null, 2) + "\n");

      const v = await verifyRelease({ releaseDir, allowUnsignedDev: true });
      assert.equal(v.ok, true, v.errors.join("; "));
    });
  });

  it("duplicate id rejected at prepare", async () => {
    await withTemp(async dir => {
      const z = path.join(dir, "a.zip");
      await writeValidZip(z);
      await assert.rejects(
        () => prepareResourcePacks([sourceEntry(z), sourceEntry(z)], dir),
        /dupliqué/
      );
    });
  });
});

async function stageMinimalWithRp(
  dir: string,
  signer: UnsignedDevSigner | ReturnType<typeof createEphemeralEd25519Signer> = new UnsignedDevSigner()
) {
  const source = path.join(dir, "pack");
  const outDir = path.join(dir, "releases");
  const zipPath = path.join(dir, "SweetCraft-FR-v1.0.zip");
  await writeValidZip(zipPath);
  const cfgBody = Buffer.from('{"a":1}\n');
  const cfgSha = createHash("sha256").update(cfgBody).digest("hex");
  await fs.mkdir(path.join(source, "config"), { recursive: true });
  await fs.writeFile(path.join(source, "config", "demo.json"), cfgBody);
  const prepared = await prepareResourcePacks([sourceEntry(zipPath)], dir);
  const result = await stageRelease({
      assemblyGate: { mode: "unit-test-bypass" as const, token: UNIT_TEST_STAGE_BYPASS },
    catalog: readyCatalog([
      cfg({ path: "config/demo.json", policy: "SERVER_FORCE", target: "BOTH", sha256: cfgSha, size_bytes: cfgBody.length })
    ]),
    packVersion: "0.9.0-test",
    sourceRoot: source,
    outDir,
    force: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    signer,
    resourcePacks: prepared
  });
  return result;
}

describe("toManifestResourcePack", () => {
  it("omits sourceAbsolutePath", async () => {
    await withTemp(async dir => {
      const z = path.join(dir, "a.zip");
      await writeValidZip(z);
      const [p] = await prepareResourcePacks([sourceEntry(z)], dir);
      const m = toManifestResourcePack(p);
      assert.equal((m as { sourcePath?: string }).sourcePath, undefined);
      assert.equal(m.id, "sweetcraft-fr");
    });
  });
});
