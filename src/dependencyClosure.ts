import type { Catalog, ModRecord, SideClass } from "./types.js";
import { installFlags } from "./side.js";
import { hyphenUnderscoreNearMiss } from "./fabricMeta.js";
import { satisfiesFabricDependsValue } from "./fabricVersion.js";

/**
 * Fabric / loader / JDK ids that are never pack JARs.
 * Also covers Fabric API module ids commonly declared as depends
 * but shipped inside fabric-api (not separate catalog entries).
 */
export const PLATFORM_OR_PROVIDED_DEPENDENCY_IDS = new Set([
  "minecraft",
  "java",
  "fabricloader",
  "fabric-loader",
  "fabric-api",
  "fabric-language-kotlin"
]);

export function isPlatformOrProvidedDependency(modId: string): boolean {
  if (PLATFORM_OR_PROVIDED_DEPENDENCY_IDS.has(modId)) return true;
  if (/^fabric-[a-z0-9-]+(?:-v\d+)?$/i.test(modId)) return true;
  return false;
}

/** Required Fabric `depends` keys that may refer to pack mods / nested / provides. */
export function requiredDependencyIds(mod: ModRecord): string[] {
  const depends = mod.depends;
  if (!depends || typeof depends !== "object" || Array.isArray(depends)) return [];
  return Object.keys(depends)
    .filter(id => typeof id === "string" && id.length > 0)
    .filter(id => !isPlatformOrProvidedDependency(id))
    .sort((a, b) => a.localeCompare(b));
}

export type ManifestSide = "client" | "server";

export type DependencySatisfyStatus =
  | "SATISFIED_TOP_LEVEL"
  | "SATISFIED_PROVIDES"
  | "SATISFIED_NESTED"
  | "SATISFIED_FABRIC_MODULE"
  | "BUILTIN"
  | "MISSING"
  | "VERSION_INCOMPATIBLE"
  | "UNKNOWN_VERSION_SEMANTICS"
  /** Exact id missing, but hyphen/underscore near-miss exists — NOT treated as satisfied. */
  | "ALIAS_REQUIRED";

export interface DependencySatisfyResult {
  status: DependencySatisfyStatus;
  /** Version used for evaluation when known; null for unversioned provides. */
  resolvedVersion: string | null;
  detail?: string;
}

export interface DependencyClosureGap {
  dependentId: string;
  dependencyId: string;
  side: ManifestSide;
  inPack: boolean;
  dependencySideClass?: SideClass;
  path: string[];
  message: string;
}

function isInstalledOnSide(mod: ModRecord, side: ManifestSide): boolean {
  if (side === "client") return !!mod.install_client && mod.side_class !== "SERVER_ONLY";
  return !!mod.install_server && mod.side_class !== "CLIENT_ONLY";
}

type ProviderHit =
  | { kind: "top"; mod: ModRecord; version: string }
  | { kind: "provides"; mod: ModRecord; version: string | null }
  | { kind: "nested"; mod: ModRecord; version: string; nestedId: string };

/**
 * Index providers among mods installed on a side.
 * For fabric-api umbrella: only the TOP-LEVEL mod_id === "fabric-api" version is used
 * (never a nested module version).
 */
export function buildSideProviderIndex(
  catalog: Catalog,
  side: ManifestSide
): {
  byExactId: Map<string, ProviderHit[]>;
  allIds: Set<string>;
} {
  const byExactId = new Map<string, ProviderHit[]>();
  const allIds = new Set<string>();

  const push = (id: string, hit: ProviderHit) => {
    allIds.add(id);
    const list = byExactId.get(id) ?? [];
    list.push(hit);
    byExactId.set(id, list);
  };

  for (const mod of catalog.mods) {
    if (!isInstalledOnSide(mod, side)) continue;
    push(mod.mod_id, { kind: "top", mod, version: mod.version });

    for (const [pid, pver] of Object.entries(mod.provides ?? {})) {
      push(pid, { kind: "provides", mod, version: pver });
    }

    for (const n of mod.nested_modules ?? []) {
      if (!n.id || n.parse_error) continue;
      push(n.id, { kind: "nested", mod, version: n.version, nestedId: n.id });
      for (const [pid, pver] of Object.entries(n.provides ?? {})) {
        push(pid, { kind: "provides", mod, version: pver });
      }
    }
  }

  return { byExactId, allIds };
}

