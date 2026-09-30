import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER =
  process.env.SWEETCRAFT_CLEAN_ROOT != null
    ? path.join(process.env.SWEETCRAFT_CLEAN_ROOT, "server")
    : path.resolve(ROOT, "..", "..", "MODPACK FINAL CLEAN", "server");
const OUT = path.join(ROOT, "data", "candidates", "0.1.4-seq5-NONPUBLISHABLE", "SYNC08_SERVER_AUDIT.json");

type Class = "PACK_MANAGED" | "SERVER_RUNTIME" | "WORLD_USER_DATA" | "OPERATIONAL" | "EXCLUDE" | "UNKNOWN";

function classify(rel: string): Class {
  const n = rel.replace(/\\/g, "/");
  if (n.startsWith("world/datapacks/SweetCraft_Quest_Support/")) return "PACK_MANAGED";
  if (n.startsWith("world/datapacks/")) return "UNKNOWN";
  if (n.startsWith("world/region/") || n.endsWith(".mca")) return "WORLD_USER_DATA";
  if (n.startsWith("world/playerdata/") || n.startsWith("world/stats/") || n.startsWith("world/advancements/"))
    return "WORLD_USER_DATA";
  if (n.startsWith("world/data/") || n.startsWith("world/entities/") || n.startsWith("world/poi/"))
    return "WORLD_USER_DATA";
  if (n.startsWith("world/session.lock") || n === "world/level.dat" || n.startsWith("world/level.dat_"))
    return "WORLD_USER_DATA";
  if (n.startsWith("world/datapacks/")) return "UNKNOWN";
  if (n.startsWith("mods/luckperms/libs/")) return "SERVER_RUNTIME";
  if (n.startsWith("mods/") && n.endsWith(".jar")) return "PACK_MANAGED";
  if (n.startsWith("config/")) return "PACK_MANAGED";
  if (n.startsWith("logs/") || n.startsWith("crash-reports/")) return "OPERATIONAL";
  if (n.includes("backup") || n.endsWith(".log")) return "OPERATIONAL";
  if (n.startsWith("world/") && n === "world/datapacks") return "SERVER_RUNTIME";
  return "UNKNOWN";
}

async function walkFiles(dir: string, base = ""): Promise<{ rel: string; size: number; sha256: string; class: Class }[]> {
  const out: { rel: string; size: number; sha256: string; class: Class }[] = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const rel = base ? `${base}/${e.name}` : e.name;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walkFiles(abs, rel)));
    else if (e.isFile()) {
      const buf = await fs.readFile(abs);
      out.push({
        rel: rel.split(path.sep).join("/"),
        size: buf.length,
        sha256: createHash("sha256").update(buf).digest("hex"),
        class: classify(rel)
      });
    }
  }
  return out;
}

async function main() {
  const top = (await fs.readdir(SERVER)).sort();
  const all = await walkFiles(SERVER);
  const totals: Record<Class, number> = {
    PACK_MANAGED: 0,
    SERVER_RUNTIME: 0,
    WORLD_USER_DATA: 0,
    OPERATIONAL: 0,
    EXCLUDE: 0,
    UNKNOWN: 0
  };
  for (const f of all) totals[f.class]++;

  const datapack = all.filter(f => f.rel.startsWith("world/datapacks/SweetCraft_Quest_Support/"));
  const unknown = all.filter(f => f.class === "UNKNOWN");

  const report = {
    generatedAt: new Date().toISOString(),
    serverRoot: SERVER,
    topLevel: top,
    totals,
    datapackQuestSupport: {
      fileCount: datapack.length,
      totalBytes: datapack.reduce((s, f) => s + f.size, 0),
      files: datapack,
      treeFingerprint: createHash("sha256")
        .update(datapack.sort((a, b) => a.rel.localeCompare(b.rel)).map(f => `${f.sha256}\t${f.size}\t${f.rel}`).join("\n") + "\n")
        .digest("hex")
    },
    onlyPackOwnedDatapack:
      all.filter(f => f.rel.startsWith("world/datapacks/") && f.class === "PACK_MANAGED").length === datapack.length &&
      all.filter(f => f.rel.startsWith("world/datapacks/") && f.class !== "PACK_MANAGED").length === 0,
    unknownPaths: unknown.slice(0, 50),
    unknownCount: unknown.length
  };

  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ verdict: report.onlyPackOwnedDatapack ? "AUDIT_OK" : "AUDIT_REVIEW", ...report.totals, datapackFiles: datapack.length }, null, 2));
}

main().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
