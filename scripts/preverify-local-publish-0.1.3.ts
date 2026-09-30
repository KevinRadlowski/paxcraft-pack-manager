import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { verifyChannelDescriptor } from "../src/verifyChannel.js";
import { loadTrustedKeys } from "../src/trustedKeys.js";

const PUB = "C:\\Users\\kevin\\.sweetcraft\\signing\\release-2026-01-ed25519-public.pem";
const ROOT = path.resolve("data/publish-0.1.3");

async function main() {
  const pub = await fs.readFile(PUB, "utf8");
  const dir = path.join(os.tmpdir(), "sweetcraft-trusted-keys");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "trusted-keys.json");
  await fs.writeFile(file, JSON.stringify({ "sweetcraft-release-2026-01": pub }));
  console.log(`TRUSTED_KEYS=${file}`);

  const trustedKeys = await loadTrustedKeys({ file, fromEnv: false });
  const r = await verifyChannelDescriptor({
    channelFile: path.join(ROOT, "channels", "dev.json"),
    root: ROOT,
    trustedKeys,
    allowUnsignedDev: false
  });
  console.log(
    JSON.stringify({
      ok: r.ok,
      channelSignature: r.channelSignature,
      releaseSignature: r.releaseSignature,
      packVersion: r.packVersion,
      releaseSequence: r.releaseSequence,
      releasePath: r.releasePath,
      errors: r.errors,
      label: r.ok ? "ORIGIN_VERIFY_OK" : "ORIGIN_VERIFY_FAIL"
    })
  );
  if (!r.ok) process.exitCode = 2;
}

main().catch(e => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
