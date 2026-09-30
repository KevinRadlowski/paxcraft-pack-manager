import { mkdtemp, writeFile, cp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stageRelease } from "../dist/stage.js";
import { publishRelease } from "../dist/publish.js";
import { createEphemeralEd25519Signer, UnsignedDevSigner } from "../dist/releaseSigning.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = await mkdtemp(path.join(os.tmpdir(), "sc-smoke-"));
try {
  const source = path.join(dir, "pack");
  const body = "smoke";
  const sha = createHash("sha256").update(body).digest("hex");
  await mkdir(path.join(source, "config"), { recursive: true });
  await writeFile(path.join(source, "config", "demo.json"), body);
  const catalog = {
    schemaVersion: 2,
    generatedFor: { product: "SweetCraft", minecraft: "26.1.2", fabricLoader: "0.19.3", server: "test" },
    mods: [
      {
        jar: "demo.jar",
        mod_id: "demo",
        name: "demo",
        version: "1",
        size_bytes: 1,
        sha256: "a".repeat(64),
        sha512: "b".repeat(128),
        side_class: "BOTH_REQUIRED",
        install_client: true,
        install_server: true,
        distribution_policy: "UPSTREAM_PREFERRED",
        modrinth_file_url: "https://example.test/m.jar"
      }
    ],
    configs: [
      {
        path: "config/demo.json",
        size_bytes: body.length,
        sha256: sha,
        policy: "SERVER_FORCE",
        target: "BOTH",
        owner_mod_id: null
      }
    ]
  };
  const staged = await stageRelease({
    catalog,
    packVersion: "0.1.0",
    sourceRoot: source,
    outDir: path.join(dir, "stg"),
    createdAt: "2026-01-01T00:00:00.000Z",
    signer: new UnsignedDevSigner()
  });
  const signer = createEphemeralEd25519Signer("smoke-key");
  const keys = { "smoke-key": signer.publicKeyPem };
  const pub = path.join(dir, "publish");
  await publishRelease({
    releaseDir: staged.releaseDir,
    channel: "dev",
    sequence: 1,
    outDir: pub,
    signer,
    trustedKeys: keys
  });
  const tx = path.join(dir, "tx");
  await cp(pub, tx, { recursive: true });
  const keysFile = path.join(dir, "trusted.json");
  await writeFile(keysFile, JSON.stringify(keys));
  const cli = path.join(root, "dist-origin", "cli.js");
  const r = spawnSync(
    process.execPath,
    [cli, "verify-origin", "--transaction", tx, "--channel", "dev", "--trusted-keys", keysFile, "--json"],
    { encoding: "utf8" }
  );
  console.log(r.stdout);
  if (r.stderr) console.error(r.stderr);
  if (r.status !== 0) process.exit(r.status ?? 1);
  const j = JSON.parse(r.stdout);
  if (!j.ok || j.releaseSignature !== "SIGNED_OK" || j.channelSignature !== "SIGNED_OK") {
    process.exit(1);
  }
  console.log("DIST_ORIGIN_SMOKE_OK");
} finally {
  await rm(dir, { recursive: true, force: true });
}
