import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Catalog } from "./types.js";

export async function readCatalog(file: string): Promise<Catalog> {
  return JSON.parse(await fs.readFile(file, "utf8")) as Catalog;
}
export async function writeJson(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}
export async function hashFile(file: string, algo: "sha1"|"sha256"|"sha512" = "sha256") {
  const h = createHash(algo);
  h.update(await fs.readFile(file));
  return h.digest("hex");
}
export async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function rec(d: string) {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await rec(p); else out.push(p);
    }
  }
  await rec(dir);
  return out;
}
