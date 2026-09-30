import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyValidatedCurseForgeClosure,
  loadValidatedCurseForgeFixture,
  mergeProviderMetadata,
  summarizeProviderClosure,
  VALIDATED_CF_FIXTURE_0_1_3_SEQ4
} from "./providerClosure.js";
import { resolveArtifactSource } from "./artifactSource.js";
import type { Catalog, ModRecord } from "./types.js";

function mod(partial: Partial<ModRecord> & Pick<ModRecord, "mod_id" | "jar" | "sha256">): ModRecord {
  return {
    name: partial.mod_id,
    version: "1",
    size_bytes: 100,
    side_class: "BOTH_REQUIRED",
    install_client: true,
    install_server: true,
    distribution_policy: "UPSTREAM_REQUIRED",
    ...partial
  };
}

function catalog(...mods: ModRecord[]): Catalog {
  return {
    schemaVersion: 2,
    generatedFor: { product: "SweetCraft", minecraft: "26.1.2", fabricLoader: "0.19.3", server: "t" },
    mods,
    configs: []
  };
}

describe("providerClosure", () => {
  it("mergeProviderMetadata is sha256-gated", () => {
    const base = catalog(
      mod({ mod_id: "ftbquests", jar: "a.jar", sha256: "a".repeat(64) })
    );
    const resolved = catalog(
      mod({
        mod_id: "ftbquests",
        jar: "a.jar",
        sha256: "a".repeat(64),
        modrinth_file_url: "https://cdn.modrinth.com/x.jar"
      })
    );
    const merged = mergeProviderMetadata(base, resolved);
    assert.equal(merged.mods[0]!.modrinth_file_url, "https://cdn.modrinth.com/x.jar");

    const resolvedWrong = catalog(
      mod({
        mod_id: "ftbquests",
        jar: "a.jar",
        sha256: "b".repeat(64),
        modrinth_file_url: "https://cdn.modrinth.com/y.jar"
      })
    );
    const notMerged = mergeProviderMetadata(base, resolvedWrong);
    assert.equal(notMerged.mods[0]!.modrinth_file_url, undefined);
  });

  it("loads validated CurseForge entries from portable 0.1.3-seq4 fixture", () => {
    const entries = loadValidatedCurseForgeFixture(VALIDATED_CF_FIXTURE_0_1_3_SEQ4);
    assert.equal(entries.length, 5);
    assert.ok(entries.some(e => e.mod_id === "ftbquests"));
    for (const e of entries) {
      assert.match(e.curseforge_file_url, /^https:\/\/edge\.forgecdn\.net\//);
      assert.equal(e.source, VALIDATED_CF_FIXTURE_0_1_3_SEQ4);
    }
  });

  it("applyValidatedCurseForgeClosure matches FTB sha256 from FINAL CLEAN catalog", async () => {
    const { readCatalog } = await import("./io.js");
    const c = await readCatalog("data/catalog.configs.json");
    const ftb = c.mods.find(m => m.mod_id === "ftbquests");
    assert.ok(ftb);
    const entries = loadValidatedCurseForgeFixture(VALIDATED_CF_FIXTURE_0_1_3_SEQ4);
    const { catalog: after, applied } = applyValidatedCurseForgeClosure(c, entries);
    const updated = after.mods.find(m => m.mod_id === "ftbquests")!;
    if (applied.includes("ftbquests")) {
      assert.ok(updated.curseforge_file_url);
      assert.equal(updated.provider_resolution_status, "VALIDATED_PRIOR_RELEASE_CF");
      assert.equal(resolveArtifactSource(updated).kind, "PROVIDER");
    }
  });

  it("summarizeProviderClosure counts release-hosted without upstream URL", async () => {
    const { readCatalog } = await import("./io.js");
    const c = await readCatalog("data/catalog.configs.json");
    const s = summarizeProviderClosure(c);
    assert.equal(s.clientInstall, 110);
    assert.equal(s.serverInstall, 94);
    assert.ok(s.releaseHostedWithoutUrl >= 3);
  });
});
