import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCatalog } from "../src/io.js";
import { DEFAULT_ORIGIN } from "../src/remotePaths.js";
import { UnsignedDevSigner } from "../src/releaseSigning.js";
import { stageRelease } from "../src/stage.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLEAN =
  process.env.SWEETCRAFT_CLEAN_ROOT ??
  path.resolve(ROOT, "..", "..", "MODPACK FINAL CLEAN");
const REPORT_DIR = path.join(ROOT, "data", "candidates", "0.1.4-seq5-NONPUBLISHABLE");
const CREATED_AT = "2026-09-15T20:00:00.000Z";

async function fingerprintPayloadTree(releaseDir: string): Promise<string> {
  const lines: string[] = [];
  async function walk(dir: string, rel = "") {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) await walk(abs, r);
      else if (r.startsWith("files/") || r.endsWith("-manifest.json") || r === "checksums.json") {
        const buf = await fs.readFile(abs);
        lines.push(`${createHash("sha256").update(buf).digest("hex")}\t${buf.length}\t${r}`);
      }
    }
  }
  await walk(releaseDir);
  return lines.sort().join("\n") + "\n";
}

async function main() {
  const mergedSource = path.join(REPORT_DIR, "_canonical-merged-config-source");
  const catalog = await readCatalog(path.join(ROOT, "data", "catalog.configs.json"));
  const reproParent = path.join(REPORT_DIR, "_repro-stage");
  await fs.rm(reproParent, { recursive: true, force: true });
  const repro = await stageRelease({
    catalog,
    packVersion: "0.1.4",
    sourceRoot: mergedSource,
    outDir: reproParent,
    force: true,
    cleanRoot: CLEAN,
    productOrigin: DEFAULT_ORIGIN,
    resourcePacksFile: path.join(ROOT, "data", "resourcepacks.json"),
    serverDatapacksFile: path.join(ROOT, "data", "serverDatapacks.json"),
    createdAt: CREATED_AT,
    releaseSequence: 5,
    signer: new UnsignedDevSigner()
  });
  const canon = await fingerprintPayloadTree(path.join(ROOT, "data", "releases", "0.1.4"));
  const reproFp = await fingerprintPayloadTree(repro.releaseDir);
  const payloadEqual = canon === reproFp;
  await fs.writeFile(path.join(REPORT_DIR, "DETERMINISM_PAYLOAD.fingerprint.txt"), canon);
  await fs.writeFile(
    path.join(REPORT_DIR, "DETERMINISM_REPORT.json"),
    JSON.stringify({ payloadEqual, createdAtFixed: CREATED_AT }, null, 2)
  );
  await fs.rm(reproParent, { recursive: true, force: true });
  console.log(JSON.stringify({ payloadEqual, createdAtFixed: CREATED_AT }));
  if (!payloadEqual) process.exitCode = 2;
}

main().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