function pickTopLevelHit(hits: ProviderHit[]): ProviderHit | undefined {
  return hits.find(h => h.kind === "top") ?? hits[0];
}

/**
 * Resolve a dependency id against mods installed on a side.
 * fabric-api always prefers the top-level fabric-api ModRecord version.
 */
export function satisfyDependencyOnSide(
  depId: string,
  range: unknown,
  catalog: Catalog,
  side: ManifestSide
): DependencySatisfyResult {
  if (depId === "minecraft" || depId === "java" || depId === "fabricloader" || depId === "fabric-loader") {
    return { status: "BUILTIN", resolvedVersion: null, detail: "runtime-builtin" };
  }

  const { byExactId, allIds } = buildSideProviderIndex(catalog, side);

  // Fabric API umbrella: never use nested module versions for id fabric-api
  if (depId === "fabric-api") {
    const top = catalog.mods.find(m => m.mod_id === "fabric-api" && isInstalledOnSide(m, side));
    if (!top) {
      // modules alone do not satisfy fabric-api id
      if ([...allIds].some(id => id.startsWith("fabric-") && id !== "fabric-api")) {
        return {
          status: "SATISFIED_FABRIC_MODULE",
          resolvedVersion: null,
          detail: "fabric-api-modules-present-without-umbrella"
        };
      }
      return { status: "MISSING", resolvedVersion: null };
    }
    const ev = satisfiesFabricDependsValue(top.version, range);
    if (ev.status === "UNKNOWN_VERSION_SEMANTICS") {
      return { status: "UNKNOWN_VERSION_SEMANTICS", resolvedVersion: top.version, detail: ev.reason };
    }
    if (ev.status === "INCOMPATIBLE") {
      return { status: "VERSION_INCOMPATIBLE", resolvedVersion: top.version };
    }
    return { status: "SATISFIED_TOP_LEVEL", resolvedVersion: top.version };
  }

  if (isPlatformOrProvidedDependency(depId) && depId !== "fabric-api") {
    // fabric-* module: satisfied if fabric-api top-level present OR exact nested/top id
    const fabricApi = catalog.mods.find(m => m.mod_id === "fabric-api" && isInstalledOnSide(m, side));
    const hits = byExactId.get(depId);
    if (hits?.length) {
      const hit = pickTopLevelHit(hits)!;
      const ver = hit.version;
      if (ver == null) {
        return { status: "UNKNOWN_VERSION_SEMANTICS", resolvedVersion: null, detail: "unversioned-provider" };
      }
      const ev = satisfiesFabricDependsValue(ver, range);
      if (ev.status === "UNKNOWN_VERSION_SEMANTICS") {
        return { status: "UNKNOWN_VERSION_SEMANTICS", resolvedVersion: ver, detail: ev.reason };
      }
      if (ev.status === "INCOMPATIBLE") {
        return { status: "VERSION_INCOMPATIBLE", resolvedVersion: ver };
      }
      return {
        status: hit.kind === "nested" ? "SATISFIED_NESTED" : "SATISFIED_FABRIC_MODULE",
        resolvedVersion: ver
      };
    }
    if (fabricApi) {
      // Umbrella present — module deps typically satisfied; version constraints on modules
      // cannot be verified against umbrella → UNKNOWN if range is not *
      if (range == null || range === "*" || range === "") {
        return { status: "SATISFIED_FABRIC_MODULE", resolvedVersion: fabricApi.version, detail: "via-fabric-api" };
      }
      return {
        status: "UNKNOWN_VERSION_SEMANTICS",
        resolvedVersion: fabricApi.version,
        detail: "fabric-module-version-via-umbrella"
      };
    }
    return { status: "MISSING", resolvedVersion: null };
  }

  const hits = byExactId.get(depId);
  if (!hits?.length) {
    // Diagnostic near-miss only — NOT satisfied
    for (const id of allIds) {
      if (hyphenUnderscoreNearMiss(depId, id)) {
        return {
          status: "ALIAS_REQUIRED",
          resolvedVersion: null,
          detail: `near-miss:${id} (hyphen/underscore are distinct Fabric ids; no auto-alias)`
        };
      }
    }
    return { status: "MISSING", resolvedVersion: null };
  }

  // Prefer top-level exact id, then nested, then provides
  const ordered = [
    ...hits.filter(h => h.kind === "top"),
    ...hits.filter(h => h.kind === "nested"),
    ...hits.filter(h => h.kind === "provides")
  ];
  let sawUnknown = false;
  let lastVer: string | null = null;
  for (const hit of ordered) {
    lastVer = hit.version;
    if (hit.version == null) {
      // Unversioned provides (array form): cannot evaluate non-trivial ranges
      if (range == null || range === "*" || range === "") {
        return { status: "SATISFIED_PROVIDES", resolvedVersion: null, detail: "provides-unversioned" };
      }
      sawUnknown = true;
      continue;
    }
    const ev = satisfiesFabricDependsValue(hit.version, range);
    if (ev.status === "SATISFIED") {
      if (hit.kind === "top") return { status: "SATISFIED_TOP_LEVEL", resolvedVersion: hit.version };
      if (hit.kind === "nested") return { status: "SATISFIED_NESTED", resolvedVersion: hit.version };
      return { status: "SATISFIED_PROVIDES", resolvedVersion: hit.version };
    }
    if (ev.status === "UNKNOWN_VERSION_SEMANTICS") sawUnknown = true;
  }
  if (sawUnknown) {
    return { status: "UNKNOWN_VERSION_SEMANTICS", resolvedVersion: lastVer };
  }
  return { status: "VERSION_INCOMPATIBLE", resolvedVersion: lastVer };
}

