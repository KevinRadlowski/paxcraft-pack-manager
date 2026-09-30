/**
 * Re-verify already-signed data/releases/0.1.3 and rewrite SIGNED report
 * without re-signing (fail-closed if still unsigned).
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyRelease } from "../src/verifyRelease.js";
import { RELEASE_SIGNING_PAYLOAD_ID } from "../src/releasePayload.js";
import type { TrustedKeys } from "../src/releaseSigning.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE_DIR = path.join(ROOT, "data", "releases", "0.1.3");
const REPORT_DIR = path.join(ROOT, "data", "candidates", "0.1.3-seq4-NONPUBLISHABLE");
const PUB_PATH = "C:\\Users\\kevin\\.sweetcraft\\signing\\release-2026-01-ed25519-public.pem";
const KEY_ID = "sweetcraft-release-2026-01";

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string) {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (e.isFile()) out.push(abs);
    }
  }
  await walk(dir);
  return out;
}

async function secretScanReleaseAndReports(): Promise<{
  status: "PASS" | "FINDING";
  findings: { path: string; type: string }[];
}> {
  const findings: { path: string; type: string }[] = [];
  for (const root of [RELEASE_DIR, REPORT_DIR]) {
    for (const abs of await listFiles(root)) {
      const rel = path.relative(ROOT, abs).split(path.sep).join("/");
      if (/\.pem$/i.test(rel)) findings.push({ path: rel, type: "PEM_FILE" });
      const buf = await fs.readFile(abs);
      if (buf.length > 2_000_000 || buf.includes(0)) continue;
      const text = buf.toString("utf8");
      if (/BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/.test(text)) {
        findings.push({ path: rel, type: "BEGIN_PRIVATE_KEY" });
      }
    }
  }
  return { status: findings.length ? "FINDING" : "PASS", findings };
}

async function main() {
  const publicPem = await fs.readFile(PUB_PATH, "utf8");
  const trustedKeys: TrustedKeys = { [KEY_ID]: publicPem };
  const v = await verifyRelease({
    releaseDir: RELEASE_DIR,
    trustedKeys,
    allowUnsignedDev: false
  });
  const release = JSON.parse(await fs.readFile(path.join(RELEASE_DIR, "release.json"), "utf8"));
  const onDisk = (await listFiles(RELEASE_DIR)).map(a =>
    path.relative(RELEASE_DIR, a).split(path.sep).join("/")
  );
  const mods = onDisk.filter(f => f.startsWith("files/mods/"));
  const sec = await secretScanReleaseAndReports();

  const prev = JSON.parse(
    await fs.readFile(path.join(REPORT_DIR, "RELEASE_0.1.3_SIGNED_REPORT.json"), "utf8")
  );

  const blockers: string[] = [];
  if (!v.ok || v.signature !== "SIGNED_OK") blockers.push("verify fail");
  if (!v.publishableStable) blockers.push("not publishable");
  if (release.signature?.status !== "signed") blockers.push("not signed");
  if (release.signature?.publicKeyId !== KEY_ID) blockers.push("key id");
  if (release.signature?.payload !== RELEASE_SIGNING_PAYLOAD_ID) blockers.push("payload id");
  if (mods.length !== 3) blockers.push("mods count");
  if (sec.status !== "PASS") blockers.push(`secret: ${sec.findings.map(f => f.type + "@" + f.path).join(",")}`);
  if (onDisk.some(f => f.toLowerCase().endsWith(".pem"))) blockers.push("pem in release");

  const report = {
    ...prev,
    verdict: blockers.length ? "RELEASE_0.1.3_SIGNING_BLOCKED" : "RELEASE_0.1.3_SIGNED_READY",
    blockers,
    security: sec,
    finalReverify: {
      ok: v.ok,
      signature: v.signature,
      publishableStable: v.publishableStable
    },
    note: "Report refreshed after scoped secret scan (release+reports only). Signing already applied."
  };
  await fs.writeFile(
    path.join(REPORT_DIR, "RELEASE_0.1.3_SIGNED_REPORT.json"),
    JSON.stringify(report, null, 2)
  );
  console.log(JSON.stringify(report, null, 2));
  if (report.verdict !== "RELEASE_0.1.3_SIGNED_READY") process.exitCode = 2;
}

main().catch(e => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
