import type { ManifestConfigMigration } from "./configMigrationTypes.js";

/** IPN AutoRefill defaults required by FINAL CLEAN — safe one-shot from 0.1.3 baseline. */
export const IPN_AUTOREFILL_FALSE_FROM_0_1_3: ManifestConfigMigration = {
  id: "ipn-autorefill-false-from-0.1.3",
  configPath: "config/inventoryprofilesnext/inventoryprofiles.json",
  fromPackVersions: ["0.1.3"],
  set: [
    { path: "AutoRefillSettings.refill_armor.value", value: false },
    { path: "AutoRefillSettings.refill_before_tool_break.value", value: false }
  ]
};

function parsePackVersion(version: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function packVersionAtLeast(version: string, min: string): boolean {
  const a = parsePackVersion(version);
  const b = parsePackVersion(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i]! > b[i]!) return true;
    if (a[i]! < b[i]!) return false;
  }
  return true;
}

/** Declarative migrations embedded in client manifests for destination pack versions. */
export function configMigrationsForManifest(packVersion: string): ManifestConfigMigration[] {
  if (!packVersionAtLeast(packVersion, "0.1.4")) return [];
  return [IPN_AUTOREFILL_FALSE_FROM_0_1_3];
}
