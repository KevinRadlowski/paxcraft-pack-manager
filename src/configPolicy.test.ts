import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyConfigs, ownerFor } from "./configPolicy.js";
import {
  CONFIG_POLICY_ALIASES,
  KNOWN_NON_MOD,
  findExclusion,
  findPolicyOverride,
  matchGlob,
  resolveConfigTarget,
  tokens,
  stripConfigExt
} from "./configPolicyRules.js";
import { applyModeForPolicy, buildClientManifest, buildServerManifest } from "./manifest.js";
import { releaseReady, validate } from "./validate.js";
import type { Catalog, ConfigRecord, ModRecord } from "./types.js";

function mod(partial: Partial<ModRecord> & Pick<ModRecord, "mod_id" | "side_class">): ModRecord {
  return {
    jar: `${partial.mod_id}.jar`,
    name: partial.mod_id,
    version: "1",
    size_bytes: 1,
    sha256: "a".repeat(64),
    install_client: partial.side_class !== "SERVER_ONLY",
    install_server: partial.side_class !== "CLIENT_ONLY",
    distribution_policy: "UPSTREAM_PREFERRED",
    ...partial
  };
}

function cfg(partial: Partial<ConfigRecord> & Pick<ConfigRecord, "path" | "policy">): ConfigRecord {
  return {
    size_bytes: 1,
    sha256: "b".repeat(64),
    owner_mod_id: null,
    ...partial
  };
}

function catalog(mods: ModRecord[], configs: ConfigRecord[]): Catalog {
  return {
    schemaVersion: 1,
    generatedFor: { product: "SweetCraft", minecraft: "26.1.2", fabricLoader: "0.19.3", server: "test" },
    mods,
    configs
  };
}

describe("ownerFor aliases & extensions", () => {
  const mods = [
    mod({ mod_id: "betterfortresses", side_class: "SERVER_ONLY" }),
    mod({ mod_id: "cardinal-components", side_class: "BOTH_REQUIRED" }),
    mod({ mod_id: "trinkets_updated", side_class: "BOTH_REQUIRED" }),
    mod({ mod_id: "lootr", side_class: "BOTH_REQUIRED" }),
    mod({ mod_id: "compasstomap", side_class: "BOTH_REQUIRED" }),
    mod({ mod_id: "cristellib", side_class: "SERVER_ONLY" }),
    mod({ mod_id: "entityculling", side_class: "CLIENT_ONLY" }),
    mod({ mod_id: "alexsmobs", side_class: "BOTH_REQUIRED" }),
    mod({ mod_id: "yet_another_config_lib_v3", side_class: "CLIENT_ONLY" })
  ];

  it("maps betterfortresses-fabric-26_1.toml", () => {
    assert.equal(ownerFor("config/betterfortresses-fabric-26_1.toml", mods)?.mod_id, "betterfortresses");
  });
  it("maps cardinal-components-api.properties", () => {
    assert.equal(ownerFor("config/cardinal-components-api.properties", mods)?.mod_id, "cardinal-components");
  });
  it("maps trinkets.json → trinkets_updated", () => {
    assert.equal(ownerFor("config/trinkets.json", mods)?.mod_id, "trinkets_updated");
  });
  it("maps lootr-common.jsonc", () => {
    assert.equal(ownerFor("config/lootr-common.jsonc", mods)?.mod_id, "lootr");
  });
  it("maps compasstomap-common.toml", () => {
    assert.equal(ownerFor("config/compasstomap-common.toml", mods)?.mod_id, "compasstomap");
  });
  it("maps vanilla_structures/** → cristellib", () => {
    assert.equal(ownerFor("config/vanilla_structures/toggle_structure_config.json5", mods)?.mod_id, "cristellib");
  });
  it("maps transition.json / trender.json → entityculling", () => {
    assert.equal(ownerFor("config/transition.json", mods)?.mod_id, "entityculling");
    assert.equal(ownerFor("config/trender.json", mods)?.mod_id, "entityculling");
  });
  it("maps amc.json → alexsmobs", () => {
    assert.equal(ownerFor("config/amc.json", mods)?.mod_id, "alexsmobs");
  });
  it("strips .json .jsonc .toml .properties .json5", () => {
    assert.equal(stripConfigExt("lootr-common.jsonc"), "lootr-common");
    assert.equal(stripConfigExt("x.properties"), "x");
    assert.equal(stripConfigExt("y.toml"), "y");
    assert.equal(tokens("config/lootr-common.jsonc")[1], "lootr-common");
  });
  it("KNOWN_NON_MOD matches stem without extension", () => {
    assert.ok(KNOWN_NON_MOD.has(tokens("config/transition.json")[1].toLowerCase()));
    assert.ok(KNOWN_NON_MOD.has(tokens("config/trender.json")[1].toLowerCase()));
    assert.equal(CONFIG_POLICY_ALIASES["betterfortresses-fabric-26_1"], "betterfortresses");
  });
});

