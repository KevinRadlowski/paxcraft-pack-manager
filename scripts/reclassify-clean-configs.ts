import { promises as fs } from "node:fs";
import path from "node:path";
import { applyCuration } from "../src/curation.js";
import { classifyConfigs } from "../src/configPolicy.js";
import { readCatalog, writeJson } from "../src/io.js";
import { CATALOG_SCHEMA_VERSION } from "../src/types.js";
import { validate } from "../src/validate.js";

const CLEAN = "H:/Users/kevin/Downloads/Dev/XBase/MODPACK FINAL CLEAN";

async function jarNames(side: "client" | "server"): Promise<Set<string>> {
  const dir = path.join(CLEAN, side, "mods");
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return new Set(
    entries.filter(e => e.isFile() && e.name.toLowerCase().endsWith(".jar")).map(e => e.name)
  );
}

let c = await readCatalog("data/catalog.providers.json");
const clientJars = await jarNames("client");
const serverJars = await jarNames("server");
const client = new Set(c.mods.filter(m => clientJars.has(m.jar)).map(m => m.mod_id));
const server = new Set(c.mods.filter(m => serverJars.has(m.jar)).map(m => m.mod_id));
c = applyCuration(c, { presence: { client, server } }).catalog;
const cfg = classifyConfigs(c);
c = { ...cfg.catalog, schemaVersion: CATALOG_SCHEMA_VERSION };
await writeJson("data/catalog.configs.json", c);
await writeJson("data/catalog.curated.json", c);

const findings = validate(c);
const errors = findings.filter(x => x.severity === "ERROR");
const warns = findings.filter(x => x.severity === "WARN");
console.log("errors", errors.length);
for (const e of errors) console.log(`${e.code} ${e.subject} — ${e.message}`);
console.log("warns", warns.length);
const policies: Record<string, number> = {};
for (const cf of c.configs) policies[cf.policy] = (policies[cf.policy] || 0) + 1;
console.log("policies", policies);
console.log(errors.length === 0 ? "CATALOG_BASELINE_READY" : "CATALOG_BASELINE_NOT_READY");
