import type { Catalog, SideClass } from "./types.js";
import { installFlags } from "./side.js";
import { applyDependencyClosurePromotions } from "./dependencyClosure.js";

/**
 * Hard side overrides — must not contradict CLEAN physical presence or Fabric depends.
 * Historical mistake removed: codxlib SERVER_ONLY.
 */
const SIDE_OVERRIDES: Record<string, { side: SideClass; reason: string }> = {
  // Empty by design for CLEAN baseline: physical presence + dependency closure are authoritative.
};

/** Legal distribution for pack-owned / unresolved-upstream jars present in CLEAN. */
const LEGAL_OVERRIDES: Record<
  string,
  { policy: "SWEETCRAFT_ALLOWED" | "UPSTREAM_PREFERRED"; reason: string }
> = {
  fallen: {
    policy: "SWEETCRAFT_ALLOWED",
    reason: "CLEAN: Fallen replaces Universal Graves — SweetCraft-allowed distribution"
  },
  xbasecasino: {
    policy: "SWEETCRAFT_ALLOWED",
    reason: "CLEAN: XBase Casino — pack-owned / SweetCraft-allowed distribution"
  }
};

/**
 * Mods that must not reappear after the CLEAN baseline (replaced by Fallen).
 * validate() may ERROR if these ids are present in a catalogue destined for release.
 */
export const CLEAN_FORBIDDEN_MOD_IDS = new Set(["universal-graves"]);

export interface PhysicalPresence {
  /** mod_id present as top-level jar on client */
  client: ReadonlySet<string>;
  /** mod_id present as top-level jar on server */
  server: ReadonlySet<string>;
}

/**
 * Apply CLEAN physical presence as primary side intent.
 * - on both → BOTH_REQUIRED
 * - client only → CLIENT_ONLY
 * - server only → SERVER_ONLY
 * Does not invent presence; caller supplies sets from dual-side scan.
 */
export function applyPhysicalPresenceSides(
  catalog: Catalog,
  presence: PhysicalPresence
): { catalog: Catalog; changed: number } {
  let changed = 0;
  const mods = catalog.mods.map(m => {
    const onC = presence.client.has(m.mod_id);
    const onS = presence.server.has(m.mod_id);
    if (!onC && !onS) return m;

    let side: SideClass;
    if (onC && onS) side = "BOTH_REQUIRED";
    else if (onC) side = "CLIENT_ONLY";
    else side = "SERVER_ONLY";

    const flags = installFlags(side);
    const sideUnchanged =
      m.side_class === side &&
      m.install_client === (side !== "SERVER_ONLY") &&
      m.install_server === (side !== "CLIENT_ONLY");
    const hadConflict = m.side_upstream_relation === "REAL_CONFLICT";
    if (sideUnchanged && !hadConflict && m.side_confidence === "HIGH") {
      return m;
    }
    changed++;
    // Physical presence is authoritative for CLEAN. Modrinth "server_only" on worldgen
    // (etc.) must not block a jar that is intentionally present on both sides.
    const upstream = hadConflict ? "COMPATIBLE" : m.side_upstream_relation;
    return {
      ...m,
      side_class: side,
      ...flags,
      client_required_to_join: side === "CLIENT_ONLY" || side === "BOTH_REQUIRED",
      server_required: side === "SERVER_ONLY" || side === "BOTH_REQUIRED",
      side_confidence: "HIGH",
      side_upstream_relation: upstream,
      curation_note: `CLEAN physical presence: client=${onC} server=${onS} → ${side}`
    };
  });
  return { catalog: { ...catalog, mods }, changed };
}

export function applyCuration(
  c: Catalog,
  opts?: { presence?: PhysicalPresence }
): { catalog: Catalog; changed: number; closurePromoted: number; presenceChanged: number } {
  let changed = 0;
  let presenceChanged = 0;
  let mods = c.mods.map(m => {
    const o = SIDE_OVERRIDES[m.mod_id];
    if (!o) return m;
    changed++;
    const flags = installFlags(o.side);
    return {
      ...m,
      side_class: o.side,
      ...flags,
      client_required_to_join: o.side === "CLIENT_ONLY",
      server_required: o.side === "SERVER_ONLY",
      side_confidence: "HIGH",
      side_web_verified: true,
      side_upstream_relation: "EXACT" as const,
      curation_note: o.reason
    };
  });

  mods = mods.map(m => {
    const legal = LEGAL_OVERRIDES[m.mod_id];
    if (!legal) return m;
    if (m.distribution_policy !== "LEGAL_REVIEW" && m.distribution_policy !== "BLOCKED") return m;
    changed++;
    return {
      ...m,
      distribution_policy: legal.policy,
      legal_note: legal.reason
    };
  });

  let catalog: Catalog = { ...c, mods };
  if (opts?.presence) {
    const phys = applyPhysicalPresenceSides(catalog, opts.presence);
    catalog = phys.catalog;
    presenceChanged = phys.changed;
    changed += phys.changed;
    mods = catalog.mods;
  }

  const closure = applyDependencyClosurePromotions({ ...catalog, mods });
  mods = closure.catalog.mods;
  changed += closure.promoted.length;

  return {
    catalog: { ...catalog, mods },
    changed,
    closurePromoted: closure.promoted.length,
    presenceChanged
  };
}
