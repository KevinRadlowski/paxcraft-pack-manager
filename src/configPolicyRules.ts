import type { ConfigPolicy, ConfigTarget, SideClass } from "./types.js";

/** Legacy policy from phase 0 / v0.3–v0.4 catalogues. */
export const LEGACY_CLIENT_DEFAULT_PRESERVE = "CLIENT_DEFAULT_PRESERVE";

/**
 * `SERVER_FORCE` = SweetCraft imposes the file contents (apply=force).
 * Distribution is decided solely by `ConfigTarget`, not by this policy name.
 */

export const CONFIG_POLICY_ALIASES: Record<string, string> = {
  "betterdeserttemples-fabric-26_1": "betterdeserttemples",
  "betterdungeons-fabric-26_1": "betterdungeons",
  "betterfortresses-fabric-26_1": "betterfortresses",
  "betterjungletemples-fabric-26_1": "betterjungletemples",
  "bettermineshafts-fabric-26_1": "bettermineshafts",
  "betteroceanmonuments-fabric-26_1": "betteroceanmonuments",
  "betterstrongholds-fabric-1_21": "betterstrongholds",
  "betterwitchhuts-fabric-26_1": "betterwitchhuts",
  "cardinal-components-api": "cardinal-components",
  "carryon-common": "carryon",
  "comforts-common": "comforts",
  "compasstomap-common": "compasstomap",
  "distanthorizons": "distanthorizons",
  "fallingleaves2": "fallingleaves",
  "farmersdelight-common": "farmersdelight",
  "ferritecore.mixin": "ferritecore",
  "iris-excluded": "iris",
  "lootr-common": "lootr",
  "mobchampions-common": "mobchampions",
  "sodium-fingerprint": "sodium",
  "sodium-mixins": "sodium",
  "towns_and_towers": "t_and_t",
  "travelersbackpack-common": "travelersbackpack",
  "uselessreptile_mob_attributes": "uselessreptile",
  "trinkets": "trinkets_updated",
  "transition": "entityculling",
  "trender": "entityculling",
  "vanilla_structures": "cristellib",
  "yacl": "yet_another_config_lib_v3",
  "amc": "alexsmobs",
  diagonalblocks: "diagonalfences",
  items_displayed_config: "items_displayed",
  mousetweaks: "mousetweaks",
  polymer: "polymer-bundled",
  "sodium-options": "sodium",
  "sodium-extra-options": "sodium-extra"
};

/**
 * Stems that are known non-mod root files / libraries bundled elsewhere.
 * Matching uses extension-stripped stems (see tokens()).
 */
export const KNOWN_NON_MOD = new Set(["transition", "trender"]);

export interface PolicyOverride {
  /** Exact path or glob (`*` = segment, `**` = any depth). Paths are under `config/`. */
  pattern: string;
  policy: ConfigPolicy;
  reason: string;
}

/**
 * Central policy overrides (PHASE 0.5 audit → 0.6).
 * First match wins after sorting: exact paths, then longer patterns.
 */
