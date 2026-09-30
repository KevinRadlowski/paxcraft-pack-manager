/**
 * Minimal CLI for SweetCraft origin verifier (server deployment).
 * Commands: verify-origin only.
 */
import path from "node:path";
import { loadTrustedKeys } from "./trustedKeys.js";
import {
  formatOriginVerifyReport,
  originVerifyToJson,
  OriginVerifyError,
  verifyOrigin
} from "./verifyOrigin.js";
import { VERSION } from "./version.js";
import type { ReleaseChannel } from "./releasePayload.js";

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name: string, fallback?: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const flag = (name: string) => args.includes(name);

if (cmd === "version" || flag("--version")) {
  console.log(VERSION);
  process.exit(0);
}

if (cmd !== "verify-origin") {
  console.error(`SweetCraft Origin Verifier v${VERSION}`);
  console.error("Usage: node cli.js verify-origin --transaction <dir> --channel <dev|beta|stable> --trusted-keys <json> [--json]");
  process.exit(2);
}

const transaction = opt("--transaction");
if (!transaction) {
  console.error("--transaction <dir> obligatoire");
  process.exit(2);
}
const channel = opt("--channel");
if (!channel) {
  console.error("--channel <dev|beta|stable> obligatoire");
  process.exit(2);
}
const keysPath = opt("--trusted-keys");
if (!keysPath && !process.env.SWEETCRAFT_TRUSTED_PUBLIC_KEYS_FILE) {
  console.error("--trusted-keys <json> obligatoire (ou SWEETCRAFT_TRUSTED_PUBLIC_KEYS_FILE)");
  process.exit(2);
}

try {
  const trustedKeys = await loadTrustedKeys({ file: keysPath, fromEnv: !keysPath });
  const r = await verifyOrigin({
    transactionDir: path.resolve(transaction),
    channel: channel as ReleaseChannel,
    trustedKeys
  });
  if (flag("--json")) {
    console.log(JSON.stringify(originVerifyToJson(r)));
  } else {
    console.log(formatOriginVerifyReport(r));
  }
  process.exit(0);
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  if (flag("--json")) {
    console.log(
      JSON.stringify({
        ok: false,
        error: msg,
        channel: channel ?? null
      })
    );
  } else {
    console.error(`ORIGIN_VERIFY_FAIL: ${msg}`);
  }
  process.exitCode = e instanceof OriginVerifyError ? 2 : 1;
}