describe("glob / exact overrides", () => {
  it("matches exact override", () => {
    assert.equal(findPolicyOverride("config/amc.json")?.policy, "SERVER_FORCE");
  });
  it("matches alexsmobs glob → SERVER_FORCE", () => {
    assert.equal(findPolicyOverride("config/alexsmobs/tiger_spawns.json")?.policy, "SERVER_FORCE");
  });
  it("matches jade glob → CLIENT_PRESERVE", () => {
    assert.equal(findPolicyOverride("config/jade/jade.json")?.policy, "CLIENT_PRESERVE");
  });
  it("matches jei glob → CLIENT_PRESERVE", () => {
    assert.equal(findPolicyOverride("config/jei/blacklist.json")?.policy, "CLIENT_PRESERVE");
  });
  it("matches dynamic_difficulty → SERVER_FORCE", () => {
    assert.equal(findPolicyOverride("config/dynamic_difficulty/sync.toml")?.policy, "SERVER_FORCE");
  });
  it("matches mobchampions → SERVER_FORCE", () => {
    assert.equal(findPolicyOverride("config/mobchampions-common.toml")?.policy, "SERVER_FORCE");
  });
  it("matches r3ct_daily → SERVER_FORCE", () => {
    assert.equal(findPolicyOverride("config/r3ct_daily/r3ct_daily_quests.json")?.policy, "SERVER_FORCE");
  });
  it("matches cardinal → CLIENT_DEFAULT", () => {
    assert.equal(findPolicyOverride("config/cardinal-components-api.properties")?.policy, "CLIENT_DEFAULT");
  });
  it("matchGlob basics", () => {
    assert.equal(matchGlob("config/jade/jade.json", "config/jade/**"), true);
    assert.equal(matchGlob("config/amc.json", "config/amc.json"), true);
    assert.equal(matchGlob("config/other.json", "config/amc.json"), false);
  });
});

describe("exclusions", () => {
  it("zoomify excluded", () => assert.ok(findExclusion("config/zoomify.json")));
  it("wover/cached excluded", () => assert.ok(findExclusion("config/wover/cached.json")));
  it("mcendgame excluded", () => assert.ok(findExclusion("config/mcendgame.json")));
});

