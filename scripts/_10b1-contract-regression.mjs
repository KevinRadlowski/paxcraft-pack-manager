import assert from "node:assert/strict";
import { assertSafeFilesPayloadPath } from "../dist-origin/resourcePackPaths.js";
import { PathSafetyError } from "../dist-origin/paths.js";

const accept = [
  "config/foo/bar.json",
  "resourcepacks/SweetCraft-FR.zip",
  "mods/example-mod.jar",
  "world/datapacks/SweetCraft_Quest_Support/pack.mcmeta",
  "world/datapacks/SweetCraft_Quest_Support/data/sweetcraft/advancement/eat_cooked_food.json",
  "world/datapacks/SweetCraft_Quest_Support/data/sweetcraft/advancement/trade_with_villager.json",
  "world/datapacks/SweetCraft_Quest_Support/data/sweetcraft/advancement/kill_zombie.json",
  "world/datapacks/SweetCraft_Quest_Support/data/sweetcraft/advancement/mine_diamond.json",
  "world/datapacks/SweetCraft_Quest_Support/data/sweetcraft/advancement/place_crafting_table.json",
  "world/datapacks/SweetCraft_Quest_Support/data/sweetcraft/advancement/sleep_in_bed.json",
  "world/datapacks/SweetCraft_Quest_Support/data/sweetcraft/advancement/tame_wolf.json"
];

const reject = [
  "world/level.dat",
  "world/datapacks/../mods/evil.jar",
  "world/datapacks/foo/../../../etc/passwd",
  "/etc/passwd",
  "secrets/.env",
  "payload/root.json",
  "files/world/datapacks/x",
  "world/playerdata/x.dat",
  "world/datapacks",
  "world/datapacks/",
  "world/datapacks//SweetCraft_Quest_Support/pack.mcmeta"
];

for (const p of accept) {
  assertSafeFilesPayloadPath(p);
  console.log("ACCEPT", p);
}

for (const p of reject) {
  let threw = false;
  try {
    assertSafeFilesPayloadPath(p);
  } catch (e) {
    threw = e instanceof PathSafetyError || e instanceof Error;
  }
  assert.ok(threw, `expected reject: ${p}`);
  console.log("REJECT", p);
}

console.log("CONTRACT_REGRESSION_PASS");