/**
 * Pack-internal install gaps: dependency refers to a TOP-LEVEL catalog mod that is not installable
 * on the side. Nested/provides satisfaction does not create gaps.
 * External / nested-only deps are not ERROR gaps (no invented resolution).
 */
export function findPackDependencyClosureGaps(
  catalog: Catalog,
  side: ManifestSide
): DependencyClosureGap[] {
  const byId = new Map(catalog.mods.map(m => [m.mod_id, m]));
  const gaps: DependencyClosureGap[] = [];
  const reported = new Set<string>();

  for (const root of catalog.mods) {
    if (!isInstalledOnSide(root, side)) continue;

    const stack: { id: string; path: string[] }[] = [{ id: root.mod_id, path: [root.mod_id] }];
    const visited = new Set<string>();

    while (stack.length) {
      const { id, path } = stack.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);

      const mod = byId.get(id);
      if (!mod) continue;

      for (const depId of requiredDependencyIds(mod)) {
        const range = mod.depends?.[depId];
        const sat = satisfyDependencyOnSide(depId, range, catalog, side);

        // Nested / provides / fabric module / builtin → no install gap
        if (
          sat.status === "SATISFIED_NESTED" ||
          sat.status === "SATISFIED_PROVIDES" ||
          sat.status === "SATISFIED_FABRIC_MODULE" ||
          sat.status === "BUILTIN" ||
          sat.status === "SATISFIED_TOP_LEVEL"
        ) {
          const depMod = byId.get(depId);
          if (depMod && isInstalledOnSide(depMod, side)) {
            stack.push({ id: depId, path: [...path, depId] });
          }
          continue;
        }

        // Top-level catalog mod present but wrong side → gap (promotion candidate)
        const depMod = byId.get(depId);
        if (depMod && !isInstalledOnSide(depMod, side)) {
          const key = `${side}|${root.mod_id}|${depId}`;
          if (!reported.has(key)) {
            reported.add(key);
            gaps.push({
              dependentId: root.mod_id,
              dependencyId: depId,
              side,
              inPack: true,
              dependencySideClass: depMod.side_class,
              path: [...path, depId],
              message:
                side === "client"
                  ? `mod client « ${root.mod_id} » exige « ${depId} » (depends Fabric) mais « ${depId} » est absent du manifeste client (side_class=${depMod.side_class}, install_client=${depMod.install_client})`
                  : `mod serveur « ${root.mod_id} » exige « ${depId} » (depends Fabric) mais « ${depId} » est absent du manifeste serveur (side_class=${depMod.side_class}, install_server=${depMod.install_server})`
            });
          }
          continue;
        }

        // VERSION_INCOMPATIBLE / UNKNOWN / ALIAS / MISSING for non-top-level: no promotion gap
      }
    }
  }

  return gaps.sort((a, b) => {
    const s = a.side.localeCompare(b.side);
    if (s) return s;
    const d = a.dependentId.localeCompare(b.dependentId);
    if (d) return d;
    return a.dependencyId.localeCompare(b.dependencyId);
  });
}