export const CONFIG_POLICY_OVERRIDES: PolicyOverride[] = [
  // ——— SERVER_FORCE families ———
  { pattern: "config/alexsmobs/**", policy: "SERVER_FORCE", reason: "Alex's Mobs spawn/biome gameplay" },
  { pattern: "config/amc.json", policy: "SERVER_FORCE", reason: "Alex's Mobs Continued global gameplay/spawns" },
  { pattern: "config/artifacts/**", policy: "SERVER_FORCE", reason: "Artifacts loot/campsite gameplay" },
  { pattern: "config/betterend/**", policy: "SERVER_FORCE", reason: "Better End worldgen/portals" },
  { pattern: "config/betternether/**", policy: "SERVER_FORCE", reason: "Better Nether worldgen/gamerules" },
  { pattern: "config/r3ct_daily/**", policy: "SERVER_FORCE", reason: "Daily quests and rewards" },
  { pattern: "config/xbasecasino/video_poker.json", policy: "SERVER_FORCE", reason: "XBASE Casino gameplay baseline" },
  { pattern: "config/ftbquests/quests/**", policy: "SERVER_FORCE", reason: "FTB Quests definitions — server authority" },
  { pattern: "config/vanilla_structures/**", policy: "SERVER_FORCE", reason: "Cristel Lib vanilla structure placement/toggle" },
  { pattern: "config/dynamic_difficulty/**", policy: "SERVER_FORCE", reason: "Difficulty scaling" },
  { pattern: "config/mobchampions-common.toml", policy: "SERVER_FORCE", reason: "Champion spawn weights/whitelist" },
  { pattern: "config/carryon-common.json", policy: "SERVER_FORCE", reason: "Carry On pickup/balance" },
  { pattern: "config/comforts-common.toml", policy: "SERVER_FORCE", reason: "Comforts recipes/features" },
  { pattern: "config/farmersdelight-common.json", policy: "SERVER_FORCE", reason: "Farmer's Delight common gameplay" },
  { pattern: "config/travelersbackpack-common.toml", policy: "SERVER_FORCE", reason: "Traveler's Backpack loot/trades" },
  { pattern: "config/ascensioncores.properties", policy: "SERVER_FORCE", reason: "Ascension progression costs" },
  { pattern: "config/betterarcheology.jsonc", policy: "SERVER_FORCE", reason: "Better Archeology gameplay toggles" },
  { pattern: "config/friendsandfoes.json", policy: "SERVER_FORCE", reason: "Friends&Foes spawns/structures" },
  { pattern: "config/fallingtree.json", policy: "SERVER_FORCE", reason: "FallingTree break mode/limits" },
  { pattern: "config/terrablender.toml", policy: "SERVER_FORCE", reason: "TerraBlender region sizes" },
  { pattern: "config/yungscavebiomes-fabric-1_20_1.toml", policy: "SERVER_FORCE", reason: "YUNG cave biomes / sandstorms" },
  { pattern: "config/lootr-common.jsonc", policy: "SERVER_FORCE", reason: "Lootr conversion/loot rules" },
  { pattern: "config/betterfortresses-fabric-26_1.toml", policy: "SERVER_FORCE", reason: "Disable vanilla fortresses" },
  { pattern: "config/fabric_simple_generator.json", policy: "SERVER_FORCE", reason: "Generator energy capacities" },
  {
    pattern: "config/jei-server.properties",
    policy: "SERVER_FORCE",
    reason: "JEI server leaf — must not use CLIENT_DEFAULT with target SERVER"
  },

  // Mixed client+gameplay → whole-file SERVER_FORCE (product rule)
  { pattern: "config/explorerscompass.json", policy: "SERVER_FORCE", reason: "Mixed: teleport/XP/blacklist + client HUD" },
  { pattern: "config/naturescompass.json", policy: "SERVER_FORCE", reason: "Mixed: XP/blacklist + client HUD" },
  { pattern: "config/waystones-common.toml", policy: "SERVER_FORCE", reason: "Mixed: map integrations + client overlay" },
  { pattern: "config/refinedstorage.toml", policy: "SERVER_FORCE", reason: "Mixed: UI prefs + energy gameplay" },
  { pattern: "config/compasstomap-common.toml", policy: "SERVER_FORCE", reason: "Mixed: feature switches + appearance" },
  { pattern: "config/creativecore.json", policy: "SERVER_FORCE", reason: "CreativeCore usergroups pack integrity" },

  // ——— CLIENT_PRESERVE ———
  { pattern: "config/inventoryprofilesnext/inventoryprofiles.json", policy: "CLIENT_DEFAULT", reason: "IPN global defaults seed — preserve existing player prefs on update" },
  { pattern: "config/iris.properties", policy: "CLIENT_DEFAULT", reason: "Iris shader prefs — seed if missing only" },
  { pattern: "config/jade/**", policy: "CLIENT_PRESERVE", reason: "Jade HUD positions/themes/hide lists" },
  { pattern: "config/jei/**", policy: "CLIENT_PRESERVE", reason: "JEI sort/blacklist/colors user prefs" },
  { pattern: "config/appleskin.json5", policy: "CLIENT_PRESERVE", reason: "AppleSkin HUD overlays" },
  { pattern: "config/yacl.json5", policy: "CLIENT_PRESERVE", reason: "YACL library UI prefs" },
  { pattern: "config/transition.json", policy: "CLIENT_PRESERVE", reason: "EntityCulling JiJ transition prefs/consent" },
  { pattern: "config/trender.json", policy: "CLIENT_PRESERVE", reason: "EntityCulling JiJ render style" },
  {
    pattern: "config/trinkets.json",
    policy: "CLIENT_PRESERVE",
    reason: "Trinkets UI prefs; gameplay.equipment_hiding/cosmetic_slots are client visual only (false defaults) — not pack-critical"
  },

  // ——— CLIENT_DEFAULT ———
  { pattern: "config/cardinal-components-api.properties", policy: "CLIENT_DEFAULT", reason: "Deserialization warning logs only" },
  { pattern: "config/lithium.properties", policy: "CLIENT_DEFAULT", reason: "Empty Lithium defaults; no gameplay overrides" },
  { pattern: "config/ferritecore.mixin.properties", policy: "CLIENT_DEFAULT", reason: "Memory mixins only; not gameplay" },
  { pattern: "config/bclib/main.json", policy: "CLIENT_DEFAULT", reason: "Library patch flag + version stamps; not spawn/loot" },
  { pattern: "config/wover/main.json", policy: "CLIENT_DEFAULT", reason: "Verbose logging only" },
  { pattern: "config/forgeconfigapiport.toml", policy: "CLIENT_DEFAULT", reason: "Config watcher/dev logging; not gameplay" },
  { pattern: "config/lootr-client.jsonc", policy: "CLIENT_PRESERVE", reason: "Lootr client UI/prefs" }
];

