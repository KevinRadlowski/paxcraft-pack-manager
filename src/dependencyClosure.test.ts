import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Catalog, ModRecord } from "./types.js";
import {
  applyDependencyClosurePromotions,
  findClientDependencyClosureGaps,
  findServerDependencyClosureGaps,
  requiredDependencyIds
} from "./dependencyClosure.js";
import { applyCuration } from "./curation.js";
import { buildClientManifest, buildServerManifest } from "./manifest.js";
import { validate, releaseReady } from "./validate.js";

function mod(
  partial: Partial<ModRecord> & Pick<ModRecord, "mod_id" | "side_class"> & { depends?: Record<string, unknown> }
): ModRecord {
  const side = partial.side_class;
  return {
    jar: partial.jar ?? `${partial.mod_id}.jar`,
    mod_id: partial.mod_id,
    name: partial.name ?? partial.mod_id,
    version: partial.version ?? "1.0.0",
    size_bytes: partial.size_bytes ?? 10,
    sha256: partial.sha256 ?? "a".repeat(64),
    side_class: side,
    install_client: partial.install_client ?? side !== "SERVER_ONLY",
    install_server: partial.install_server ?? side !== "CLIENT_ONLY",
    distribution_policy: partial.distribution_policy ?? "SWEETCRAFT_ALLOWED",
    side_confidence: partial.side_confidence ?? "HIGH",
    depends: partial.depends ?? {},
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

describe("dependency closure", () => {
  it("alexsmobs / codxlib regression: SERVER_ONLY dep of client mod is a gap", () => {
    const c = catalog([
      mod({
        mod_id: "alexsmobs",
        side_class: "BOTH_REQUIRED",
        depends: { codxlib: ">=1.4.0", fabricloader: ">=0.18.4", minecraft: "26.1.2" }
      }),
      mod({
        mod_id: "codxlib",
        side_class: "SERVER_ONLY",
        install_client: false,
        install_server: true,
        depends: { fabricloader: "*", minecraft: "*" }
      }),
      mod({
        mod_id: "terralith",
        side_class: "SERVER_ONLY",
        install_client: false,
        install_server: true,
        depends: { lithostitched: "*" }
      }),
      mod({
        mod_id: "lithostitched",
        side_class: "SERVER_ONLY",
        install_client: false,
        install_server: true
      })
    ]);

    const gaps = findClientDependencyClosureGaps(c);
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0]!.dependentId, "alexsmobs");
    assert.equal(gaps[0]!.dependencyId, "codxlib");
    assert.match(gaps[0]!.message, /alexsmobs/);
    assert.match(gaps[0]!.message, /codxlib/);

    const findings = validate(c).filter(x => x.code === "CLIENT_DEP_CLOSURE");
    assert.equal(findings.length, 1);
    assert.equal(releaseReady(c).ready, false);

    // Server-only worldgen not pulled to client without a client dependent
    assert.ok(!gaps.some(g => g.dependencyId === "terralith" || g.dependencyId === "lithostitched"));
  });

  it("promotion closes alexsmobs→codxlib; client manifest includes codxlib; server unchanged for terralith", () => {
    const before = catalog([
      mod({
        mod_id: "alexsmobs",
        jar: "alexsmobs-2.1.6.jar",
        side_class: "BOTH_REQUIRED",
        depends: { codxlib: ">=1.4.0" }
      }),
      mod({
        mod_id: "codxlib",
        jar: "codxlib-1.5.1.jar",
        side_class: "SERVER_ONLY",
        install_client: false,
        install_server: true
      }),
      mod({
        mod_id: "terralith",
        jar: "Terralith.jar",
        side_class: "SERVER_ONLY",
        install_client: false,
        install_server: true
      })
    ]);

    const { catalog: after, promoted } = applyDependencyClosurePromotions(before);
    assert.equal(promoted.length, 1);
    assert.equal(promoted[0]!.mod_id, "codxlib");
    assert.equal(promoted[0]!.to, "SERVER_REQUIRED_CLIENT_OPTIONAL");

    const codx = after.mods.find(m => m.mod_id === "codxlib")!;
    assert.equal(codx.install_client, true);
    assert.equal(codx.side_class, "SERVER_REQUIRED_CLIENT_OPTIONAL");

    assert.equal(findClientDependencyClosureGaps(after).length, 0);
    assert.equal(validate(after).filter(x => x.code === "CLIENT_DEP_CLOSURE").length, 0);

    const client = buildClientManifest(after, "0.0.0-test", { generatedAt: "2020-01-01T00:00:00.000Z" });
    const server = buildServerManifest(after, "0.0.0-test", { generatedAt: "2020-01-01T00:00:00.000Z" });
    assert.ok(client.mods.some((m: { id: string }) => m.id === "alexsmobs"));
    assert.ok(client.mods.some((m: { id: string }) => m.id === "codxlib"));
    assert.ok(!client.mods.some((m: { id: string }) => m.id === "terralith"));
    assert.ok(server.mods.some((m: { id: string }) => m.id === "codxlib"));
    assert.ok(server.mods.some((m: { id: string }) => m.id === "terralith"));
  });

  it("server-only legitimate worldgen not propagated to client without reason", () => {
    const c = catalog([
      mod({ mod_id: "sodium", side_class: "CLIENT_ONLY", depends: { fabricloader: "*" } }),
      mod({
        mod_id: "cristellib",
        side_class: "SERVER_ONLY",
        install_client: false,
        depends: { fabricloader: "*" }
      }),
      mod({
        mod_id: "t_and_t",
        side_class: "SERVER_ONLY",
        install_client: false,
        depends: { cristellib: ">=3.1.3" }
      })
    ]);
    assert.deepEqual(findClientDependencyClosureGaps(c), []);
    const { promoted } = applyDependencyClosurePromotions(c);
    assert.equal(promoted.length, 0);
    const client = buildClientManifest(c, "0.0.0-test", { generatedAt: "t" });
    assert.ok(!client.mods.some((m: { id: string }) => m.id === "cristellib"));
  });

  it("transitive A → B → C promotions", () => {
    const before = catalog([
      mod({ mod_id: "a", side_class: "BOTH_REQUIRED", depends: { b: "*" } }),
      mod({ mod_id: "b", side_class: "SERVER_ONLY", install_client: false, depends: { c: "*" } }),
      mod({ mod_id: "c", side_class: "SERVER_ONLY", install_client: false })
    ]);
    const { catalog: after, promoted } = applyDependencyClosurePromotions(before);
    assert.equal(promoted.length, 2);
    assert.ok(after.mods.every(m => m.install_client));
    assert.equal(findClientDependencyClosureGaps(after).length, 0);
  });

  it("optional / absent suggests do not impose C; only depends keys", () => {
    const c = catalog([
      mod({
        mod_id: "a",
        side_class: "BOTH_REQUIRED",
        depends: { fabricloader: "*" }
        // no depends on c
      }),
      mod({ mod_id: "c", side_class: "SERVER_ONLY", install_client: false })
    ]);
    assert.deepEqual(findClientDependencyClosureGaps(c), []);
    assert.equal(requiredDependencyIds(c.mods[0]!).length, 0);
  });

  it("unknown / not-in-pack dependency does not invent resolution or ERROR", () => {
    const c = catalog([
      mod({
        mod_id: "a",
        side_class: "BOTH_REQUIRED",
        depends: { totally_missing_lib: "*", "fabric-api": "*" }
      })
    ]);
    assert.deepEqual(findClientDependencyClosureGaps(c), []);
    assert.equal(validate(c).filter(x => x.code === "CLIENT_DEP_CLOSURE").length, 0);
  });

  it("dependency cycle does not infinite-loop", () => {
    const c = catalog([
      mod({ mod_id: "a", side_class: "BOTH_REQUIRED", depends: { b: "*" } }),
      mod({ mod_id: "b", side_class: "BOTH_REQUIRED", depends: { a: "*" } })
    ]);
    assert.deepEqual(findClientDependencyClosureGaps(c), []);
    const { promoted } = applyDependencyClosurePromotions(c);
    assert.equal(promoted.length, 0);
  });

  it("readable diagnostic for missing obligatory client dependency", () => {
    const c = catalog([
      mod({ mod_id: "alexsmobs", side_class: "BOTH_REQUIRED", depends: { codxlib: ">=1.4.0" } }),
      mod({ mod_id: "codxlib", side_class: "SERVER_ONLY", install_client: false })
    ]);
    const f = validate(c).find(x => x.code === "CLIENT_DEP_CLOSURE")!;
    assert.equal(f.subject, "alexsmobs->codxlib");
    assert.match(f.message, /manifeste client/);
  });

  it("applyCuration promotes codxlib for alexsmobs; does not force SERVER_ONLY", () => {
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
        install_server: true,
        modrinth_environment: "server_only",
        curation_note: "stale wrong note: client does not need this"
      })
    ]);
    const { catalog: curated, closurePromoted } = applyCuration(c);
    assert.ok(closurePromoted >= 1);
    const codx = curated.mods.find(m => m.mod_id === "codxlib")!;
    assert.equal(codx.side_class, "SERVER_REQUIRED_CLIENT_OPTIONAL");
    assert.equal(codx.install_client, true);
    assert.match(codx.curation_note ?? "", /Client dependency closure/);
    assert.ok(!(codx.curation_note ?? "").includes("does not require"));
  });

  it("server manifest not regressed: SERVER_ONLY without client need stays server-only", () => {
    const c = catalog([
      mod({ mod_id: "structory", side_class: "SERVER_ONLY", install_client: false }),
      mod({ mod_id: "yungsapi", side_class: "BOTH_REQUIRED" })
    ]);
    const { catalog: after } = applyDependencyClosurePromotions(c);
    const structory = after.mods.find(m => m.mod_id === "structory")!;
    assert.equal(structory.side_class, "SERVER_ONLY");
    assert.equal(structory.install_client, false);
    const server = buildServerManifest(after, "0.0.0-test", { generatedAt: "t" });
    assert.ok(server.mods.some((m: { id: string }) => m.id === "structory"));
    assert.ok(server.mods.some((m: { id: string }) => m.id === "yungsapi"));
  });

  it("manifest determinism: sorted mod ids", () => {
    const c = catalog([
      mod({ mod_id: "zeta", side_class: "BOTH_REQUIRED", depends: { alpha: "*" } }),
      mod({
        mod_id: "alpha",
        side_class: "SERVER_ONLY",
        install_client: false,
        jar: "alpha.jar",
        sha256: "b".repeat(64)
      })
    ]);
    const { catalog: after } = applyDependencyClosurePromotions(c);
    const m1 = buildClientManifest(after, "1.0.0", { generatedAt: "fixed" });
    const m2 = buildClientManifest(after, "1.0.0", { generatedAt: "fixed" });
    assert.deepEqual(m1, m2);
    assert.deepEqual(
      m1.mods.map((x: { id: string }) => x.id),
      [...m1.mods.map((x: { id: string }) => x.id)].sort((a, b) => a.localeCompare(b))
    );
  });

  it("server-side gap: CLIENT_ONLY dep of server mod", () => {
    const c = catalog([
      mod({ mod_id: "srv", side_class: "SERVER_ONLY", install_client: false, depends: { lib: "*" } }),
      mod({ mod_id: "lib", side_class: "CLIENT_ONLY", install_server: false })
    ]);
    const gaps = findServerDependencyClosureGaps(c);
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0]!.dependencyId, "lib");
    const { catalog: after } = applyDependencyClosurePromotions(c);
    assert.equal(findServerDependencyClosureGaps(after).length, 0);
    assert.equal(after.mods.find(m => m.mod_id === "lib")!.side_class, "CLIENT_REQUIRED_SERVER_OPTIONAL");
  });
});