describe("config target resolution", () => {
  it("CLIENT_ONLY owner → CLIENT", () => {
    assert.equal(
      resolveConfigTarget({ path: "config/foo.json", policy: "CLIENT_DEFAULT", ownerSide: "CLIENT_ONLY" }).target,
      "CLIENT"
    );
  });
  it("SERVER_ONLY owner FORCE → SERVER", () => {
    assert.equal(
      resolveConfigTarget({ path: "config/cristellib/x.json5", policy: "SERVER_FORCE", ownerSide: "SERVER_ONLY" }).target,
      "SERVER"
    );
  });
  it("BOTH_REQUIRED FORCE without override → BOTH", () => {
    assert.equal(
      resolveConfigTarget({ path: "config/some-shared.json", policy: "SERVER_FORCE", ownerSide: "BOTH_REQUIRED" }).target,
      "BOTH"
    );
  });
  it("BOTH_INDEPENDENT FORCE → BOTH", () => {
    assert.equal(
      resolveConfigTarget({ path: "config/shared-ind.json", policy: "SERVER_FORCE", ownerSide: "BOTH_INDEPENDENT" }).target,
      "BOTH"
    );
  });
  it("alexsmobs SERVER_FORCE → BOTH", () => {
    assert.equal(
      resolveConfigTarget({ path: "config/alexsmobs/tiger_spawns.json", policy: "SERVER_FORCE", ownerSide: "BOTH_REQUIRED" }).target,
      "BOTH"
    );
  });
  it("jade CLIENT_PRESERVE → CLIENT", () => {
    assert.equal(
      resolveConfigTarget({ path: "config/jade/jade.json", policy: "CLIENT_PRESERVE", ownerSide: "CLIENT_REQUIRED_SERVER_OPTIONAL" }).target,
      "CLIENT"
    );
  });
  it("jei CLIENT_PRESERVE → CLIENT", () => {
    assert.equal(
      resolveConfigTarget({ path: "config/jei/blacklist.json", policy: "CLIENT_PRESERVE", ownerSide: "CLIENT_REQUIRED_SERVER_OPTIONAL" }).target,
      "CLIENT"
    );
  });
  it("dynamic difficulty sync FORCE → BOTH", () => {
    assert.equal(
      resolveConfigTarget({ path: "config/dynamic_difficulty/sync.toml", policy: "SERVER_FORCE", ownerSide: "BOTH_REQUIRED" }).target,
      "BOTH"
    );
  });
  it("mobchampions FORCE → BOTH", () => {
    assert.equal(
      resolveConfigTarget({ path: "config/mobchampions-common.toml", policy: "SERVER_FORCE", ownerSide: "BOTH_REQUIRED" }).target,
      "BOTH"
    );
  });
  it("luckperms path with NEVER policy → SERVER (unresolved); EXCLUDED → NONE", () => {
    const never = resolveConfigTarget({
      path: "config/luckperms/luckperms.conf",
      policy: "NEVER_CLIENT_SECRET_REVIEW",
      ownerSide: "SERVER_ONLY"
    });
    assert.equal(never.target, "SERVER");
    assert.notEqual(never.target, "CLIENT");
    assert.equal(
      resolveConfigTarget({ path: "config/luckperms/luckperms.conf", policy: "EXCLUDED", ownerSide: "SERVER_ONLY" }).target,
      "NONE"
    );
  });
  it("zoomify EXCLUDED → NONE", () => {
    assert.equal(
      resolveConfigTarget({ path: "config/zoomify.json", policy: "EXCLUDED", ownerSide: null }).target,
      "NONE"
    );
  });
});

