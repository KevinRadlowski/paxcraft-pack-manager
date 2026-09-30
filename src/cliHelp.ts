import { VERSION } from "./version.js";
import { DEFAULT_ORIGIN } from "./remotePaths.js";

export const BASELINE_CATALOG_DEFAULT = "data/catalog.baseline.json";
/** Release-ready catalogue (schema 2 + targets) produced by pnpm pack:configs. */
export const RELEASE_CATALOG_DEFAULT = "data/catalog.configs.json";

/** Commands that default --current to the release-ready catalogue. */
export const RELEASE_CATALOG_COMMANDS = new Set([
  "status",
  "validate",
  "manifest",
  "manifests",
  "stage",
  "preflight-stage",
  "release-preflight"
]);

export function resolveCurrentCatalogDefault(cmd: string, opts: {
  currentOpt?: string;
  catalogOpt?: string;
}): { baseline: string; current: string } {
  const baseline = opts.catalogOpt ?? BASELINE_CATALOG_DEFAULT;
  if (opts.currentOpt) {
    return { baseline, current: opts.currentOpt };
  }
  if (RELEASE_CATALOG_COMMANDS.has(cmd)) {
    return { baseline, current: RELEASE_CATALOG_DEFAULT };
  }
  return { baseline, current: baseline };
}

const HELP: Record<string, string> = {
  status: `status [--current <catalog>]
  Affiche un résumé du catalogue (défaut: ${RELEASE_CATALOG_DEFAULT}).`,
  validate: `validate [--current <catalog>]
  Valide le catalogue release-ready (défaut: ${RELEASE_CATALOG_DEFAULT}).`,
  diff: `diff [--catalog <baseline>] [--current <catalog>]
  Diff entre baseline et current.`,
  scan: `scan --mods <dir> [--config <dir>] [--catalog <baseline>] [--out <file>]
  Scan instance locale.`,
  "classify-configs": `classify-configs [--current <catalog>] [--out data/catalog.configs.json]
  Alias pnpm: pack:configs
  Classe les configs et écrit le catalogue schema 2 release-ready.`,
  stage: `stage --version <semver> --source <packRoot> --content <sweetcraft-content> --clean <MFC>
         [--out-dir data/releases] [--force]
         [--current ${RELEASE_CATALOG_DEFAULT}] [--resourcepacks <file>]
         [--product-origin ${DEFAULT_ORIGIN}]
         [--sequence <n>] [--unsigned-dev] [--casino-provenance <proof.json>]
  Stage une release locale. STEP-4.6-M7: release-preflight fail-closed (pas de --skip).
  --content et --clean obligatoires. --sequence optionnel; --unsigned-dev force unsigned-dev.`,
  "preflight-stage": `preflight-stage --clean <MODPACK FINAL CLEAN>
  [--current ${RELEASE_CATALOG_DEFAULT}] [--resourcepacks data/resourcepacks.json]
  [--version 0.1.3] [--out report.json]
  Preflight artefacts SANS stage/signature/publish.`,
  "release-preflight": `release-preflight --content <sweetcraft-content> --clean <MFC>
  [--current ${RELEASE_CATALOG_DEFAULT}] [--version <semver>] [--sequence <n>]
  [--casino-provenance <proof.json>] [--out report.json] [--bom-out bom.json]
  [--generated-at <iso>] [--no-dathost-external]
  Preflight assembly READ-ONLY (quests/datapack/RP/config/Casino/versions/BOM).
  Statuts: PASS|BLOCKED|EXTERNAL_VERIFY|ERROR. Aucune mutation stage/publish.`,
  "verify-release": `verify-release --release <dir> [--trusted-keys <json>] [--require-signed]
  Vérifie une release staged/publiée.`,
  "verify-channel": `verify-channel --channel <file> --root <publishRoot> [--trusted-keys <json>]
  Vérifie un descripteur de canal.`,
  publish: `publish --release <dir> --channel <dev|beta|stable> --sequence <n>
          --out-dir <publishRoot> [--trusted-keys <json>] [--allow-unsigned-dev]
  Publie localement (signe + channel).`,
  upload: `upload --root <publishRoot> --channel <dev|beta|stable>
         --host <host> --user <user> [--identity <key>] [--port 22]
         [--origin ${DEFAULT_ORIGIN}] [--trusted-keys <json>] [--timeout 60]
         [--keep-failed-transaction]
  Upload distant. --origin = base URL publique du PRODUIT (ex. .../sweetcraft).`,
  "verify-origin": `verify-origin --transaction <dir> --channel <dev|beta|stable> --trusted-keys <json> [--json]`,
  "validate-resourcepacks": `validate-resourcepacks [--file data/resourcepacks.json]`,
  "validate-server-datapacks": `validate-server-datapacks [--file data/serverDatapacks.json]`,
  manifests: `manifests --version <v> [--current ${RELEASE_CATALOG_DEFAULT}] [--out-dir data/release]`,
  manifest: `manifest --version <v> [--current ${RELEASE_CATALOG_DEFAULT}] [--out <file>]`,
  curate: `curate [--current <catalog>] [--out data/catalog.curated.json]`,
  "resolve-modrinth": `resolve-modrinth [--current <catalog>]`,
  "resolve-curseforge": `resolve-curseforge [--current <catalog>]`,
  "resolve-providers": `resolve-providers [--current <catalog>] [--out data/catalog.providers.json]`
};

export function formatCommandHelp(cmd: string): string {
  const body = HELP[cmd];
  if (!body) {
    return [
      `SweetCraft Pack Manager v${VERSION}`,
      "",
      "Commandes: " + Object.keys(HELP).sort().join(", "),
      "",
      "Utiliser: <commande> --help"
    ].join("\n");
  }
  return [`SweetCraft Pack Manager v${VERSION}`, "", body].join("\n");
}
