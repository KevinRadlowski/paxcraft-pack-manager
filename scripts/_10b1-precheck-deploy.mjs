import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SystemSshTransport, remoteMkdirTransactionCommand, remoteVerifyOriginCommand } from "../dist/sshTransport.js";
import { generateTransactionId, posixShellQuote } from "../dist/remotePaths.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const identity = `${process.env.USERPROFILE}/.ssh/sweetcraft/deploy_ed25519`;
const target = {
  host: "87.106.2.194",
  user: "sweetcraft-deploy",
  port: 22,
  identity,
  batchMode: true,
  timeoutMs: 60000
};
const transport = new SystemSshTransport();

async function sha256File(p) {
  const buf = await fs.readFile(p);
  return createHash("sha256").update(buf).digest("hex");
}

async function sha256Tree(dir) {
  const lines = [];
  async function walk(d, rel = "") {
    for (const ent of await fs.readdir(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      const abs = path.join(d, ent.name);
      if (ent.isDirectory()) await walk(abs, r);
      else if (ent.isFile()) {
        const h = createHash("sha256").update(await fs.readFile(abs)).digest("hex");
        lines.push(`${h}  ${r.replace(/\\/g, "/")}`);
      }
    }
  }
  await walk(dir);
  lines.sort();
  return createHash("sha256").update(lines.join("\n") + "\n").digest("hex");
}

async function probe(label, cmd) {
  const res = await transport.ssh(target, cmd);
  const out = (res.stdout + res.stderr).trim().slice(0, 500);
  console.log(`PROBE ${label}: code=${res.code} out=${JSON.stringify(out)}`);
  return res;
}

console.log("=== PRECHECK LOCAL ===");
const publish = path.join(root, "data/publish");
const relJson = path.join(publish, "releases/0.1.4/release.json");
const chJson = path.join(publish, "channels/dev.json");
console.log("release.json", await sha256File(relJson));
console.log("dev.json", await sha256File(chJson));
console.log("publish_tree", await sha256Tree(publish));

const distCli = path.join(root, "dist-origin/cli.js");
try {
  console.log("dist-origin/cli.js", await sha256File(distCli));
} catch {
  console.log("dist-origin/cli.js MISSING");
}

console.log("\n=== HTTPS BEFORE ===");
for (const url of [
  "https://cdn.xnosweet.fr/sweetcraft/channels/dev.json",
  "https://cdn.xnosweet.fr/sweetcraft/releases/0.1.4/release.json"
]) {
  try {
    const r = await fetch(url);
    const txt = await r.text();
    if (url.includes("dev.json")) {
      const j = JSON.parse(txt);
      console.log(`dev ${r.status} packVersion=${j.packVersion} seq=${j.releaseSequence}`);
    } else {
      console.log(`0.1.4 ${r.status}`);
    }
  } catch (e) {
    console.log(`${url} ERR ${e.message}`);
  }
}

console.log("\n=== VPS PROBES ===");
await probe("sudo_l", "sudo -n -l 2>&1 | head -n 30");
await probe("verifier_head", "head -n 5 /usr/local/lib/sweetcraft-verifier/cli.js 2>&1");
await probe("verifier_sha", "sha256sum /usr/local/lib/sweetcraft-verifier/cli.js 2>&1");
await probe("verifier_version", "/opt/sweetcraft/node/current/bin/node /usr/local/lib/sweetcraft-verifier/cli.js 2>&1 | head -n 3");
await probe("home_ls", "ls -la /home/sweetcraft-deploy 2>&1 | head -n 15");
await probe("commit_gate_head", "head -n 40 /usr/local/sbin/sweetcraft-release-commit 2>&1");

const tx = generateTransactionId("dev", "0.1.4", 5);
await probe("mkdir_tx", remoteMkdirTransactionCommand(tx));

const staging = "/home/sweetcraft-deploy/sweetcraft-verifier-10b1-staging";
await probe("mkdir_home_staging", `mkdir -p ${posixShellQuote(staging)}`);

const scp = await transport.scpTo(target, path.join(root, "dist-origin"), staging, true);
console.log(
  "scp_home_staging",
  scp.code,
  (scp.stderr || scp.stdout).trim().slice(0, 300)
);

if (scp.code === 0) {
  await probe("staged_sha", `sha256sum ${posixShellQuote(`${staging}/cli.js`)} 2>&1`);
  await probe(
    "staged_verify_help",
    `/opt/sweetcraft/node/current/bin/node ${posixShellQuote(`${staging}/cli.js`)} 2>&1 | head -n 3`
  );
}

console.log("\n=== REMOTE VERIFY COMMAND (default path) ===");
console.log(remoteVerifyOriginCommand(tx, "dev"));