describe("classifyConfigs integration", () => {
  const mods = [
    mod({ mod_id: "alexsmobs", side_class: "BOTH_REQUIRED" }),
    mod({ mod_id: "jade", side_class: "CLIENT_REQUIRED_SERVER_OPTIONAL" }),
    mod({ mod_id: "sodium", side_class: "CLIENT_ONLY" }),
    mod({ mod_id: "cristellib", side_class: "SERVER_ONLY" }),
    mod({ mod_id: "entityculling", side_class: "CLIENT_ONLY" }),
    mod({ mod_id: "lithium", side_class: "BOTH_INDEPENDENT" })
  ];

  it("applies family policies, targets and exclusions", () => {
    const input = catalog(mods, [
      cfg({ path: "config/alexsmobs/tiger_spawns.json", policy: "COMMON_FORCE_REVIEW" }),
      cfg({ path: "config/jade/jade.json", policy: "COMMON_FORCE_REVIEW" }),
      cfg({ path: "config/jei/blacklist.json", policy: "COMMON_FORCE_REVIEW" }),
      cfg({ path: "config/cardinal-components-api.properties", policy: "COMMON_FORCE_REVIEW" }),
      cfg({ path: "config/zoomify.json", policy: "COMMON_FORCE_REVIEW" }),
      cfg({ path: "config/wover/cached.json", policy: "COMMON_FORCE_REVIEW" }),
      cfg({ path: "config/sodium-options.json", policy: "CLIENT_DEFAULT_PRESERVE" }),
      cfg({ path: "config/transition.json", policy: "COMMON_FORCE_REVIEW" }),
      cfg({ path: "config/lithium.properties", policy: "COMMON_FORCE_REVIEW" })
    ]);
    const { catalog: out } = classifyConfigs(input);
    const byPath = new Map(out.configs.map(c => [c.path, c]));
    assert.equal(byPath.get("config/alexsmobs/tiger_spawns.json")!.policy, "SERVER_FORCE");
    assert.equal(byPath.get("config/alexsmobs/tiger_spawns.json")!.target, "BOTH");
    assert.equal(byPath.get("config/jade/jade.json")!.policy, "CLIENT_PRESERVE");
    assert.equal(byPath.get("config/jade/jade.json")!.target, "CLIENT");
    assert.equal(byPath.get("config/jei/blacklist.json")!.target, "CLIENT");
    assert.equal(byPath.get("config/cardinal-components-api.properties")!.target, "CLIENT");
    assert.equal(byPath.get("config/zoomify.json")!.policy, "EXCLUDED");
    assert.equal(byPath.get("config/zoomify.json")!.target, "NONE");
    assert.equal(byPath.get("config/lithium.properties")!.policy, "CLIENT_DEFAULT");
    assert.equal(byPath.get("config/lithium.properties")!.target, "CLIENT");
  });
});

