import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildClientManifest } from "./manifest.js";
import {
  configMigrationsForManifest,
  IPN_AUTOREFILL_FALSE_FROM_0_1_3,
  packVersionAtLeast
} from "./configMigrations.js";
import type { Catalog, ConfigRecord, ModRecord } from "./types.js";

function mod(partial: Partial<ModRecord> & Pick<ModRecord, "mod_id" | "side_class">): ModRecord {
  return {
    jar: `${partial.mod_id}.jar`,
    name: partial.mod_id,
    version: "1",
    size_bytes: 1,
    sha256: "a".repeat(64),
    install_client: true,
    install_server: false,
    distribution_policy: "UPSTREAM_PREFERRED",
    ...partial
  };
}

function cfg(partial: Partial<ConfigRecord> & Pick<ConfigRecord, "path" | "policy">): ConfigRecord {
  return {
    size_bytes: 1,
    sha256: "b".repeat(64),
    owner_mod_id: null,
    target: "CLIENT",
    ...partial
  };
}

function catalog(): Catalog {
  return {
    schemaVersion: 2,
    generatedFor: { product: "SweetCraft", minecraft: "26.1.2", fabricLoader: "0.19.3", server: "test" },
    mods: [mod({ mod_id: "inventoryprofilesnext", side_class: "CLIENT_ONLY" })],
    configs: [
      cfg({
        path: "config/inventoryprofilesnext/inventoryprofiles.json",
        policy: "CLIENT_DEFAULT",
        target: "CLIENT"
      })
    ]
  };
}

describe("configMigrations PM contract", () => {
  it("packVersionAtLeast compares semver triples", () => {
    assert.equal(packVersionAtLeast("0.1.4", "0.1.4"), true);
    assert.equal(packVersionAtLeast("0.1.3", "0.1.4"), false);
    assert.equal(packVersionAtLeast("0.2.0", "0.1.4"), true);
  });

  it("0.1.3 manifest has no configMigrations", () => {
    assert.deepEqual(configMigrationsForManifest("0.1.3"), []);
    const m = buildClientManifest(catalog(), "0.1.3", { generatedAt: "fixed" });
    assert.equal((m as { configMigrations?: unknown[] }).configMigrations, undefined);
  });

  it("0.1.4+ manifest embeds IPN one-shot migration", () => {
    const migrations = configMigrationsForManifest("0.1.4");
    assert.equal(migrations.length, 1);
    assert.equal(migrations[0]!.id, IPN_AUTOREFILL_FALSE_FROM_0_1_3.id);
    assert.equal(migrations[0]!.set.length, 2);

    const m = buildClientManifest(catalog(), "0.1.4", { generatedAt: "fixed" });
    const embedded = (m as { configMigrations: typeof migrations }).configMigrations;
    assert.equal(embedded.length, 1);
    assert.equal(embedded[0]!.configPath, IPN_AUTOREFILL_FALSE_FROM_0_1_3.configPath);
    assert.deepEqual(embedded[0]!.fromPackVersions, ["0.1.3"]);
  });

  it("IPN config remains if_missing in manifest", () => {
    const m = buildClientManifest(catalog(), "0.1.4", { generatedAt: "fixed" });
    const ipn = m.configs.find(c => c.path.includes("inventoryprofiles.json"));
    assert.ok(ipn);
    assert.equal(ipn!.apply, "if_missing");
  });
});
