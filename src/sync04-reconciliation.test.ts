import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { classifyConfigs } from "./configPolicy.js";
import { findExclusion } from "./configPolicyRules.js";
import { applyModeForPolicy, buildClientManifest, buildServerManifest } from "./manifest.js";
import { readCatalog } from "./io.js";
import type { ResourcePackConfigFile } from "./resourcePackTypes.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const CATALOG = path.join(ROOT, "data/catalog.configs.json");
/** Portable canonical example — local operators copy to data/resourcepacks.json with machine paths. */
const RESOURCE_PACKS = path.join(ROOT, "data/resourcepacks.example.json");

const CASINO_JAR_SHA = "750128c35b68443e5cf3e760cc29781a79229c60473681dedb91b40acf7e269c";
const DD_SYNC_SHA = "f6e72109408f1343fdd748e828e9094ad8e52609a34da9f98114e2d8c8c05205";

/** Obsolete managed mods per SYNC-03 DELETE_MANAGED (mod_id as resolved by PM scan). */
const REMOVED_MOD_IDS = [
  "armoredfoes",
  "bettercombat",
  "distanthorizons",
  "player_animation_library",
  "uselessreptile",
  "visualworkbench",
  "yet_another_config_lib_v3"
] as const;

function topLevelInstallCount(catalog: Awaited<ReturnType<typeof readCatalog>>, side: "client" | "server"): number {
  return catalog.mods.filter(m => (side === "client" ? m.install_client : m.install_server)).length;
}