describe("manifests policy×target decoupling", () => {
  const mods = [
    mod({ mod_id: "alexsmobs", side_class: "BOTH_REQUIRED" }),
    mod({ mod_id: "jade", side_class: "CLIENT_REQUIRED_SERVER_OPTIONAL" }),
    mod({ mod_id: "cristellib", side_class: "SERVER_ONLY" })
  ];

  it("apply independent of target", () => {
    assert.equal(applyModeForPolicy("SERVER_FORCE"), "force");
    assert.equal(applyModeForPolicy("CLIENT_DEFAULT"), "if_missing");
    assert.equal(applyModeForPolicy("CLIENT_PRESERVE"), "never_overwrite");
  });

  it("BOTH FORCE appears client + server with apply=force", () => {
    const classified = classifyConfigs(catalog(mods, [
      cfg({ path: "config/alexsmobs/tiger_spawns.json", policy: "SERVER_FORCE", owner_mod_id: "alexsmobs" })
    ])).catalog;
    const client = buildClientManifest(classified, "t");
    const server = buildServerManifest(classified, "t");
    const ce = client.configs.find((x: { path: string }) => x.path.includes("tiger"));
    const se = server.configs.find((x: { path: string }) => x.path.includes("tiger"));
    assert.ok(ce);
    assert.ok(se);
    assert.equal(ce.policy, "SERVER_FORCE");
    assert.equal(ce.apply, "force");
    assert.equal(ce.target, "BOTH");
    assert.equal(se.apply, "force");
    assert.equal(se.target, "BOTH");
  });

  it("CLIENT only on client", () => {
    const classified = classifyConfigs(catalog(mods, [
      cfg({ path: "config/jade/jade.json", policy: "CLIENT_PRESERVE", owner_mod_id: "jade" })
    ])).catalog;
    const client = buildClientManifest(classified, "t");
    const server = buildServerManifest(classified, "t");
    assert.ok(client.configs.some((x: { path: string }) => x.path.includes("jade")));
    assert.ok(!server.configs.some((x: { path: string }) => x.path.includes("jade")));
  });

  it("SERVER only on server", () => {
    const classified = classifyConfigs(catalog(mods, [
      cfg({ path: "config/cristellib/auto_config_settings.json5", policy: "SERVER_FORCE", owner_mod_id: "cristellib" })
    ])).catalog;
    const client = buildClientManifest(classified, "t");
    const server = buildServerManifest(classified, "t");
    assert.ok(!client.configs.some((x: { path: string }) => x.path.includes("cristellib")));
    assert.ok(server.configs.some((x: { path: string }) => x.path.includes("cristellib")));
  });

  it("NONE nowhere", () => {
    const classified = classifyConfigs(catalog(mods, [
      cfg({ path: "config/zoomify.json", policy: "COMMON_FORCE_REVIEW" })
    ])).catalog;
    const client = buildClientManifest(classified, "t");
    const server = buildServerManifest(classified, "t");
    assert.ok(!client.configs.some((x: { path: string }) => x.path.includes("zoomify")));
    assert.ok(!server.configs.some((x: { path: string }) => x.path.includes("zoomify")));
  });

  it("NEVER unresolved blocks RELEASE_READY and stays out of manifests", () => {
    const c = catalog(mods, [
      cfg({
        path: "config/unresolved-secret.conf",
        policy: "NEVER_CLIENT_SECRET_REVIEW",
        target: "SERVER",
        sensitive_review: true
      })
    ]);
    const findings = validate(c);
    assert.ok(findings.some(x => x.code === "SENSITIVE_CONFIG_UNRESOLVED" && x.severity === "ERROR"));
    assert.equal(releaseReady(c).ready, false);
    const client = buildClientManifest(c, "t");
    const server = buildServerManifest(c, "t");
    assert.ok(!client.configs.some((x: { path: string }) => x.path.includes("unresolved-secret")));
    assert.ok(!server.configs.some((x: { path: string }) => x.path.includes("unresolved-secret")));
  });

  it("CLIENT_DEFAULT / CLIENT_PRESERVE require target CLIENT", () => {
    const badDefault = catalog(mods, [
      cfg({ path: "config/bad-default.json", policy: "CLIENT_DEFAULT", target: "BOTH" })
    ]);
    const badPreserve = catalog(mods, [
      cfg({ path: "config/bad-preserve.json", policy: "CLIENT_PRESERVE", target: "SERVER" })
    ]);
    assert.ok(validate(badDefault).some(x => x.code === "CONFIG_TARGET_INCOHERENT"));
    assert.ok(validate(badPreserve).some(x => x.code === "CONFIG_TARGET_INCOHERENT"));
  });

  it("manifest refuses REVIEW policies (defense in depth)", () => {
    const c = catalog(mods, [
      cfg({ path: "config/e.json", policy: "COMMON_FORCE_REVIEW", target: "BOTH" }),
      cfg({ path: "config/legacy.json", policy: "CLIENT_DEFAULT_PRESERVE", target: "CLIENT" })
    ]);
    const client = buildClientManifest(c, "t");
    const server = buildServerManifest(c, "t");
    assert.equal(client.configs.length, 0);
    assert.equal(server.configs.length, 0);
  });

  it("missing target throws explicit migration error", () => {
    const c = catalog(mods, [cfg({ path: "config/x.json", policy: "CLIENT_DEFAULT" })]);
    assert.throws(() => buildClientManifest(c, "t"), /pack:configs|classify-configs/);
  });

  it("REVIEW still blocks release", () => {
    const c = catalog(mods, [
      cfg({ path: "config/e.json", policy: "COMMON_FORCE_REVIEW", target: "BOTH" })
    ]);
    const findings = validate(c);
    assert.ok(findings.some(x => x.code === "CONFIG_POLICY_REVIEW" && x.severity === "ERROR"));
    assert.equal(releaseReady(c).ready, false);
  });

  it("incoherent EXCLUDED+CLIENT is ERROR", () => {
    const c = catalog(mods, [
      cfg({ path: "config/bad.json", policy: "EXCLUDED", target: "CLIENT" })
    ]);
    assert.ok(validate(c).some(x => x.code === "CONFIG_TARGET_INCOHERENT"));
  });
});

