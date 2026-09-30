/**
 * Production-sign canonical staging data/releases/0.1.3 (sequence 4).
 * LOCAL ONLY — no publish, channel, upload, SSH, CDN, commit.
 *
 * Private key loaded into process env only; never logged/printed/copied to repo.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signStagedRelease } from "../src/signRelease.js";
import { verifyRelease } from "../src/verifyRelease.js";
import {
  EnvEd25519Signer,
  createEphemeralEd25519Signer,
  type TrustedKeys
} from "../src/releaseSigning.js";
import { RELEASE_SIGNING_PAYLOAD_ID } from "../src/releasePayload.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE_DIR = path.join(ROOT, "data", "releases", "0.1.3");
const REPORT_DIR = path.join(ROOT, "data", "candidates", "0.1.3-seq4-NONPUBLISHABLE");
const PUBLISH_012 = path.join(ROOT, "data", "publish-0.1.2");
const CLEAN =
  process.env.SWEETCRAFT_CLEAN_ROOT ??
  path.resolve(ROOT, "..", "..", "MODPACK FINAL CLEAN");
const PRIV_PATH =
  process.env.SWEETCRAFT_RELEASE_PRIVATE_KEY_FILE ??
  "C:\\Users\\kevin\\.sweetcraft\\signing\\release-2026-01-ed25519.pem";
const PUB_PATH =
  process.env.SWEETCRAFT_RELEASE_PUBLIC_KEY_FILE ??
  "C:\\Users\\kevin\\.sweetcraft\\signing\\release-2026-01-ed25519-public.pem";
const KEY_ID = "sweetcraft-release-2026-01";
const PACK_VERSION = "0.1.3";
const SEQUENCE = 4;

function sha256buf(b: Buffer): string {
  return createHash("sha256").update(b).digest("hex");
}

async function sha256file(p: string): Promise<string> {
  return sha256buf(await fs.readFile(p));
}

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
  return out.sort((a, b) => a.localeCompare(b));
}

async function fingerprintTree(root: string, exclude: Set<string> = new Set()): Promise<string> {
  const lines: string[] = [];
  for (const abs of await listFiles(root)) {
    const rel = path.relative(root, abs).split(path.sep).join("/");
    if (exclude.has(rel)) continue;
    const st = await fs.lstat(abs);
    if (st.isSymbolicLink()) {
      lines.push(`SYMLINK\t${rel}`);
      continue;
    }
    lines.push(`${await sha256file(abs)}\t${st.size}\t${rel}`);
  }
  return lines.join("\n") + "\n";
}

async function fingerprintCleanMods(cleanRoot: string): Promise<string> {
  const lines: string[] = [];
  for (const side of ["client", "server"] as const) {
    const dir = path.join(cleanRoot, side, "mods");
    const jars = (await fs.readdir(dir)).filter(f => f.toLowerCase().endsWith(".jar")).sort();
    for (const j of jars) {
      const abs = path.join(dir, j);
      const st = await fs.stat(abs);
      lines.push(`${side}\t${j}\t${st.size}\t${await sha256file(abs)}`);
    }
  }
  return lines.join("\n") + "\n";
}

async function copyDir(src: string, dest: string): Promise<void> {
  await fs.rm(dest, { recursive: true, force: true });
  await fs.mkdir(dest, { recursive: true });
  for (const abs of await listFiles(src)) {
    const rel = path.relative(src, abs);
    const d = path.join(dest, rel);
    await fs.mkdir(path.dirname(d), { recursive: true });
    await fs.copyFile(abs, d);
  }
}

async function secretScan(roots: string[]): Promise<{ status: "PASS" | "FINDING"; findings: { path: string; type: string }[] }> {
  const findings: { path: string; type: string }[] = [];
  for (const root of roots) {
    let files: string[] = [];
    try {
      files = await listFiles(root);
    } catch {
      continue;
    }
    for (const abs of files) {
      const rel = path.relative(ROOT, abs).split(path.sep).join("/");
      if (/\.pem$/i.test(rel)) findings.push({ path: rel, type: "PEM_FILE" });
      let text: string;
      try {
        const buf = await fs.readFile(abs);
        if (buf.length > 1_500_000 || (buf.includes(0) && !rel.endsWith(".json"))) continue;
        text = buf.toString("utf8");
      } catch {
        continue;
      }
      if (/BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/.test(text)) {
        findings.push({ path: rel, type: "BEGIN_PRIVATE_KEY" });
      }
      if (/CURSEFORGE_API_KEY\s*=\s*\S+/.test(text)) {
        findings.push({ path: rel, type: "CURSEFORGE_API_KEY_ASSIGNMENT" });
      }
    }
  }
  return { status: findings.length ? "FINDING" : "PASS", findings };
}

async function main() {
  const blockers: string[] = [];
  await fs.mkdir(REPORT_DIR, { recursive: true });

  // --- D private key presence (boolean only) ---
  let privateKeyPresent = false;
  let privateKeyRegularFile = false;
  let privateKeyReadable = false;
  try {
    const st = await fs.stat(PRIV_PATH);
    privateKeyPresent = true;
    privateKeyRegularFile = st.isFile();
    const fh = await fs.open(PRIV_PATH, "r");
    await fh.close();
    privateKeyReadable = true;
  } catch {
    privateKeyPresent = false;
  }
  if (!privateKeyPresent || !privateKeyRegularFile || !privateKeyReadable) {
    blockers.push("production private key missing/unreadable");
  }

  let publicPem: string;
  try {
    publicPem = await fs.readFile(PUB_PATH, "utf8");
    if (!publicPem.includes("BEGIN PUBLIC KEY") || publicPem.includes("PRIVATE KEY")) {
      blockers.push("public key PEM invalid");
      publicPem = "";
    }
  } catch {
    blockers.push("public key file missing");
    publicPem = "";
  }

  const trustedKeys: TrustedKeys = publicPem ? { [KEY_ID]: publicPem } : {};

  // Repo must not contain pem
  const repoPems = (await listFiles(ROOT)).filter(f => f.toLowerCase().endsWith(".pem"));
  if (repoPems.length) blockers.push(`repo contains .pem files: ${repoPems.length}`);

  // --- A fingerprints BEFORE ---
  const fpReleaseBefore = await fingerprintTree(RELEASE_DIR);
  const fpPayloadBefore = await fingerprintTree(RELEASE_DIR, new Set(["release.json"]));
  const fpPublish012Before = await fingerprintTree(PUBLISH_012);
  const fpCleanBefore = await fingerprintCleanMods(CLEAN);
  await fs.writeFile(path.join(REPORT_DIR, "sign-0.1.3.release.fingerprint.before.txt"), fpReleaseBefore);
  await fs.writeFile(path.join(REPORT_DIR, "sign-0.1.3.payload.fingerprint.before.txt"), fpPayloadBefore);
  await fs.writeFile(path.join(REPORT_DIR, "sign-0.1.3.publish012.fingerprint.before.txt"), fpPublish012Before);
  await fs.writeFile(path.join(REPORT_DIR, "sign-0.1.3.CLEAN.mods.fingerprint.before.txt"), fpCleanBefore);

  const clientShaBefore = await sha256file(path.join(RELEASE_DIR, "client-manifest.json"));
  const serverShaBefore = await sha256file(path.join(RELEASE_DIR, "server-manifest.json"));
  const checksumsBefore = await fs.readFile(path.join(RELEASE_DIR, "checksums.json"));
  const checksumsShaBefore = sha256buf(checksumsBefore);

  // --- C pre-sign verify ---
  const preVerify = await verifyRelease({
    releaseDir: RELEASE_DIR,
    trustedKeys,
    allowUnsignedDev: true
  });
  const releasePre = JSON.parse(await fs.readFile(path.join(RELEASE_DIR, "release.json"), "utf8")) as {
    schemaVersion: number;
    packVersion: string;
    manifestSchemaVersion: number;
    antiRollback: { releaseSequence: number | null };
    signature: { status: string };
  };
  if (!preVerify.ok) blockers.push(`pre-sign verify fail: ${preVerify.errors.join("; ")}`);
  if (preVerify.signature !== "UNSIGNED_DEV") blockers.push(`pre-sign expected UNSIGNED_DEV got ${preVerify.signature}`);
  if (preVerify.publishableStable) blockers.push("pre-sign unexpectedly publishable");
  if (releasePre.packVersion !== PACK_VERSION) blockers.push("packVersion mismatch");
  if (releasePre.antiRollback.releaseSequence !== SEQUENCE) blockers.push("sequence mismatch");
  if (releasePre.schemaVersion !== 2) blockers.push("release schema mismatch");
  if (releasePre.manifestSchemaVersion !== 6) blockers.push("manifest schema mismatch");

  if (blockers.length) {
    const report = { verdict: "RELEASE_0.1.3_SIGNING_BLOCKED", blockers, privateKeyPresent };
    await fs.writeFile(path.join(REPORT_DIR, "RELEASE_0.1.3_SIGNED_REPORT.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 2;
    return;
  }

  // --- E load key into env WITHOUT logging ---
  const prevPem = process.env.SWEETCRAFT_RELEASE_ED25519_PRIVATE_KEY_PEM;
  const prevId = process.env.SWEETCRAFT_RELEASE_PUBLIC_KEY_ID;
  try {
    process.env.SWEETCRAFT_RELEASE_ED25519_PRIVATE_KEY_PEM = await fs.readFile(PRIV_PATH, "utf8");
    process.env.SWEETCRAFT_RELEASE_PUBLIC_KEY_ID = KEY_ID;

    const signed = await signStagedRelease({
      releaseDir: RELEASE_DIR,
      signer: new EnvEd25519Signer(),
      trustedKeys,
      expectPackVersion: PACK_VERSION,
      expectReleaseSequence: SEQUENCE
    });

    // Clear env ASAP
    if (prevPem === undefined) delete process.env.SWEETCRAFT_RELEASE_ED25519_PRIVATE_KEY_PEM;
    else process.env.SWEETCRAFT_RELEASE_ED25519_PRIVATE_KEY_PEM = prevPem;
    if (prevId === undefined) delete process.env.SWEETCRAFT_RELEASE_PUBLIC_KEY_ID;
    else process.env.SWEETCRAFT_RELEASE_PUBLIC_KEY_ID = prevId;

    // --- F payload stability ---
    const fpPayloadAfter = await fingerprintTree(RELEASE_DIR, new Set(["release.json"]));
    const clientShaAfter = await sha256file(path.join(RELEASE_DIR, "client-manifest.json"));
    const serverShaAfter = await sha256file(path.join(RELEASE_DIR, "server-manifest.json"));
    const checksumsAfter = await fs.readFile(path.join(RELEASE_DIR, "checksums.json"));
    const payloadEqual = fpPayloadBefore === fpPayloadAfter;
    const manifestsEqual =
      clientShaBefore === clientShaAfter && serverShaBefore === serverShaAfter;
    const checksumsEqual = checksumsBefore.equals(checksumsAfter);

    const releasePost = JSON.parse(await fs.readFile(path.join(RELEASE_DIR, "release.json"), "utf8")) as {
      signature: { status: string; algorithm: string; publicKeyId: string; payload: string; value: string };
      antiRollback: { releaseSequence: number };
      packVersion: string;
      schemaVersion: number;
      artefacts: { checksums: { sha256: string } };
    };

    // --- G post verify ---
    const postVerify = await verifyRelease({
      releaseDir: RELEASE_DIR,
      trustedKeys,
      allowUnsignedDev: false
    });

    // --- H negative tests on TEMP copies ---
    const neg: Record<string, boolean> = {};
    async function withTamperCopy(
      name: string,
      mutate: (dir: string) => Promise<void>,
      keys: TrustedKeys = trustedKeys
    ): Promise<boolean> {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `sc-sign-neg-${name}-`));
      try {
        await copyDir(RELEASE_DIR, tmp);
        await mutate(tmp);
        const v = await verifyRelease({ releaseDir: tmp, trustedKeys: keys, allowUnsignedDev: false });
        return !v.ok || v.signature === "FAIL" || !v.publishableStable;
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    }

    neg.validPass = (
      await verifyRelease({ releaseDir: RELEASE_DIR, trustedKeys, allowUnsignedDev: false })
    ).ok;

    neg.packVersionTamper = await withTamperCopy("pv", async dir => {
      const p = path.join(dir, "release.json");
      const j = JSON.parse(await fs.readFile(p, "utf8"));
      j.packVersion = "9.9.9";
      await fs.writeFile(p, JSON.stringify(j, null, 2));
    });

    neg.sequenceTamper = await withTamperCopy("seq", async dir => {
      const p = path.join(dir, "release.json");
      const j = JSON.parse(await fs.readFile(p, "utf8"));
      j.antiRollback.releaseSequence = 99;
      await fs.writeFile(p, JSON.stringify(j, null, 2));
    });

    neg.checksumsTamper = await withTamperCopy("cks", async dir => {
      const p = path.join(dir, "checksums.json");
      const j = JSON.parse(await fs.readFile(p, "utf8"));
      j.entries[0].sha256 = "0".repeat(64);
      await fs.writeFile(p, JSON.stringify(j, null, 2));
    });

    neg.clientManifestTamper = await withTamperCopy("cm", async dir => {
      const p = path.join(dir, "client-manifest.json");
      const j = JSON.parse(await fs.readFile(p, "utf8"));
      j.mods[0].size = (j.mods[0].size || 1) + 1;
      await fs.writeFile(p, JSON.stringify(j, null, 2));
    });

    neg.serverManifestTamper = await withTamperCopy("sm", async dir => {
      const p = path.join(dir, "server-manifest.json");
      const j = JSON.parse(await fs.readFile(p, "utf8"));
      j.mods[0].size = (j.mods[0].size || 1) + 1;
      await fs.writeFile(p, JSON.stringify(j, null, 2));
    });

    neg.jarTamper = await withTamperCopy("jar", async dir => {
      const jar = path.join(dir, "files", "mods", "fallen-1.3.0+mc26.1.2.jar");
      const b = await fs.readFile(jar);
      await fs.writeFile(jar, Buffer.concat([b, Buffer.from("X")]));
    });

    neg.rpTamper = await withTamperCopy("rp", async dir => {
      const rp = path.join(dir, "files", "resourcepacks", "SweetCraft-FR-v2.7-DETAIL-PASS.zip");
      const b = await fs.readFile(rp);
      await fs.writeFile(rp, Buffer.concat([b, Buffer.from("Y")]));
    });

    const wrong = createEphemeralEd25519Signer("sweetcraft-release-2026-01");
    neg.wrongKey = await withTamperCopy(
      "wrongkey",
      async () => {},
      { [KEY_ID]: wrong.publicKeyPem }
    );

    neg.unknownKeyId = await withTamperCopy(
      "unkid",
      async () => {},
      { "other-key-id": publicPem }
    );

    neg.removedSignature = await withTamperCopy("nosig", async dir => {
      const p = path.join(dir, "release.json");
      const j = JSON.parse(await fs.readFile(p, "utf8"));
      j.signature = {
        status: "unsigned-dev",
        algorithm: "ed25519",
        publicKeyId: null,
        payload: RELEASE_SIGNING_PAYLOAD_ID,
        value: null,
        signer: "unsigned-dev"
      };
      await fs.writeFile(p, JSON.stringify(j, null, 2));
      // allowUnsigned false → should fail
    });

    neg.signatureTamper = await withTamperCopy("sigtamper", async dir => {
      const p = path.join(dir, "release.json");
      const j = JSON.parse(await fs.readFile(p, "utf8"));
      const v = Buffer.from(j.signature.value, "base64");
      v[0] = v[0]! ^ 0xff;
      j.signature.value = v.toString("base64");
      await fs.writeFile(p, JSON.stringify(j, null, 2));
    });

    // Final canonical reverify
    const finalVerify = await verifyRelease({
      releaseDir: RELEASE_DIR,
      trustedKeys,
      allowUnsignedDev: false
    });

    // Fileset checks
    const onDisk = (await listFiles(RELEASE_DIR)).map(a =>
      path.relative(RELEASE_DIR, a).split(path.sep).join("/")
    );
    const mods = onDisk.filter(f => f.startsWith("files/mods/"));
    const providerPhysical = mods.length; // should be 3 hosted only
    const hasPem = onDisk.some(f => f.toLowerCase().endsWith(".pem"));
    const hasHidden = onDisk.some(f => f.split("/").some(p => p.startsWith(".")));

    // Immutability after
    const fpPublish012After = await fingerprintTree(PUBLISH_012);
    const fpCleanAfter = await fingerprintCleanMods(CLEAN);
    const fpPayloadFinal = await fingerprintTree(RELEASE_DIR, new Set(["release.json"]));

    const sec = await secretScan([RELEASE_DIR, REPORT_DIR]);
    // Source/test markers (fake PEM / env name assignments) are not release leaks.
    // Confirmed separately: no *.pem under repo release tree.

    const negAllOk = Object.entries(neg).every(([k, v]) => (k === "validPass" ? v === true : v === true));

    const allBlockers = [
      ...(payloadEqual ? [] : ["payload files changed"]),
      ...(manifestsEqual ? [] : ["manifest hashes changed"]),
      ...(checksumsEqual ? [] : ["checksums changed"]),
      ...(postVerify.ok && postVerify.signature === "SIGNED_OK" ? [] : ["post-sign verify fail"]),
      ...(postVerify.publishableStable ? [] : ["not publishable"]),
      ...(finalVerify.ok && finalVerify.publishableStable ? [] : ["final reverify fail"]),
      ...(negAllOk ? [] : [`negative tests failed: ${JSON.stringify(neg)}`]),
      ...(fpPublish012Before === fpPublish012After ? [] : ["0.1.2 mutated"]),
      ...(fpCleanBefore === fpCleanAfter ? [] : ["CLEAN mutated"]),
      ...(fpPayloadFinal === fpPayloadBefore ? [] : ["payload drift after negatives"]),
      ...(releasePost.signature.publicKeyId === KEY_ID ? [] : ["publicKeyId mismatch"]),
      ...(releasePost.signature.payload === RELEASE_SIGNING_PAYLOAD_ID ? [] : ["payload id mismatch"]),
      ...(mods.length === 3 ? [] : [`hosted jar count=${mods.length}`]),
      ...(hasPem ? ["pem in release"] : []),
      ...(hasHidden ? ["hidden file in release"] : []),
      ...(sec.status === "PASS" ? [] : [`secret findings=${sec.findings.length}`]),
      ...(signed.publicKeyId === KEY_ID ? [] : ["signer key id mismatch"])
    ];

    const verdict =
      allBlockers.length === 0 ? "RELEASE_0.1.3_SIGNED_READY" : "RELEASE_0.1.3_SIGNING_BLOCKED";

    const report = {
      verdict,
      blockers: allBlockers,
      unsignedSource: RELEASE_DIR,
      signedArtifact: RELEASE_DIR,
      packVersion: releasePost.packVersion,
      releaseSequence: releasePost.antiRollback.releaseSequence,
      manifestSchema: 6,
      releaseSchema: releasePost.schemaVersion,
      channelSchemaImpact: "none — no channel written",
      privateKeyPresent: true,
      signingImplementation: "signStagedRelease + EnvEd25519Signer + SWEETCRAFT-RELEASE-SIGNATURE-V1",
      signatureAlgorithm: releasePost.signature.algorithm,
      publicKeyId: releasePost.signature.publicKeyId,
      signingPayloadProtocol: RELEASE_SIGNING_PAYLOAD_ID,
      preSignVerify: {
        ok: preVerify.ok,
        signature: preVerify.signature,
        publishableStable: preVerify.publishableStable
      },
      postSignVerify: {
        ok: postVerify.ok,
        signature: postVerify.signature,
        publishableStable: postVerify.publishableStable
      },
      publishable: postVerify.publishableStable,
      equality: {
        clientManifest: clientShaBefore === clientShaAfter,
        serverManifest: serverShaBefore === serverShaAfter,
        checksums: checksumsEqual,
        filesPayload: payloadEqual,
        clientSha: clientShaBefore,
        serverSha: serverShaBefore,
        checksumsSha: checksumsShaBefore
      },
      hostedJars: mods,
      providerPhysicalJarCount: providerPhysical === 3 ? 0 : providerPhysical - 3,
      resourcePackIntegrity: onDisk.includes(
        "files/resourcepacks/SweetCraft-FR-v2.7-DETAIL-PASS.zip"
      ),
      strictFileset: !hasPem && !hasHidden && mods.length === 3,
      negativeTests: neg,
      finalReverify: {
        ok: finalVerify.ok,
        signature: finalVerify.signature,
        publishableStable: finalVerify.publishableStable
      },
      security: sec,
      immutability: {
        clean: fpCleanBefore === fpCleanAfter,
        publish012: fpPublish012Before === fpPublish012After
      },
      NO_PROTOCOL_CHANGE: true
    };

    await fs.writeFile(
      path.join(REPORT_DIR, "RELEASE_0.1.3_SIGNED_REPORT.json"),
      JSON.stringify(report, null, 2)
    );
    // Ensure report does not accidentally contain private key path contents — only booleans/paths
    console.log(JSON.stringify(report, null, 2));
    if (verdict !== "RELEASE_0.1.3_SIGNED_READY") process.exitCode = 2;
  } catch (e) {
    if (prevPem === undefined) delete process.env.SWEETCRAFT_RELEASE_ED25519_PRIVATE_KEY_PEM;
    else process.env.SWEETCRAFT_RELEASE_ED25519_PRIVATE_KEY_PEM = prevPem;
    if (prevId === undefined) delete process.env.SWEETCRAFT_RELEASE_PUBLIC_KEY_ID;
    else process.env.SWEETCRAFT_RELEASE_PUBLIC_KEY_ID = prevId;
    throw e;
  } finally {
    // Belt-and-suspenders clear
    if (process.env.SWEETCRAFT_RELEASE_ED25519_PRIVATE_KEY_PEM && prevPem === undefined) {
      delete process.env.SWEETCRAFT_RELEASE_ED25519_PRIVATE_KEY_PEM;
    }
  }
}

main().catch(e => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
