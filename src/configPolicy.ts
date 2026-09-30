import type { Catalog, ConfigPolicy, ConfigRecord, ConfigTarget, ModRecord } from "./types.js";
import { CATALOG_SCHEMA_VERSION } from "./types.js";
import {
  CONFIG_POLICY_ALIASES,
  KNOWN_NON_MOD,
  LEGACY_CLIENT_DEFAULT_PRESERVE,
  findExclusion,
  findPolicyOverride,
  norm,
  resolveConfigTarget,
  tokens
} from "./configPolicyRules.js";

export {
  CONFIG_POLICY_ALIASES as ALIASES,
  KNOWN_NON_MOD,
  findExclusion,
  findPolicyOverride,
  findTargetOverride,
  matchGlob,
  norm,
  pathTargetHint,
  resolveConfigTarget,
  tokens,
  stripConfigExt
} from "./configPolicyRules.js";

export function ownerFor(path: string, mods: ModRecord[]): ModRecord | undefined {
  const byId = new Map(mods.map(m => [norm(m.mod_id), m]));
  for (const t of tokens(path)) {
    const key = t.toLowerCase();
    const alias = CONFIG_POLICY_ALIASES[key];
    if (alias) {
      const m = byId.get(norm(alias));
      if (m) return m;
    }
    const exact = byId.get(norm(t));
    if (exact) return exact;
  }
  return undefined;
}

function withTarget(
  cf: ConfigRecord,
  policy: ConfigPolicy,
  owner: ModRecord | undefined,
  ownerId: string | null,
  extra: Partial<ConfigRecord> = {}
): ConfigRecord {
  const resolved = resolveConfigTarget({
    path: cf.path,
    policy,
    ownerSide: owner?.side_class ?? null
  });
  return {
    ...cf,
    ...extra,
    owner_mod_id: ownerId,
    policy,
    target: resolved.target,
    target_reason: resolved.reason
  };
}

/**
 * Classify config policies + distribution targets (v2.2 / PHASE 0.6.2).
 * Order: exclusion → keep NEVER (blocking until resolved) → policy override → migrate legacy → side auto.
 */
export function classifyConfigs(c: Catalog): {
  catalog: Catalog;
  changed: number;
  orphans: string[];
  mapped: number;
  excluded: number;
  migratedLegacy: number;
} {
  let changed = 0;
  let mapped = 0;
  let excluded = 0;
  let migratedLegacy = 0;
  const orphans: string[] = [];

  const configs: ConfigRecord[] = c.configs.map(cf => {
    const prev = cf.policy;
    let owner = cf.owner_mod_id ? c.mods.find(m => m.mod_id === cf.owner_mod_id) : undefined;
    if (!owner) owner = ownerFor(cf.path, c.mods);
    if (owner && !cf.owner_mod_id) mapped++;
    const ownerId = owner?.mod_id ?? cf.owner_mod_id ?? null;

    const exclusion = findExclusion(cf.path);
    if (exclusion) {
      excluded++;
      if (prev !== "EXCLUDED" || cf.target !== "NONE") changed++;
      return withTarget(cf, "EXCLUDED", owner, ownerId, {
        policy_reason: exclusion.reason,
        exclusion_reason: exclusion.reason,
        // Resolved by explicit exclusion — no longer an open sensitive review.
        sensitive_review: false
      });
    }

    // Unresolved sensitive / NEVER — keep until human exclusion or override removes it.
    if (prev === "NEVER_CLIENT_SECRET_REVIEW" || (cf.sensitive_review && prev !== "EXCLUDED")) {
      const next = withTarget(cf, "NEVER_CLIENT_SECRET_REVIEW", owner, ownerId, {
        policy_reason: cf.policy_reason ?? "unresolved sensitive classification — must EXCLUDE or reclassify before release",
        exclusion_reason: undefined,
        sensitive_review: true
      });
      if (cf.target !== next.target || prev !== next.policy) changed++;
      return next;
    }

    const override = findPolicyOverride(cf.path);
    if (override) {
      if (prev !== override.policy) changed++;
      const next = withTarget(cf, override.policy, owner, ownerId, {
        policy_reason: override.reason,
        exclusion_reason: undefined
      });
      if (cf.target !== next.target) changed++;
      return next;
    }

    if (prev === LEGACY_CLIENT_DEFAULT_PRESERVE) {
      migratedLegacy++;
      changed++;
      return withTarget(cf, "CLIENT_DEFAULT", owner, ownerId, {
        policy_reason: "migrated from CLIENT_DEFAULT_PRESERVE → CLIENT_DEFAULT",
        exclusion_reason: undefined
      });
    }

    let policy: ConfigPolicy | string = prev;
    let policy_reason = cf.policy_reason;

    if (policy === "COMMON_FORCE_REVIEW" && owner) {
      if (owner.side_class === "SERVER_ONLY") {
        policy = "SERVER_FORCE";
        policy_reason = `auto: owner ${owner.mod_id} is SERVER_ONLY`;
        changed++;
      } else if (owner.side_class === "CLIENT_ONLY") {
        policy = "CLIENT_DEFAULT";
        policy_reason = `auto: owner ${owner.mod_id} is CLIENT_ONLY`;
        changed++;
      } else if (
        owner.side_class === "BOTH_REQUIRED" ||
        owner.side_class === "BOTH_INDEPENDENT" ||
        owner.side_class === "INDEPENDENT" ||
        owner.side_class === "SERVER_REQUIRED_CLIENT_OPTIONAL" ||
        owner.side_class === "CLIENT_REQUIRED_SERVER_OPTIONAL"
      ) {
        // CLEAN physical presence makes many worldgen/gameplay mods BOTH_*; pack default is
        // SERVER_FORCE (explicit CLIENT_PRESERVE / CLIENT_DEFAULT overrides still win earlier).
        policy = "SERVER_FORCE";
        policy_reason = `auto: owner ${owner.mod_id} is ${owner.side_class} → SERVER_FORCE`;
        changed++;
      }
    }

    if (!owner && policy === "COMMON_FORCE_REVIEW") {
      const stem = tokens(cf.path)[1]?.toLowerCase() ?? "";
      if (!KNOWN_NON_MOD.has(stem)) orphans.push(cf.path);
    }

    const next = withTarget(cf, policy as ConfigPolicy, owner, ownerId, {
      policy_reason,
      exclusion_reason: undefined
    });
    if (cf.target !== next.target || prev !== next.policy) changed++;
    return next;
  });

  return {
    catalog: { ...c, schemaVersion: CATALOG_SCHEMA_VERSION, configs },
    changed,
    orphans,
    mapped,
    excluded,
    migratedLegacy
  };
}

export type { ConfigTarget };