describe("PHASE 0.6.2 sensitive resolutions", () => {
  const mods = [
    mod({ mod_id: "luckperms", side_class: "SERVER_ONLY" }),
    mod({ mod_id: "resourcefulconfig", side_class: "BOTH_REQUIRED" })
  ];

  it("luckperms.conf → EXCLUDED / NONE", () => {
    const { catalog: out } = classifyConfigs(catalog(mods, [
      cfg({ path: "config/luckperms/luckperms.conf", policy: "NEVER_CLIENT_SECRET_REVIEW", sensitive_review: true })
    ]));
    const cf = out.configs[0];
    assert.equal(cf.policy, "EXCLUDED");
    assert.equal(cf.target, "NONE");
    assert.equal(cf.sensitive_review, false);
  });

  it("luckperms translations repository → EXCLUDED / NONE", () => {
    const { catalog: out } = classifyConfigs(catalog(mods, [
      cfg({
        path: "config/luckperms/translations/repository/fr_FR.properties",
        policy: "NEVER_CLIENT_SECRET_REVIEW",
        sensitive_review: true
      }),
      cfg({
        path: "config/luckperms/translations/repository/status.json",
        policy: "NEVER_CLIENT_SECRET_REVIEW",
        sensitive_review: true
      })
    ]));
    for (const cf of out.configs) {
      assert.equal(cf.policy, "EXCLUDED");
      assert.equal(cf.target, "NONE");
    }
  });

  it("resourceful-config-web.json → EXCLUDED / NONE", () => {
    const { catalog: out } = classifyConfigs(catalog(mods, [
      cfg({ path: "config/resourceful-config-web.json", policy: "NEVER_CLIENT_SECRET_REVIEW", sensitive_review: true })
    ]));
    assert.equal(out.configs[0].policy, "EXCLUDED");
    assert.equal(out.configs[0].target, "NONE");
  });

  it("resolved exclusions do not block RELEASE_READY", () => {
    const { catalog: out } = classifyConfigs(catalog(mods, [
      cfg({ path: "config/luckperms/luckperms.conf", policy: "NEVER_CLIENT_SECRET_REVIEW", sensitive_review: true }),
      cfg({ path: "config/resourceful-config-web.json", policy: "NEVER_CLIENT_SECRET_REVIEW", sensitive_review: true }),
      cfg({ path: "config/luckperms/translations/repository/en_PT.properties", policy: "NEVER_CLIENT_SECRET_REVIEW", sensitive_review: true })
    ]));
    // Add a valid force config so catalogue isn't empty of shippable items
    out.mods.push(mod({ mod_id: "cristellib", side_class: "SERVER_ONLY" }));
    out.configs.push(cfg({
      path: "config/cristellib/auto_config_settings.json5",
      policy: "SERVER_FORCE",
      target: "SERVER",
      owner_mod_id: "cristellib"
    }));
    assert.equal(out.configs.filter(x => x.policy === "NEVER_CLIENT_SECRET_REVIEW").length, 0);
    const findings = validate(out);
    assert.ok(!findings.some(x => x.severity === "ERROR" && x.code.startsWith("SENSITIVE")));
    assert.ok(findings.some(x => x.code === "CONFIG_EXCLUDED" && x.severity === "WARN"));
  });

  it("classifyConfigs returns mapped as number", () => {
    const r = classifyConfigs(catalog(mods, [
      cfg({ path: "config/luckperms/luckperms.conf", policy: "NEVER_CLIENT_SECRET_REVIEW", sensitive_review: true })
    ]));
    assert.equal(typeof r.mapped, "number");
  });
});