export interface ConfigExclusion {
  pattern: string;
  reason: string;
}

/** Paths removed from pack manifests (kept in catalogue as EXCLUDED for audit). */
export const CONFIG_EXCLUSIONS: ConfigExclusion[] = [
  { pattern: "config/zoomify.json", reason: "Zoomify mod not installed in SweetCraft pack" },
  { pattern: "config/wover/cached.json", reason: "Runtime version-check cache, regenerated locally" },
  { pattern: "config/mcendgame.json", reason: "Analytics-only (sendAnalytics); do not distribute" },
  {
    pattern: "config/luckperms/luckperms.conf",
    reason: "Instance-local LuckPerms config with DB/Redis/messaging credential slots — never distribute via launcher"
  },
  {
    pattern: "config/luckperms/translations/repository/**",
    reason: "LuckPerms auto-downloaded translation cache/generated repository — not pack-authored"
  },
  {
    pattern: "config/resourceful-config-web.json",
    reason: "Resourceful Config web UI: admin port + password validator — local/secret, never distribute"
  },
  {
    pattern: "config/grieflogger/**",
    reason: "GriefLogger server DB/credentials and instance paths — never distribute via launcher"
  },
  {
    pattern: "config/xbasecasino/economy.json",
    reason: "Casino economy / balances — server economic state, not a distributable client default"
  },
  {
    pattern: "config/betternether/world.json",
    reason: "Better Nether per-world / generated world data — runtime, not pack-authored defaults"
  },
  {
    pattern: "config/minetracer/database.db",
    reason: "MineTracer SQLite database — runtime/personal server data, never distribute"
  },
  {
    pattern: "config/minetracer/**/*.db",
    reason: "MineTracer DB artefacts — runtime, never distribute"
  },
  {
    pattern: "config/minetracer/logs_backup_*.json",
    reason: "MineTracer log backups — runtime, never distribute"
  },
  {
    pattern: "config/luckperms.conf",
    reason: "LuckPerms root conf (if present) — credentials/instance-local"
  },
  {
    pattern: "config/ledger.toml",
    reason: "Ledger mod absent from CLEAN — leftover config, do not distribute"
  },
  {
    pattern: "config/lingua_bib.json",
    reason: "Lingua / bib helper absent from CLEAN — leftover config"
  },
  {
    pattern: "config/whitenoise-client.toml",
    reason: "White Noise mod absent from CLEAN — leftover client config"
  },
  {
    pattern: "config/DistantHorizons.toml",
    reason: "Distant Horizons mod removed — stale residue in FINAL CLEAN, do not distribute"
  },
  { pattern: "config/bettercombat/**", reason: "Better Combat mod removed from FINAL CLEAN baseline" },
  { pattern: "config/uselessreptile*.json5", reason: "Useless Reptile mod removed from FINAL CLEAN baseline" },
  { pattern: "config/visualworkbench*.toml", reason: "Visual Workbench mod removed from FINAL CLEAN baseline" },
  { pattern: "config/armoredfoes*.toml", reason: "Armored Foes mod removed from FINAL CLEAN baseline" },
  { pattern: "config/yacl.json5", reason: "YACL mod removed from FINAL CLEAN baseline" },
  { pattern: "config/litematica/**", reason: "Litematica local creative state — not pack baseline" },
  {
    pattern: "config/inventoryprofilesnext/*/villager-trading-config-v2.json",
    reason: "IPN per-server trading bookmarks — runtime user data"
  },
  {
    pattern: "config/inventoryprofilesnext/*/prev-villager-trading-config-v2.json",
    reason: "IPN trading bookmark backups — runtime user data"
  },
  {
    pattern: "config/inventoryprofilesnext/Nouveau monde/**",
    reason: "IPN per-world profile data — runtime user data"
  },
  {
    pattern: "config/inventoryprofilesnext/sweetcraft.datho.st/**",
    reason: "IPN per-server profile data — runtime user data"
  },
  {
    pattern: "config/inventoryprofilesnext/localhost/**",
    reason: "IPN localhost profile data — runtime user data"
  },
  {
    pattern: "config/inventoryprofilesnext/vortex.dathost.net&17118/**",
    reason: "IPN legacy server profile data — runtime user data"
  },
  {
    pattern: "config/inventoryprofilesnext/integrationHints/**",
    reason: "IPN integration hints — runtime user data, not pack baseline"
  },
  {
    pattern: "config/jei/world/**",
    reason: "JEI per-world/per-server bookmarks and lookup history — runtime user data, not pack baseline"
  },
  {
    pattern: "config/mobchampions-common.toml.bak",
    reason: "Editor backup residue — not pack baseline"
  },
  {
    pattern: "config/shulkerboxtooltip_mp_ender_chest_cache.dat",
    reason: "ShulkerBoxTooltip runtime MP cache — not pack baseline"
  },
  { pattern: "config/universal-graves/**", reason: "Universal Graves replaced by Fallen — obsolete config residue" }
];

