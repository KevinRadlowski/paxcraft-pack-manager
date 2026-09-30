/**
 * Build dist-origin/: minimal Node runtime for verify-origin (no tsx, no adm-zip).
 */
import { execSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "dist-origin");
const tsconfig = path.join(root, "tsconfig.origin.json");

async function rmrf(p) {
  await fs.rm(p, { recursive: true, force: true });
}

async function main() {
  await rmrf(outDir);
  execSync(`npx tsc -p "${tsconfig}"`, { cwd: root, stdio: "inherit" });

  // Entry point name expected on server
  const compiled = path.join(outDir, "cliOrigin.js");
  const entry = path.join(outDir, "cli.js");
  await fs.copyFile(compiled, entry);

  const pkg = {
    name: "sweetcraft-origin-verifier",
    version: JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")).version,
    private: true,
    type: "module",
    engines: { node: ">=22" },
    description: "SweetCraft origin transaction verifier (public keys only)",
    bin: { "sweetcraft-verify-origin": "./cli.js" },
    dependencies: {}
  };
  await fs.writeFile(path.join(outDir, "package.json"), JSON.stringify(pkg, null, 2) + "\n", "utf8");

  // Safety scan: no secrets / upload / ZIP tooling / catalog build
  const forbiddenNames = [".pem", ".key", ".env", "catalog", "PRIVATE KEY", "adm-zip", "resourcePack.js", "remotePublish", "ssh"];
  async function scan(dir) {
    for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) await scan(p);
      else {
        const lower = ent.name.toLowerCase();
        if (forbiddenNames.some(f => lower.includes(f.toLowerCase()) || lower.endsWith(f))) {
          throw new Error(`dist-origin contient un fichier interdit: ${p}`);
        }
        if (ent.name.endsWith(".js") || ent.name.endsWith(".json")) {
          const body = await fs.readFile(p, "utf8");
          if (body.includes("BEGIN PRIVATE KEY") || body.includes("BEGIN RSA PRIVATE KEY")) {
            throw new Error(`dist-origin contient une clé privée: ${p}`);
          }
          if (body.includes("adm-zip") || body.includes("from \"ssh2\"") || body.includes("remotePublish")) {
            throw new Error(`dist-origin embarque un module interdit dans ${p}`);
          }
        }
      }
    }
  }
  await scan(outDir);

  // List modules
  const files = [];
  async function list(dir, base = "") {
    for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
      const rel = base ? `${base}/${ent.name}` : ent.name;
      if (ent.isDirectory()) await list(path.join(dir, ent.name), rel);
      else files.push(rel);
    }
  }
  await list(outDir);
  console.log(`dist-origin OK (${files.length} files)`);
  for (const f of files.sort()) console.log(`  ${f}`);
}

main().catch(e => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
