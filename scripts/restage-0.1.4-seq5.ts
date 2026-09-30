import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCatalog } from "../src/io.js";
import { stageRelease } from "../src/stage.js";
import { UnsignedDevSigner } from "../src/releaseSigning.js";
import { DEFAULT_ORIGIN } from "../src/remotePaths.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CREATED_AT = "2026-09-15T20:00:00.000Z";

async function main() {
  const catalog = await readCatalog(path.join(ROOT, "data/catalog.configs.json"));
  const r = await stageRelease({
    catalog,
    packVersion: "0.1.4",
    sourceRoot: path.join(ROOT, "data/candidates/0.1.4-seq5-NONPUBLISHABLE/_canonical-merged-config-source"),
    outDir: path.join(ROOT, "data/releases"),
    force: true,
    cleanRoot: process.env.SWEETCRAFT_CLEAN_ROOT ?? path.resolve(ROOT, "..", "..", "MODPACK FINAL CLEAN"),
    productOrigin: DEFAULT_ORIGIN,
    resourcePacksFile: path.join(ROOT, "data/resourcepacks.json"),
    serverDatapacksFile: path.join(ROOT, "data/serverDatapacks.json"),
    createdAt: CREATED_AT,
    releaseSequence: 5,
    signer: new UnsignedDevSigner()
  });
  console.log(JSON.stringify({ releaseDir: r.releaseDir, clientMods: r.clientMods, configsStaged: r.configsStaged }));
}

main().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
