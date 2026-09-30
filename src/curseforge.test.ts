import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertSafeCurseForgeDownloadUrl,
  chooseFileApproximate,
  chooseFileByHash,
  curseforgeApiKeyPresent,
  resolveCurseForgeExact,
  sha1OfCfFile,
  type CFFile
} from "./curseforge.js";
import type { Catalog, ModRecord } from "./types.js";
import { CATALOG_SCHEMA_VERSION } from "./types.js";

function mod(p: Partial<ModRecord> & Pick<ModRecord, "mod_id" | "jar">): ModRecord {
  return {
    name: p.mod_id,
    version: p.version ?? "1",
    size_bytes: p.size_bytes ?? 100,
    sha256: p.sha256 ?? "a".repeat(64),
    sha1: p.sha1,
    side_class: "BOTH_REQUIRED",
    install_client: true,
    install_server: true,
    distribution_policy: p.distribution_policy ?? "UPSTREAM_REQUIRED",
    curseforge_project_id: p.curseforge_project_id,
    ...p
  };
}

function cat(mods: ModRecord[]): Catalog {
  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    generatedFor: {
      product: "SweetCraft",
      minecraft: "26.1.2",
      fabricLoader: "0.19.3",
      server: "t"
    },
    mods,
    configs: []
  };
}

const sampleFile = (over: Partial<CFFile> = {}): CFFile => ({
  id: 1,
  modId: 99,
  displayName: "x",
  fileName: "ftb-quests-fabric-26.1.2.7.jar",
  fileLength: 100,
  gameVersions: ["26.1.2", "Fabric"],
  hashes: [{ algo: 1, value: "b95b2fafc9a7f4be14ebfb8c92e1da7ca22ba1f1" }],
  ...over
});

describe("CurseForge hash-exact resolution", () => {
  it("1. auth env absent → CURSEFORGE_AUTH_MISSING rows, no throw leak", async () => {
    const prev = process.env.CURSEFORGE_API_KEY;
    delete process.env.CURSEFORGE_API_KEY;
    try {
      assert.equal(curseforgeApiKeyPresent(), false);
      const r = await resolveCurseForgeExact(
        cat([
          mod({
            mod_id: "ftbquests",
            jar: "ftb-quests-fabric-26.1.2.7.jar",
            sha1: "b95b2fafc9a7f4be14ebfb8c92e1da7ca22ba1f1",
            curseforge_project_id: 438496
          })
        ]),
        { onlyModIds: new Set(["ftbquests"]) }
      );
      assert.equal(r.authMissing, true);
      assert.equal(r.rows[0]?.status, "CURSEFORGE_AUTH_MISSING");
      const dumped = JSON.stringify(r);
      assert.equal(dumped.includes("x-api-key"), false);
      assert.ok(!/CURSEFORGE_API_KEY.:.[^"]+/.test(dumped));
    } finally {
      if (prev !== undefined) process.env.CURSEFORGE_API_KEY = prev;
      else delete process.env.CURSEFORGE_API_KEY;
    }
  });

  it("2. secret never appears in serialized catalog fields", async () => {
    delete process.env.CURSEFORGE_API_KEY;
    const r = await resolveCurseForgeExact(
      cat([
        mod({
          mod_id: "ftblibrary",
          jar: "x.jar",
          sha1: "aa",
          curseforge_project_id: 1
        })
      ])
    );
    const s = JSON.stringify(r.catalog);
    assert.ok(!s.toLowerCase().includes("x-api-key"));
  });

  it("5. SHA-1 exact match selects file", () => {
    const m = mod({
      mod_id: "ftbquests",
      jar: "ftb-quests-fabric-26.1.2.7.jar",
      sha1: "b95b2fafc9a7f4be14ebfb8c92e1da7ca22ba1f1",
      size_bytes: 100
    });
    const f = chooseFileByHash(m, [
      sampleFile({ id: 9, fileName: "other.jar", hashes: [{ algo: 1, value: "deadbeef" }] }),
      sampleFile({ id: 42 })
    ]);
    assert.equal(f?.id, 42);
    assert.equal(sha1OfCfFile(f!), "b95b2fafc9a7f4be14ebfb8c92e1da7ca22ba1f1");
  });

  it("6. hash mismatch / wrong size → null (fail closed)", () => {
    const m = mod({
      mod_id: "ftbquests",
      jar: "ftb-quests-fabric-26.1.2.7.jar",
      sha1: "b95b2fafc9a7f4be14ebfb8c92e1da7ca22ba1f1",
      size_bytes: 999
    });
    assert.equal(chooseFileByHash(m, [sampleFile()]), null);
    assert.equal(
      chooseFileByHash(
        mod({
          mod_id: "x",
          jar: "x.jar",
          sha1: "ffffffffffffffffffffffffffffffffffffffff",
          size_bytes: 100
        }),
        [sampleFile()]
      ),
      null
    );
  });

  it("7. filename-only approximate must not be used as production chooser", () => {
    const m = mod({
      mod_id: "ftbquests",
      jar: "ftb-quests-fabric-26.1.2.7.jar",
      version: "26.1.2.7",
      size_bytes: 100,
      sha1: "0000000000000000000000000000000000000000"
    });
    assert.equal(chooseFileByHash(m, [sampleFile()]), null);
    // approximate would wrongly accept — prove it exists but production path ignores it
    assert.ok(chooseFileApproximate(m, [sampleFile()]));
  });

  it("8. HTTPS URL validation", () => {
    assert.doesNotThrow(() =>
      assertSafeCurseForgeDownloadUrl("https://edge.forgecdn.net/files/1/2/mod.jar")
    );
    assert.throws(() => assertSafeCurseForgeDownloadUrl("http://edge.forgecdn.net/x.jar"));
    assert.throws(() => assertSafeCurseForgeDownloadUrl("https://evil.example/x.jar"));
    assert.throws(() =>
      assertSafeCurseForgeDownloadUrl("https://user:pass@edge.forgecdn.net/x.jar")
    );
    assert.throws(() =>
      assertSafeCurseForgeDownloadUrl("https://edge.forgecdn.net/x.jar?api_key=secret")
    );
  });

  it("9. UPSTREAM_REQUIRED stays provider-only after auth-missing path", async () => {
    delete process.env.CURSEFORGE_API_KEY;
    const r = await resolveCurseForgeExact(
      cat([
        mod({
          mod_id: "ftbquests",
          jar: "x.jar",
          sha1: "aa",
          curseforge_project_id: 438496,
          distribution_policy: "UPSTREAM_REQUIRED"
        })
      ]),
      { onlyModIds: new Set(["ftbquests"]) }
    );
    assert.equal(r.catalog.mods[0]!.distribution_policy, "UPSTREAM_REQUIRED");
    assert.equal(r.catalog.mods[0]!.curseforge_file_url, undefined);
  });
});