describe("SYNC-04 PM reconciliation (catalog.configs.json)", () => {
  it("represents FINAL CLEAN mod counts (110 client / 94 server top-level)", async () => {
    const c = await readCatalog(CATALOG);
    assert.equal(topLevelInstallCount(c, "client"), 110);
    assert.equal(topLevelInstallCount(c, "server"), 94);
    // 120 unique mod_id rows = 84 BOTH + 26 CLIENT_ONLY + 10 SERVER_ONLY
    assert.equal(c.mods.length, 120);
    assert.equal(c.mods.filter(m => m.side_class === "BOTH_REQUIRED").length, 84);
    assert.equal(c.mods.filter(m => m.side_class === "CLIENT_ONLY").length, 26);
    assert.equal(c.mods.filter(m => m.side_class === "SERVER_ONLY").length, 10);
  });

  it("Casino 0.9.17 with authoritative sha256", async () => {
    const c = await readCatalog(CATALOG);
    const casino = c.mods.find(m => m.mod_id === "xbasecasino");
    assert.ok(casino, "xbasecasino present");
    assert.match(casino!.version, /0\.9\.17/);
    assert.match(casino!.jar, /xbase-casino-0\.9\.17/);
    assert.equal(casino!.sha256, CASINO_JAR_SHA);
    assert.equal(casino!.install_client, true);
    assert.equal(casino!.install_server, true);
  });

  it("removed obsolete mods absent from catalogue", async () => {
    const c = await readCatalog(CATALOG);
    const ids = new Set(c.mods.map(m => m.mod_id));
    for (const id of REMOVED_MOD_IDS) {
      assert.ok(!ids.has(id), `obsolete mod still present: ${id}`);
    }
    assert.ok(!c.mods.some(m => m.jar.includes("xbase-casino-0.7.5")));
  });

  it("critical config policies and hashes", async () => {
    const c = await readCatalog(CATALOG);
    const byPath = new Map(c.configs.map(cf => [cf.path, cf]));

    const amc = byPath.get("config/amc.json");
    assert.ok(amc);
    assert.equal(amc!.policy, "SERVER_FORCE");
    assert.equal(applyModeForPolicy(amc!.policy), "force");
    assert.equal(amc!.target, "BOTH");

    const dd = byPath.get("config/dynamic_difficulty/sync.toml");
    assert.ok(dd);
    assert.equal(dd!.sha256, DD_SYNC_SHA);
    assert.equal(dd!.policy, "SERVER_FORCE");
    assert.equal(dd!.target, "BOTH");

    const mob = byPath.get("config/mobchampions-common.toml");
    assert.ok(mob);
    assert.equal(mob!.policy, "SERVER_FORCE");
    assert.equal(mob!.target, "BOTH");

    const poker = byPath.get("config/xbasecasino/video_poker.json");
    assert.ok(poker);
    assert.equal(poker!.policy, "SERVER_FORCE");
    assert.equal(applyModeForPolicy(poker!.policy), "force");
  });

  it("IPN global config if_missing; runtime IPN subtrees excluded", async () => {
    const c = await readCatalog(CATALOG);
    const ipn = c.configs.find(cf => cf.path === "config/inventoryprofilesnext/inventoryprofiles.json");
    assert.ok(ipn);
    assert.equal(ipn!.policy, "CLIENT_DEFAULT");
    assert.equal(applyModeForPolicy(ipn!.policy), "if_missing");

    assert.ok(findExclusion("config/inventoryprofilesnext/sweetcraft.datho.st/villager-trading-config-v2.json"));
    assert.ok(findExclusion("config/inventoryprofilesnext/integrationHints/exampleIntegrationHints.json"));
    assert.equal(
      c.configs.find(cf => cf.path === "config/inventoryprofilesnext/integrationHints/exampleIntegrationHints.json")
        ?.policy,
      "EXCLUDED"
    );
  });

  it("DistantHorizons config excluded despite FINAL CLEAN residue", async () => {
    assert.ok(findExclusion("config/DistantHorizons.toml"));
    const c = await readCatalog(CATALOG);
    const dh = c.configs.find(cf => cf.path === "config/DistantHorizons.toml");
    assert.ok(dh);
    assert.equal(dh!.policy, "EXCLUDED");
  });

  it("FTB quest chapter data server-only in manifests", async () => {
    const c = await readCatalog(CATALOG);
    const quest = c.configs.find(cf => cf.path === "config/ftbquests/quests/data.json5");
    assert.ok(quest, "FTB quest data present in classified catalogue");
    assert.equal(quest!.target, "SERVER");
    assert.equal(quest!.policy, "SERVER_FORCE");

    const client = buildClientManifest(c, "0.0.0-sync04-dry", { generatedAt: "fixed" });
    const server = buildServerManifest(c, "0.0.0-sync04-dry", { generatedAt: "fixed" });
    assert.ok(!client.configs.some(cf => cf.path.startsWith("config/ftbquests/quests/")));
    assert.ok(server.configs.some(cf => cf.path.startsWith("config/ftbquests/quests/")));
  });

  it("JEI never_overwrite preserved", async () => {
    const c = await readCatalog(CATALOG);
    const jei = c.configs.find(cf => cf.path.startsWith("config/jei/"));
    assert.ok(jei);
    assert.equal(jei!.policy, "CLIENT_PRESERVE");
    assert.equal(applyModeForPolicy(jei!.policy), "never_overwrite");
  });

  it("JEI per-server world runtime paths excluded from managed catalogue", async () => {
    const paths = [
      "config/jei/world/server/Sweet Room (vortex_dathost_net 17118)/lookupHistory.json",
      "config/jei/world/server/SweetCraft (sweetcraft_datho_st)/bookmarks.json",
      "config/jei/world/server/SweetCraft (sweetcraft_datho_st)/lookupHistory.json"
    ] as const;
    for (const p of paths) {
      assert.ok(findExclusion(p), `expected exclusion: ${p}`);
    }
    const c = await readCatalog(CATALOG);
    for (const p of paths) {
      const row = c.configs.find(cf => cf.path === p);
      assert.ok(row, p);
      assert.equal(row!.policy, "EXCLUDED");
    }
    const client = buildClientManifest(c, "0.0.0-sync04-dry", { generatedAt: "fixed" });
    assert.ok(!client.configs.some(cf => cf.path.startsWith("config/jei/world/")));
  });

  it("iris.properties if_missing", async () => {
    const c = await readCatalog(CATALOG);
    const iris = c.configs.find(cf => cf.path === "config/iris.properties");
    assert.ok(iris);
    assert.equal(iris!.policy, "CLIENT_DEFAULT");
    assert.equal(applyModeForPolicy(iris!.policy), "if_missing");
  });

  it("removed-mod config paths excluded from managed catalogue", async () => {
    const c = await readCatalog(CATALOG);
    const managed = new Set(c.configs.filter(cf => cf.policy !== "EXCLUDED").map(cf => cf.path));
    for (const p of [
      "config/bettercombat/fallback_compatibility.json",
      "config/uselessreptile.json5",
      "config/yacl.json5",
      "config/DistantHorizons.toml"
    ]) {
      assert.ok(!managed.has(p), `obsolete config still managed: ${p}`);
    }
  });
});

describe("SYNC-04 resource packs", () => {
  it("SweetCraft-FR autoEnable true; Faithful managed autoEnable false", () => {
    const raw = JSON.parse(readFileSync(RESOURCE_PACKS, "utf8")) as ResourcePackConfigFile;
    const fr = raw.resourcePacks.find(rp => rp.id === "sweetcraft-fr");
    const faithful = raw.resourcePacks.find(rp => rp.id === "faithful-64x-r13");
    assert.ok(fr);
    assert.equal(fr!.autoEnable, true);
    assert.ok(faithful);
    assert.equal(faithful!.autoEnable, false);
    assert.equal(faithful!.targetPath, "resourcepacks/Faithful 64x - Release 13.zip");
  });
});

describe("SYNC-04 dry manifest guard", () => {
  it("classifyConfigs excludes runtime residue from client manifest", async () => {
    const c = await readCatalog(CATALOG);
    const { catalog: classified } = classifyConfigs(c);
    const client = buildClientManifest(classified, "0.0.0-sync04-dry", { generatedAt: "fixed" });
    assert.ok(!client.configs.some(cf => cf.path === "config/DistantHorizons.toml"));
    assert.ok(
      !client.configs.some(cf =>
        cf.path.startsWith("config/inventoryprofilesnext/sweetcraft.datho.st/")
      )
    );
  });
});