export function findClientDependencyClosureGaps(catalog: Catalog): DependencyClosureGap[] {
  return findPackDependencyClosureGaps(catalog, "client");
}

export function findServerDependencyClosureGaps(catalog: Catalog): DependencyClosureGap[] {
  return findPackDependencyClosureGaps(catalog, "server");
}

export function promoteSideForClientInstall(current: SideClass): SideClass {
  switch (current) {
    case "SERVER_ONLY":
      return "SERVER_REQUIRED_CLIENT_OPTIONAL";
    case "UNKNOWN":
      return "SERVER_REQUIRED_CLIENT_OPTIONAL";
    default:
      return current;
  }
}

export function promoteSideForServerInstall(current: SideClass): SideClass {
  switch (current) {
    case "CLIENT_ONLY":
      return "CLIENT_REQUIRED_SERVER_OPTIONAL";
    case "UNKNOWN":
      return "CLIENT_REQUIRED_SERVER_OPTIONAL";
    default:
      return current;
  }
}

export interface ClosurePromotionResult {
  catalog: Catalog;
  promoted: { mod_id: string; from: SideClass; to: SideClass; requiredBy: string[] }[];
}

export function applyDependencyClosurePromotions(catalog: Catalog): ClosurePromotionResult {
  const mods = catalog.mods.map(m => ({ ...m }));
  const byId = new Map(mods.map(m => [m.mod_id, m]));
  const requiredByClient = new Map<string, Set<string>>();
  const requiredByServer = new Map<string, Set<string>>();

  const collect = (side: ManifestSide, into: Map<string, Set<string>>) => {
    for (const gap of findPackDependencyClosureGaps({ ...catalog, mods }, side)) {
      if (!gap.inPack) continue;
      let set = into.get(gap.dependencyId);
      if (!set) {
        set = new Set();
        into.set(gap.dependencyId, set);
      }
      set.add(gap.dependentId);
    }
  };

  const promoted: ClosurePromotionResult["promoted"] = [];
  for (let i = 0; i < mods.length + 1; i++) {
    requiredByClient.clear();
    requiredByServer.clear();
    collect("client", requiredByClient);
    collect("server", requiredByServer);
    let changed = false;

    for (const [depId, requirers] of requiredByClient) {
      const mod = byId.get(depId);
      if (!mod || isInstalledOnSide(mod, "client")) continue;
      const from = mod.side_class;
      const to = promoteSideForClientInstall(from);
      const flags = installFlags(to);
      if (!flags.install_client) continue;
      Object.assign(mod, {
        side_class: to,
        ...flags,
        client_required_to_join: to === "CLIENT_ONLY",
        server_required:
          to === "SERVER_ONLY" || to === "BOTH_REQUIRED" || to === "SERVER_REQUIRED_CLIENT_OPTIONAL",
        curation_note: `Client dependency closure: required by ${[...requirers].sort().join(", ")} (Fabric depends). Promoted ${from} → ${to}.`
      });
      promoted.push({ mod_id: depId, from, to, requiredBy: [...requirers].sort() });
      changed = true;
    }

    for (const [depId, requirers] of requiredByServer) {
      const mod = byId.get(depId);
      if (!mod || isInstalledOnSide(mod, "server")) continue;
      const from = mod.side_class;
      const to = promoteSideForServerInstall(from);
      const flags = installFlags(to);
      if (!flags.install_server) continue;
      Object.assign(mod, {
        side_class: to,
        ...flags,
        client_required_to_join:
          to === "CLIENT_ONLY" || to === "BOTH_REQUIRED" || to === "CLIENT_REQUIRED_SERVER_OPTIONAL",
        server_required: to === "SERVER_ONLY",
        curation_note: `Server dependency closure: required by ${[...requirers].sort().join(", ")} (Fabric depends). Promoted ${from} → ${to}.`
      });
      promoted.push({ mod_id: depId, from, to, requiredBy: [...requirers].sort() });
      changed = true;
    }

    if (!changed) break;
  }

  return {
    catalog: { ...catalog, mods },
    promoted
  };
}
