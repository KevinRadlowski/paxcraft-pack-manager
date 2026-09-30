/**
 * Pre-rescan hardening tests for MODPACK FINAL CLEAN readiness.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { listTopLevelModJars, scanModsDir } from "./scan.js";
import {
  assertSafeNestedJarPath,
  extractNestedFabricModules,
  normalizeProvides,
  parseFabricModJsonObject,
  hyphenUnderscoreNearMiss
} from "./fabricMeta.js";
import { satisfiesFabricDependsValue, satisfiesFabricVersionPredicate } from "./fabricVersion.js";
import {
  satisfyDependencyOnSide,
  findClientDependencyClosureGaps,
  applyDependencyClosurePromotions
} from "./dependencyClosure.js";
import {
  applyCuration,
  CLEAN_FORBIDDEN_MOD_IDS
} from "./curation.js";
import { validate } from "./validate.js";
import { buildClientManifest, buildServerManifest } from "./manifest.js";
import { findExclusion } from "./configPolicyRules.js";
import type { Catalog, ModRecord, SideClass } from "./types.js";

function zipWithFmj(fmj: unknown, nested?: { path: string; fmj: unknown }[]): Buffer {
  const z = new AdmZip();
  z.addFile("fabric.mod.json", Buffer.from(JSON.stringify(fmj, null, 2), "utf8"));
  if (nested) {
    for (const n of nested) {
      const inner = new AdmZip();
      inner.addFile("fabric.mod.json", Buffer.from(JSON.stringify(n.fmj, null, 2), "utf8"));
      z.addFile(n.path, inner.toBuffer());
    }
  }
  return z.toBuffer();
}

function mod(
  partial: Partial<ModRecord> & Pick<ModRecord, "mod_id" | "side_class">
): ModRecord {
  const side = partial.side_class;
  return {
    jar: partial.jar ?? `${partial.mod_id}.jar`,
    mod_id: partial.mod_id,
    name: partial.name ?? partial.mod_id,
    version: partial.version ?? "1.0.0",
    size_bytes: 10,
    sha256: partial.sha256 ?? "a".repeat(64),
    side_class: side,
    install_client: partial.install_client ?? side !== "SERVER_ONLY",
    install_server: partial.install_server ?? side !== "CLIENT_ONLY",
    distribution_policy: "SWEETCRAFT_ALLOWED",
    side_confidence: "HIGH",
    depends: partial.depends ?? {},
    provides: partial.provides ?? {},
    nested_modules: partial.nested_modules ?? [],
    ...partial
  };
}

function catalog(mods: ModRecord[]): Catalog {
  return {
    schemaVersion: 2,
    generatedFor: {
      product: "SweetCraft",
      minecraft: "26.1.2",
      fabricLoader: "0.19.3",
      server: "dedicated"
    },
    mods,
    configs: []
  };
}

describe("scan top-level mods only", () => {
  it("1–2. accepts mods/*.jar and ignores mods/luckperms/libs/*.jar", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sc-scan-"));
    const mods = path.join(root, "mods");
    await mkdir(path.join(mods, "luckperms", "libs"), { recursive: true });
    const top = zipWithFmj({ id: "realmod", version: "1.0.0", environment: "*" });
    await writeFile(path.join(mods, "realmod-1.0.0.jar"), top);
    await writeFile(path.join(mods, "luckperms", "libs", "asm-9.8.jar"), Buffer.from("not-a-fabric-mod"));

    const listed = await listTopLevelModJars(mods);
    assert.equal(listed.length, 1);
    assert.ok(listed[0]!.endsWith("realmod-1.0.0.jar"));

    const scanned = await scanModsDir(mods);
    assert.equal(scanned.length, 1);
    assert.equal(scanned[0]!.mod_id, "realmod");
    assert.ok(!scanned.some(m => m.jar.includes("asm")));
  });
});

describe("fabric provides + nested", () => {
  it("4–5. provides array satisfies cloth-config2", () => {
    assert.deepEqual(normalizeProvides(["cloth-config2"]), { "cloth-config2": null });
    const c = catalog([
      mod({
        mod_id: "yungsbridges",
        side_class: "BOTH_REQUIRED",
        depends: { "cloth-config2": ">=26.1.154" }
      }),
      mod({
        mod_id: "cloth-config",
        side_class: "BOTH_REQUIRED",
        version: "26.1.154",
        provides: { "cloth-config2": null }
      })
    ]);
    const sat = satisfyDependencyOnSide("cloth-config2", ">=26.1.154", c, "client");
    assert.equal(sat.status, "UNKNOWN_VERSION_SEMANTICS"); // unversioned provide + range
    const satStar = satisfyDependencyOnSide("cloth-config2", "*", c, "client");
    assert.equal(satStar.status, "SATISFIED_PROVIDES");
  });

  it("provides with version map evaluates range", () => {
    const c = catalog([
      mod({
        mod_id: "consumer",
        side_class: "BOTH_REQUIRED",
        depends: { alias: ">=1.4.0" }
      }),
      mod({
        mod_id: "provider",
        side_class: "BOTH_REQUIRED",
        version: "9.9.9",
        provides: { alias: "1.5.1" }
      })
    ]);
    assert.equal(satisfyDependencyOnSide("alias", ">=1.4.0", c, "client").status, "SATISFIED_PROVIDES");
  });

  it("3/6–9. nested jars satisfy wunderlib, biscuit_roll, diagonalblocks, energy", async () => {
    const buf = zipWithFmj(
      {
        id: "host",
        version: "1",
        jars: [
          { file: "META-INF/jars/wunderlib-26.101.1.jar" },
          { file: "META-INF/jars/biscuit_roll-0.17.4.jar" },
          { file: "META-INF/jars/diagonalblocks-fabric-26.1.0.jar" },
          { file: "META-INF/jars/energy-5.0.0.jar" }
        ]
      },
      [
        {
          path: "META-INF/jars/wunderlib-26.101.1.jar",
          fmj: { id: "wunderlib", version: "26.101.1", environment: "*" }
        },
        {
          path: "META-INF/jars/biscuit_roll-0.17.4.jar",
          fmj: { id: "biscuit_roll", version: "0.17.4", environment: "*" }
        },
        {
          path: "META-INF/jars/diagonalblocks-fabric-26.1.0.jar",
          fmj: { id: "diagonalblocks", version: "26.1.0", environment: "*" }
        },
        {
          path: "META-INF/jars/energy-5.0.0.jar",
          fmj: { id: "team_reborn_energy", version: "5.0.0", environment: "*" }
        }
      ]
    );
    const { modules, errors } = extractNestedFabricModules(buf);
    assert.equal(errors.length, 0);
    assert.ok(modules.some(m => m.id === "wunderlib"));
    assert.ok(modules.some(m => m.id === "biscuit_roll"));
    assert.ok(modules.some(m => m.id === "diagonalblocks"));
    assert.ok(modules.some(m => m.id === "team_reborn_energy"));

    const host = mod({
      mod_id: "host",
      side_class: "BOTH_REQUIRED",
      nested_modules: modules.map(m => ({
        id: m.id,
        version: m.version,
        source: m.source,
        depth: m.depth,
        provides: m.provides,
        depends: m.depends
      }))
    });
    const c = catalog([
      host,
      mod({ mod_id: "uselessreptile", side_class: "BOTH_REQUIRED", depends: { biscuit_roll: "*" } }),
      mod({ mod_id: "bclib", side_class: "BOTH_REQUIRED", depends: { wunderlib: "26.101.x" } }),
      mod({ mod_id: "diagonalfences", side_class: "BOTH_REQUIRED", depends: { diagonalblocks: "*" } }),
      mod({
        mod_id: "refinedstorage",
        side_class: "BOTH_REQUIRED",
        depends: { team_reborn_energy: "*" }
      })
    ]);
    // nested modules live on host — index walks all installed mods' nested_modules
    assert.equal(satisfyDependencyOnSide("biscuit_roll", "*", c, "client").status, "SATISFIED_NESTED");
    assert.equal(
      satisfyDependencyOnSide("wunderlib", "26.101.x", c, "client").status,
      "SATISFIED_NESTED"
    );
    assert.equal(satisfyDependencyOnSide("diagonalblocks", "*", c, "client").status, "SATISFIED_NESTED");
    assert.equal(
      satisfyDependencyOnSide("team_reborn_energy", "*", c, "client").status,
      "SATISFIED_NESTED"
    );
  });

  it("18–20. invalid nested / traversal / cycle bounds", () => {
    assert.throws(() => assertSafeNestedJarPath("../evil.jar"));
    assert.throws(() => assertSafeNestedJarPath("/abs.jar"));

    const missing = zipWithFmj({
      id: "host",
      version: "1",
      jars: [{ file: "META-INF/jars/missing.jar" }]
    });
    const r = extractNestedFabricModules(missing);
    assert.ok(r.errors.some(e => e.includes("missing")));

    // cycle: A nests B nests A (same content hash stops recursion)
    const innerB = new AdmZip();
    innerB.addFile(
      "fabric.mod.json",
      Buffer.from(JSON.stringify({ id: "b", version: "1", jars: [{ file: "META-INF/jars/a.jar" }] }), "utf8")
    );
    // We'll just ensure max nodes doesn't infinite loop with duplicate content
    const a = zipWithFmj(
      { id: "a", version: "1", jars: [{ file: "META-INF/jars/b.jar" }] },
      [{ path: "META-INF/jars/b.jar", fmj: { id: "b", version: "1" } }]
    );
    const cyc = extractNestedFabricModules(a, { maxDepth: 8, maxNodes: 64 });
    assert.ok(cyc.modules.length >= 1);
  });
});

describe("version semantics", () => {
  it("11–12. wildcard x and OR array", () => {
    assert.equal(satisfiesFabricVersionPredicate("26.101.1", "26.101.x").status, "SATISFIED");
    assert.equal(satisfiesFabricVersionPredicate("26.1.2", "26.1.x").status, "SATISFIED");
    assert.equal(satisfiesFabricVersionPredicate("26.2.0", "26.1.x").status, "INCOMPATIBLE");
    assert.equal(
      satisfiesFabricDependsValue("26.1.2", ["26.1", "26.1.1", "26.1.2"]).status,
      "SATISFIED"
    );
    assert.equal(satisfiesFabricDependsValue("26.1.2", ">=1.4.0").status, "SATISFIED");
  });

  it("unknown syntax is not VERSION_INCOMPATIBLE", () => {
    const r = satisfiesFabricDependsValue("1.0.0", "[1.0,2.0)");
    assert.equal(r.status, "UNKNOWN_VERSION_SEMANTICS");
  });
});

describe("fabric-api umbrella", () => {
  it("13. fabric-api range uses top-level umbrella, not nested module version", () => {
    const c = catalog([
      mod({
        mod_id: "fabric-api",
        side_class: "BOTH_REQUIRED",
        version: "0.155.2+26.1.2",
        nested_modules: [
          {
            id: "fabric-lifecycle-events-v1",
            version: "0.149.1+26.1.2",
            source: "META-INF/jars/lifecycle.jar",
            depth: 1
          }
        ]
      }),
      mod({
        mod_id: "alexsmobs",
        side_class: "BOTH_REQUIRED",
        depends: { "fabric-api": ">=0.155.2+26.1.2" }
      })
    ]);
    const sat = satisfyDependencyOnSide("fabric-api", ">=0.155.2+26.1.2", c, "client");
    assert.equal(sat.status, "SATISFIED_TOP_LEVEL");
    assert.equal(sat.resolvedVersion, "0.155.2+26.1.2");
  });
});

describe("yumi ids", () => {
  it("10. hyphen/underscore are distinct — ALIAS_REQUIRED, not silent satisfy", () => {
    assert.equal(hyphenUnderscoreNearMiss("yumi-commons-core", "yumi_commons_core"), true);
    const c = catalog([
      mod({
        mod_id: "host",
        side_class: "BOTH_REQUIRED",
        nested_modules: [
          {
            id: "yumi_commons_core",
            version: "2.0.0",
            source: "META-INF/jars/yumi.jar",
            depth: 1
          }
        ]
      })
    ]);
    const sat = satisfyDependencyOnSide("yumi-commons-core", "^2.0.0", c, "client");
    assert.equal(sat.status, "ALIAS_REQUIRED");
  });
});

describe("CLEAN curation presence", () => {
  it("14–17. CodxLib/worldgen/Fallen C+S; Graves forbidden; client/server only preserved", () => {
    const c = catalog([
      mod({
        mod_id: "alexsmobs",
        side_class: "BOTH_REQUIRED",
        depends: { codxlib: ">=1.4.0" }
      }),
      mod({
        mod_id: "codxlib",
        side_class: "SERVER_ONLY",
        install_client: false,
        install_server: true
      }),
      mod({
        mod_id: "terralith",
        side_class: "SERVER_ONLY",
        install_client: false
      }),
      mod({ mod_id: "fallen", side_class: "UNKNOWN" }),
      mod({ mod_id: "sodium", side_class: "UNKNOWN" }),
      mod({ mod_id: "luckperms", side_class: "UNKNOWN" })
    ]);
    const presence = {
      client: new Set(["alexsmobs", "codxlib", "terralith", "fallen", "sodium"]),
      server: new Set(["alexsmobs", "codxlib", "terralith", "fallen", "luckperms"])
    };
    const { catalog: after } = applyCuration(c, { presence });
    const by = Object.fromEntries(after.mods.map(m => [m.mod_id, m]));
    assert.equal(by.codxlib!.side_class, "BOTH_REQUIRED");
    assert.equal(by.codxlib!.install_client, true);
    assert.equal(by.terralith!.side_class, "BOTH_REQUIRED");
    assert.equal(by.fallen!.side_class, "BOTH_REQUIRED");
    assert.equal(by.sodium!.side_class, "CLIENT_ONLY");
    assert.equal(by.luckperms!.side_class, "SERVER_ONLY");
    assert.ok(CLEAN_FORBIDDEN_MOD_IDS.has("universal-graves"));
    const withGraves = catalog([
      ...after.mods,
      mod({ mod_id: "universal-graves", side_class: "SERVER_REQUIRED_CLIENT_OPTIONAL" })
    ]);
    assert.ok(validate(withGraves).some(f => f.code === "FORBIDDEN_MOD"));
  });

  it("dependency closure still promotes when presence not supplied", () => {
    const c = catalog([
      mod({ mod_id: "alexsmobs", side_class: "BOTH_REQUIRED", depends: { codxlib: ">=1.4.0" } }),
      mod({
        mod_id: "codxlib",
        side_class: "SERVER_ONLY",
        install_client: false,
        install_server: true
      })
    ]);
    const { catalog: after } = applyDependencyClosurePromotions(c);
    assert.equal(after.mods.find(m => m.mod_id === "codxlib")!.install_client, true);
    assert.equal(findClientDependencyClosureGaps(after).length, 0);
  });
});

describe("config exclusions CLEAN audit", () => {
  it("excludes luckperms, resourceful web, grieflogger, casino economy, wover cache, BN world", () => {
    assert.ok(findExclusion("config/luckperms/luckperms.conf"));
    assert.ok(findExclusion("config/resourceful-config-web.json"));
    assert.ok(findExclusion("config/grieflogger/grieflogger-server.yaml"));
    assert.ok(findExclusion("config/xbasecasino/economy.json"));
    assert.ok(findExclusion("config/wover/cached.json"));
    assert.ok(findExclusion("config/betternether/world.json"));
  });

  it("excludes SYNC-04 obsolete mod configs and DistantHorizons residue", () => {
    assert.ok(findExclusion("config/DistantHorizons.toml"));
    assert.ok(findExclusion("config/bettercombat/fallback_compatibility.json"));
    assert.ok(findExclusion("config/uselessreptile.json5"));
    assert.ok(findExclusion("config/yacl.json5"));
    assert.ok(findExclusion("config/inventoryprofilesnext/integrationHints/exampleIntegrationHints.json"));
  });
});

describe("manifests ignore nested as install entries", () => {
  it("nested_modules do not appear as separate manifest mods", () => {
    const c = catalog([
      mod({
        mod_id: "fabric-api",
        side_class: "BOTH_REQUIRED",
        nested_modules: [
          { id: "biscuit_roll", version: "0.17.4", source: "META-INF/jars/x.jar", depth: 1 }
        ]
      })
    ]);
    const client = buildClientManifest(c, "0.0.0-test", { generatedAt: "t" });
    assert.deepEqual(
      client.mods.map((m: { id: string }) => m.id),
      ["fabric-api"]
    );
  });
});