const CONFIG_EXT = /\.(json|json5|jsonc|toml|conf|properties|yaml|yml|cfg)$/i;

export function stripConfigExt(name: string): string {
  return name.replace(CONFIG_EXT, "");
}

export function norm(s: string): string {
  return stripConfigExt(s).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function tokens(path: string): string[] {
  const rel = path.replace(/^config\//i, "");
  const first = rel.split("/")[0] ?? rel;
  const stem = stripConfigExt(first);
  return [
    first,
    stem,
    stem.replace(/-(common|client|server)$/i, ""),
    stem.replace(/_(common|client|server)$/i, "")
  ];
}

/** Glob match: `*` = one path segment chars, `**` = any including `/`. */
export function matchGlob(path: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\0")
    .replace(/\*/g, "[^/]*")
    .replace(/\0/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(path);
}

function patternSpecificity(pattern: string): number {
  if (!pattern.includes("*")) return 1_000_000 + pattern.length;
  return pattern.replace(/\*\*/g, "").replace(/\*/g, "").length;
}

export function findPolicyOverride(path: string): PolicyOverride | undefined {
  const hits = CONFIG_POLICY_OVERRIDES
    .filter(o => matchGlob(path, o.pattern))
    .sort((a, b) => patternSpecificity(b.pattern) - patternSpecificity(a.pattern));
  return hits[0];
}

export function findExclusion(path: string): ConfigExclusion | undefined {
  return CONFIG_EXCLUSIONS.find(e => matchGlob(path, e.pattern));
}

export interface TargetOverride {
  pattern: string;
  target: ConfigTarget;
  reason: string;
}

/**
 * Explicit distribution targets (PHASE 0.6.1).
 * Wins over automatic side/path heuristics.
 */
export const CONFIG_TARGET_OVERRIDES: TargetOverride[] = [
  // Worldgen / structure libs — dedicated server authority
  { pattern: "config/cristellib/**", target: "SERVER", reason: "Cristel Lib structure placement — server worldgen" },
  { pattern: "config/vanilla_structures/**", target: "SERVER", reason: "Vanilla structure placement via Cristel Lib — server" },
  { pattern: "config/towns_and_towers/**", target: "SERVER", reason: "Towns & Towers structure toggles — server" },
  { pattern: "config/terralith.json", target: "SERVER", reason: "Terralith server worldgen" },
  { pattern: "config/lithostitched.json", target: "SERVER", reason: "Lithostitched server worldgen" },
  { pattern: "config/flan/**", target: "SERVER", reason: "Flan claims — server" },
  { pattern: "config/codxlib.json", target: "SERVER", reason: "CodxLib server utility" },

  // Shared gameplay FORCE → BOTH (explicit, audit-backed)
  { pattern: "config/alexsmobs/**", target: "BOTH", reason: "Alex's Mobs spawn/biome — BOTH_REQUIRED shared" },
  { pattern: "config/amc.json", target: "BOTH", reason: "AMC global gameplay — shared" },
  { pattern: "config/artifacts/general.toml", target: "BOTH", reason: "Artifacts gameplay — shared" },
  { pattern: "config/artifacts/items.toml", target: "BOTH", reason: "Artifacts items — shared" },
  { pattern: "config/betterend/generator.json", target: "BOTH", reason: "Better End generator — shared" },
  { pattern: "config/betterend/portals.json", target: "BOTH", reason: "Better End portals — shared" },
  { pattern: "config/betternether/default_game_rules.json", target: "BOTH", reason: "Better Nether gamerules — shared" },
  { pattern: "config/r3ct_daily/r3ct_daily_quests.json", target: "BOTH", reason: "Daily quests definitions — shared" },
  { pattern: "config/r3ct_daily/r3ct_daily_rewards.json", target: "BOTH", reason: "Daily rewards — shared" },
  { pattern: "config/dynamic_difficulty/sync.toml", target: "BOTH", reason: "Difficulty sync — client+server must match" },
  { pattern: "config/mobchampions-common.toml", target: "BOTH", reason: "Champion weights — shared common" },
  { pattern: "config/explorerscompass.json", target: "BOTH", reason: "Explorer compass mixed common+client — BOTH" },
  { pattern: "config/naturescompass.json", target: "BOTH", reason: "Nature compass mixed common+client — BOTH" },
  { pattern: "config/waystones-common.toml", target: "BOTH", reason: "Waystones mixed — BOTH" },
  { pattern: "config/refinedstorage.toml", target: "BOTH", reason: "RS energy+UI mixed — BOTH" },
  { pattern: "config/compasstomap-common.toml", target: "BOTH", reason: "Compass-to-map mixed — BOTH" },
  { pattern: "config/creativecore.json", target: "BOTH", reason: "CreativeCore usergroups — BOTH" },
  { pattern: "config/carryon-common.json", target: "BOTH", reason: "Carry On common — BOTH" },
  { pattern: "config/comforts-common.toml", target: "BOTH", reason: "Comforts common — BOTH" },
  { pattern: "config/farmersdelight-common.json", target: "BOTH", reason: "Farmer's Delight common — BOTH" },
  { pattern: "config/travelersbackpack-common.toml", target: "BOTH", reason: "Traveler's Backpack common — BOTH" },
  { pattern: "config/ascensioncores.properties", target: "BOTH", reason: "Ascension progression — BOTH" },
  { pattern: "config/betterarcheology.jsonc", target: "BOTH", reason: "Better Archeology — BOTH" },
  { pattern: "config/friendsandfoes.json", target: "BOTH", reason: "Friends&Foes spawns — BOTH" },
  { pattern: "config/fallingtree.json", target: "BOTH", reason: "FallingTree — server-authoritative but client reads" },
  { pattern: "config/terrablender.toml", target: "BOTH", reason: "TerraBlender regions — BOTH" },
  { pattern: "config/yungscavebiomes-fabric-1_20_1.toml", target: "BOTH", reason: "YUNG cave biomes — BOTH" },
  { pattern: "config/lootr-common.jsonc", target: "BOTH", reason: "Lootr common — BOTH" },
  { pattern: "config/fabric_simple_generator.json", target: "BOTH", reason: "Generator capacities — BOTH" },

  // Named client/server leaves under otherwise shared mods
  { pattern: "config/artifacts/client.toml", target: "CLIENT", reason: "Artifacts client leaf" },
  { pattern: "config/betterend/client.json", target: "CLIENT", reason: "Better End client leaf" },
  { pattern: "config/betternether/client.json", target: "CLIENT", reason: "Better Nether client leaf" },
  { pattern: "config/dynamic_difficulty/client.toml", target: "CLIENT", reason: "Dynamic Difficulty client leaf" },
  { pattern: "config/ftbquests/quests/**", target: "SERVER", reason: "FTB Quests chapter data — server-only in FINAL CLEAN" },
  { pattern: "config/ftbquests-client.json5", target: "CLIENT", reason: "FTB Quests client UI prefs" },
  { pattern: "config/polymer/**", target: "SERVER", reason: "Polymer server configs" },
  { pattern: "config/comforts-server.toml", target: "SERVER", reason: "Comforts server leaf" },
  { pattern: "config/travelersbackpack-server.toml", target: "SERVER", reason: "Traveler's Backpack server leaf" },
  { pattern: "config/r3ct_daily/r3ct_daily_server.json", target: "SERVER", reason: "R3CT daily server leaf" },
  { pattern: "config/boss_checklist/boss_checklist-server.json", target: "SERVER", reason: "Boss Checklist server leaf" },
  { pattern: "config/easyanvils-server.toml", target: "SERVER", reason: "Easy Anvils server leaf" },
  { pattern: "config/easymagic-server.toml", target: "SERVER", reason: "Easy Magic server leaf" },
  { pattern: "config/jei-server.properties", target: "SERVER", reason: "JEI server leaf" },
  { pattern: "config/journeymap-server.json", target: "SERVER", reason: "JourneyMap server leaf" }
];

export function findTargetOverride(path: string): TargetOverride | undefined {
  const hits = CONFIG_TARGET_OVERRIDES
    .filter(o => matchGlob(path, o.pattern))
    .sort((a, b) => patternSpecificity(b.pattern) - patternSpecificity(a.pattern));
  return hits[0];
}

/** Path basename/segment hints: *-client* or .../client.* → CLIENT; *-server* → SERVER. */
export function pathTargetHint(path: string): ConfigTarget | undefined {
  const lower = path.toLowerCase().replace(/\\/g, "/");
  const base = lower.split("/").pop() ?? "";
  if (/(^|\/)client\./.test(lower) || /(^|-)client\./.test(base) || /_client\./.test(base) || /-client\./.test(base)) {
    return "CLIENT";
  }
  if (/(^|\/)server\./.test(lower) || /(^|-)server\./.test(base) || /_server\./.test(base) || /-server\./.test(base)) {
    return "SERVER";
  }
  return undefined;
}

export function resolveConfigTarget(input: {
  path: string;
  policy: string;
  ownerSide?: SideClass | string | null;
}): { target: ConfigTarget; reason: string } {
  const { path, policy, ownerSide } = input;

  if (policy === "EXCLUDED") {
    return { target: "NONE", reason: "EXCLUDED → NONE" };
  }

  const override = findTargetOverride(path);
  if (override) {
    return { target: override.target, reason: override.reason };
  }

  if (policy === "NEVER_CLIENT_SECRET_REVIEW") {
    return { target: "SERVER", reason: "NEVER_CLIENT_SECRET_REVIEW → SERVER (never CLIENT)" };
  }

  if (policy === "CLIENT_DEFAULT" || policy === "CLIENT_PRESERVE") {
    return { target: "CLIENT", reason: `${policy} → CLIENT` };
  }

  const hint = pathTargetHint(path);
  if (hint) {
    return { target: hint, reason: `path hint → ${hint}` };
  }

  switch (ownerSide) {
    case "CLIENT_ONLY":
      return { target: "CLIENT", reason: `owner ${ownerSide}` };
    case "SERVER_ONLY":
      return { target: "SERVER", reason: `owner ${ownerSide}` };
    case "BOTH_REQUIRED":
    case "BOTH_INDEPENDENT":
    case "CLIENT_REQUIRED_SERVER_OPTIONAL":
    case "SERVER_REQUIRED_CLIENT_OPTIONAL":
      // Shared mods: FORCE (and residual REVIEW) default to BOTH
      return { target: "BOTH", reason: `owner ${ownerSide} → BOTH` };
    default:
      if (policy === "SERVER_FORCE") {
        return { target: "SERVER", reason: "SERVER_FORCE without owner side → conservative SERVER" };
      }
      return { target: "BOTH", reason: "unknown owner side → BOTH" };
  }
}

export const KNOWN_TARGETS = new Set<string>(["CLIENT", "SERVER", "BOTH", "NONE"]);

export function migrateLegacyPolicy(policy: string): ConfigPolicy | typeof LEGACY_CLIENT_DEFAULT_PRESERVE | string {
  if (policy === LEGACY_CLIENT_DEFAULT_PRESERVE) return LEGACY_CLIENT_DEFAULT_PRESERVE;
  return policy;
}

export const KNOWN_POLICIES = new Set<string>([
  "SERVER_FORCE",
  "CLIENT_DEFAULT",
  "CLIENT_PRESERVE",
  "COMMON_FORCE_REVIEW",
  "NEVER_CLIENT_SECRET_REVIEW",
  "EXCLUDED",
  LEGACY_CLIENT_DEFAULT_PRESERVE
]);
