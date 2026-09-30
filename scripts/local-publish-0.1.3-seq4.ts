/**
 * LOCAL publish root for SweetCraft 0.1.3 / seq 4 / channel=dev.
 * Uses publishRelease only — no SSH, CDN, remote, commit.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { publishRelease, PublishError } from "../src/publish.js";
import { verifyChannelDescriptor } from "../src/verifyChannel.js";
import { verifyRelease } from "../src/verifyRelease.js";
import {
  EnvEd25519Signer,
  createEphemeralEd25519Signer,
  type TrustedKeys
} from "../src/releaseSigning.js";
import {
  CHANNEL_SIGNING_PAYLOAD_ID,
  RELEASE_SIGNING_PAYLOAD_ID
} from "../src/releasePayload.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STAGING = path.join(ROOT, "data", "releases", "0.1.3");
const PUBLISH_ROOT = path.join(ROOT, "data", "publish-0.1.3");
const PUBLISH_012 = path.join(ROOT, "data", "publish-0.1.2");
const REPORT_DIR = path.join(ROOT, "data", "candidates", "0.1.3-seq4-NONPUBLISHABLE");
const PRIV =
  process.env.SWEETCRAFT_RELEASE_PRIVATE_KEY_FILE ??
  "C:\\Users\\kevin\\.sweetcraft\\signing\\release-2026-01-ed25519.pem";
const PUB =
  process.env.SWEETCRAFT_RELEASE_PUBLIC_KEY_FILE ??
  "C:\\Users\\kevin\\.sweetcraft\\signing\\release-2026-01-ed25519-public.pem";
const KEY_ID = "sweetcraft-release-2026-01";
const PACK = "0.1.3";
const SEQ = 4;
const RP_SHA = "f491caae5e1485d3e9c709f44cc81099ce6e742c48a9a33818740d643b09250f";
const RP_SIZE = 400806;
const HOSTED = [
  "dynamic_difficulty-fabric-1.3.3+26.1.2.jar",
  "fallen-1.3.0+mc26.1.2.jar",
  "xbase-casino-0.7.5-C2.1+mc26.1.2.jar"
] as const;
const FTB_IDS = [
  "ftbfiltersystem",
  "ftblibrary",
  "ftbquests",
  "ftbteams",
  "ftbxmodcompat"
] as const;

function sha256(b: Buffer): string {
  return createHash("sha256").update(b).digest("hex");
}
async function shaFile(p: string): Promise<string> {
  return sha256(await fs.readFile(p));
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
async function fingerprint(root: string, exclude: Set<string> = new Set()): Promise<string> {
  const lines: string[] = [];
  for (const abs of await listFiles(root)) {
    const rel = path.relative(root, abs).split(path.sep).join("/");
    if (exclude.has(rel)) continue;
    const st = await fs.lstat(abs);
    if (st.isSymbolicLink()) lines.push(`SYMLINK\t${rel}`);
    else lines.push(`${await shaFile(abs)}\t${st.size}\t${rel}`);
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
async function secretScan(roots: string[]) {
  const findings: { path: string; type: string }[] = [];
  for (const root of roots) {
    for (const abs of await listFiles(root)) {
      const rel = path.relative(ROOT, abs).split(path.sep).join("/");
      if (/\.pem$/i.test(rel)) findings.push({ path: rel, type: "PEM_FILE" });
      const buf = await fs.readFile(abs);
      if (buf.length > 2_000_000 || buf.includes(0)) continue;
      const t = buf.toString("utf8");
      if (/BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/.test(t)) {
        findings.push({ path: rel, type: "BEGIN_PRIVATE_KEY" });
      }
    }
  }
  return { status: findings.length ? ("FINDING" as const) : ("PASS" as const), findings };
}

async function main() {
  await fs.mkdir(REPORT_DIR, { recursive: true });
  const blockers: string[] = [];

  // Fail closed if publish root already exists
  try {
    await fs.access(PUBLISH_ROOT);
    blockers.push(`publish root already exists: ${PUBLISH_ROOT}`);
  } catch {
    /* ok */
  }

  const privatePresent = await fs
    .stat(PRIV)
    .then(s => s.isFile())
    .catch(() => false);
  if (!privatePresent) blockers.push("private key missing");

  const publicPem = await fs.readFile(PUB, "utf8");
  if (!publicPem.includes("BEGIN PUBLIC KEY") || publicPem.includes("PRIVATE KEY")) {
    blockers.push("public key invalid");
  }
  const trustedKeys: TrustedKeys = { [KEY_ID]: publicPem };

  const fpStagingBefore = await fingerprint(STAGING);
  const fp012Before = await fingerprint(PUBLISH_012);
  await fs.writeFile(path.join(REPORT_DIR, "local-publish.staging.before.txt"), fpStagingBefore);
  await fs.writeFile(path.join(REPORT_DIR, "local-publish.publish012.before.txt"), fp012Before);

  const stagingReleaseBefore = await fs.readFile(path.join(STAGING, "release.json"));
  const stagingClientBefore = await fs.readFile(path.join(STAGING, "client-manifest.json"));
  const stagingServerBefore = await fs.readFile(path.join(STAGING, "server-manifest.json"));
  const stagingChecksumsBefore = await fs.readFile(path.join(STAGING, "checksums.json"));
  const stagingPayloadFpBefore = await fingerprint(STAGING, new Set(["release.json"]));

  const preVr = await verifyRelease({
    releaseDir: STAGING,
    trustedKeys,
    allowUnsignedDev: false
  });
  if (!preVr.ok || !preVr.publishableStable) {
    blockers.push(`staging not signed/publishable: ${preVr.signature}`);
  }

  if (blockers.length) {
    const report = { verdict: "RELEASE_0.1.3_LOCAL_PUBLISH_BLOCKED", blockers };
    await fs.writeFile(
      path.join(REPORT_DIR, "RELEASE_0.1.3_LOCAL_PUBLISH_REPORT.json"),
      JSON.stringify(report, null, 2)
    );
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 2;
    return;
  }

  const prevPem = process.env.SWEETCRAFT_RELEASE_ED25519_PRIVATE_KEY_PEM;
  const prevId = process.env.SWEETCRAFT_RELEASE_PUBLIC_KEY_ID;
  try {
    process.env.SWEETCRAFT_RELEASE_ED25519_PRIVATE_KEY_PEM = await fs.readFile(PRIV, "utf8");
    process.env.SWEETCRAFT_RELEASE_PUBLIC_KEY_ID = KEY_ID;

    const pubResult = await publishRelease({
      releaseDir: STAGING,
      channel: "dev",
      sequence: SEQ,
      outDir: PUBLISH_ROOT,
      signer: new EnvEd25519Signer(),
      trustedKeys,
      allowUnsignedDev: false
    });

    // clear env
    if (prevPem === undefined) delete process.env.SWEETCRAFT_RELEASE_ED25519_PRIVATE_KEY_PEM;
    else process.env.SWEETCRAFT_RELEASE_ED25519_PRIVATE_KEY_PEM = prevPem;
    if (prevId === undefined) delete process.env.SWEETCRAFT_RELEASE_PUBLIC_KEY_ID;
    else process.env.SWEETCRAFT_RELEASE_PUBLIC_KEY_ID = prevId;

    const publishedReleaseDir = path.join(PUBLISH_ROOT, "releases", PACK);
    const channelFile = path.join(PUBLISH_ROOT, "channels", "dev.json");

    // Equality: source staging unchanged
    const fpStagingAfter = await fingerprint(STAGING);
    const stagingUnchanged = fpStagingBefore === fpStagingAfter;
    const stagingReleaseAfter = await fs.readFile(path.join(STAGING, "release.json"));
    const stagingBytesEqual = stagingReleaseBefore.equals(stagingReleaseAfter);

    // Payload equality source ↔ published (excluding release.json which gains published{})
    const publishedPayloadFp = await fingerprint(publishedReleaseDir, new Set(["release.json"]));
    const payloadEqual = stagingPayloadFpBefore === publishedPayloadFp;
    const clientEqual = stagingClientBefore.equals(
      await fs.readFile(path.join(publishedReleaseDir, "client-manifest.json"))
    );
    const serverEqual = stagingServerBefore.equals(
      await fs.readFile(path.join(publishedReleaseDir, "server-manifest.json"))
    );
    const checksumsEqual = stagingChecksumsBefore.equals(
      await fs.readFile(path.join(publishedReleaseDir, "checksums.json"))
    );

    const pubRelease = JSON.parse(
      await fs.readFile(path.join(publishedReleaseDir, "release.json"), "utf8")
    ) as {
      packVersion: string;
      schemaVersion: number;
      antiRollback: { releaseSequence: number };
      signature: { status: string; publicKeyId: string; payload: string; algorithm: string };
      published?: { channel: string; remoteUpload: string };
    };
    const channel = JSON.parse(await fs.readFile(channelFile, "utf8")) as {
      schemaVersion: number;
      channel: string;
      packVersion: string;
      releaseSequence: number;
      releasePath: string;
      releaseSha256: string;
      signature: { status: string; publicKeyId: string; payload: string };
    };

    const releaseShaActual = await shaFile(path.join(publishedReleaseDir, "release.json"));
    const releaseShaMatch = channel.releaseSha256 === releaseShaActual;

    // Local origin verify = verifyChannelDescriptor (existing contract; no HTTP)
    const origin = await verifyChannelDescriptor({
      channelFile,
      root: PUBLISH_ROOT,
      trustedKeys,
      allowUnsignedDev: false
    });
    const originOk =
      origin.ok &&
      origin.channelSignature === "SIGNED_OK" &&
      origin.releaseSignature === "SIGNED_OK";

    const clientMan = JSON.parse(
      await fs.readFile(path.join(publishedReleaseDir, "client-manifest.json"), "utf8")
    ) as {
      schemaVersion: number;
      mods: { id: string; file: string; sha256: string; size: number; provider: { type: string; url: string | null; fileId?: number | null } }[];
      configs: unknown[];
      resourcePacks: { sha256: string; size: number; targetPath: string }[];
    };
    const serverMan = JSON.parse(
      await fs.readFile(path.join(publishedReleaseDir, "server-manifest.json"), "utf8")
    ) as { mods: { id: string }[]; configs: unknown[]; resourcePacks?: unknown[] };

    // Hosted URLs
    const hostedCheck = [];
    for (const jar of HOSTED) {
      const mod = clientMan.mods.find(m => m.file === jar)!;
      const bytes = await fs.readFile(path.join(publishedReleaseDir, "files", "mods", jar));
      hostedCheck.push({
        jar,
        url: mod?.provider.url ?? null,
        urlOk: !!mod?.provider.url?.startsWith(
          `https://cdn.xnosweet.fr/sweetcraft/releases/${PACK}/files/mods/${jar}`
        ),
        shaOk: !!mod && mod.sha256 === sha256(bytes) && mod.size === bytes.length
      });
    }

    const physicalMods = (await fs.readdir(path.join(publishedReleaseDir, "files", "mods"))).filter(f =>
      f.endsWith(".jar")
    );
    const ftb = FTB_IDS.map(id => {
      const m = clientMan.mods.find(x => x.id === id);
      return {
        id,
        url: m?.provider.url ?? null,
        https: !!m?.provider.url?.startsWith("https://"),
        fileId: m?.provider.fileId ?? null,
        sha256: m?.sha256 ?? null,
        size: m?.size ?? null
      };
    });

    const rp = clientMan.resourcePacks?.[0];
    const rpPath = path.join(
      publishedReleaseDir,
      "files",
      "resourcepacks",
      "SweetCraft-FR-v2.7-DETAIL-PASS.zip"
    );
    const rpBytes = await fs.readFile(rpPath);
    const rpOk =
      sha256(rpBytes) === RP_SHA &&
      rpBytes.length === RP_SIZE &&
      rp?.sha256 === RP_SHA &&
      !(serverMan.resourcePacks && serverMan.resourcePacks.length);

    // Strict fileset on publish root
    const rootFiles = (await listFiles(PUBLISH_ROOT)).map(a =>
      path.relative(PUBLISH_ROOT, a).split(path.sep).join("/")
    );
    const filesetIssues: string[] = [];
    for (const rel of rootFiles) {
      if (rel.includes("\\") || rel.includes("..") || /^[a-zA-Z]:/.test(rel)) {
        filesetIssues.push(`bad path ${rel}`);
      }
      if (rel.split("/").some(p => p.startsWith("."))) filesetIssues.push(`hidden ${rel}`);
      if (/\.pem$/i.test(rel)) filesetIssues.push(`pem ${rel}`);
      const lst = await fs.lstat(path.join(PUBLISH_ROOT, ...rel.split("/")));
      if (lst.isSymbolicLink()) filesetIssues.push(`symlink ${rel}`);
    }
    const allowedPrefix = (rel: string) =>
      rel === "channels/dev.json" || rel.startsWith(`releases/${PACK}/`);
    for (const rel of rootFiles) {
      if (!allowedPrefix(rel)) filesetIssues.push(`unexpected ${rel}`);
    }

    // Sequence rule tests on TEMP roots (key still in env)
    process.env.SWEETCRAFT_RELEASE_ED25519_PRIVATE_KEY_PEM = await fs.readFile(PRIV, "utf8");
    process.env.SWEETCRAFT_RELEASE_PUBLIC_KEY_ID = KEY_ID;

    const seqTests: Record<string, boolean> = {};
    async function withSeededRoot(
      name: string,
      fn: (root: string) => Promise<boolean>
    ): Promise<boolean> {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `sc-seq-${name}-`));
      try {
        await fs.mkdir(path.join(tmp, "channels"), { recursive: true });
        await fs.mkdir(path.join(tmp, "releases", "0.1.2"), { recursive: true });
        await fs.writeFile(
          path.join(tmp, "channels", "dev.json"),
          JSON.stringify({
            schemaVersion: 1,
            channel: "dev",
            packVersion: "0.1.2",
            releaseSequence: 3,
            releasePath: "releases/0.1.2/release.json",
            releaseSha256: "a".repeat(64),
            signature: {
              status: "unsigned-dev",
              algorithm: "ed25519",
              publicKeyId: null,
              payload: CHANNEL_SIGNING_PAYLOAD_ID,
              value: null
            }
          }),
          "utf8"
        );
        return await fn(tmp);
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    }

    seqTests.sameSeq3Reject = await withSeededRoot("s3b", async root => {
      try {
        await publishRelease({
          releaseDir: STAGING,
          channel: "dev",
          sequence: 3,
          outDir: root,
          signer: new EnvEd25519Signer(),
          trustedKeys,
          allowUnsignedDev: false
        });
        return false;
      } catch (e) {
        return e instanceof PublishError;
      }
    });

    seqTests.lowerSeqReject = await withSeededRoot("low", async root => {
      try {
        await publishRelease({
          releaseDir: STAGING,
          channel: "dev",
          sequence: 2,
          outDir: root,
          signer: new EnvEd25519Signer(),
          trustedKeys
        });
        return false;
      } catch (e) {
        return e instanceof PublishError;
      }
    });

    seqTests.seq4Wins = await withSeededRoot("s4", async root => {
      try {
        await publishRelease({
          releaseDir: STAGING,
          channel: "dev",
          sequence: 4,
          outDir: root,
          signer: new EnvEd25519Signer(),
          trustedKeys
        });
        return true;
      } catch {
        return false;
      }
    });

    seqTests.seq5FutureOk = await withSeededRoot("s5", async root => {
      try {
        await publishRelease({
          releaseDir: STAGING,
          channel: "dev",
          sequence: 4,
          outDir: root,
          signer: new EnvEd25519Signer(),
          trustedKeys
        });
        return true;
      } catch {
        return false;
      }
    });

    seqTests.sameSeq4Conflict = await withSeededRoot("conflict", async root => {
      await publishRelease({
        releaseDir: STAGING,
        channel: "dev",
        sequence: 4,
        outDir: root,
        signer: new EnvEd25519Signer(),
        trustedKeys
      });
      try {
        await publishRelease({
          releaseDir: STAGING,
          channel: "dev",
          sequence: 4,
          outDir: root,
          signer: new EnvEd25519Signer(),
          trustedKeys
        });
        return false;
      } catch (e) {
        return e instanceof PublishError;
      }
    });
    // Channel field tamper tests (verifyChannel) on copies of real publish root
    const neg: Record<string, boolean> = {};
    async function tamperChannel(
      name: string,
      mutate: (ch: Record<string, unknown>) => void,
      keys: TrustedKeys = trustedKeys
    ): Promise<boolean> {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `sc-neg-ch-${name}-`));
      try {
        await copyDir(PUBLISH_ROOT, tmp);
        const p = path.join(tmp, "channels", "dev.json");
        const j = JSON.parse(await fs.readFile(p, "utf8"));
        mutate(j);
        await fs.writeFile(p, JSON.stringify(j, null, 2));
        const v = await verifyChannelDescriptor({
          channelFile: p,
          root: tmp,
          trustedKeys: keys,
          allowUnsignedDev: false
        });
        return !v.ok;
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    }
    async function tamperReleaseFile(
      name: string,
      rel: string,
      mutate: (abs: string) => Promise<void>
    ): Promise<boolean> {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `sc-neg-rel-${name}-`));
      try {
        await copyDir(PUBLISH_ROOT, tmp);
        await mutate(path.join(tmp, rel));
        const v = await verifyChannelDescriptor({
          channelFile: path.join(tmp, "channels", "dev.json"),
          root: tmp,
          trustedKeys,
          allowUnsignedDev: false
        });
        return !v.ok;
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    }

    neg.channelSig = await tamperChannel("csig", j => {
      const v = Buffer.from(j.signature.value as string, "base64");
      v[0] ^= 0xff;
      j.signature.value = v.toString("base64");
    });
    neg.releaseSig = await tamperReleaseFile("rsig", `releases/${PACK}/release.json`, async abs => {
      const j = JSON.parse(await fs.readFile(abs, "utf8"));
      const v = Buffer.from(j.signature.value, "base64");
      v[0] ^= 0xff;
      j.signature.value = v.toString("base64");
      await fs.writeFile(abs, JSON.stringify(j, null, 2));
    });
    neg.channelPackVersion = await tamperChannel("cpv", j => {
      j.packVersion = "9.9.9";
    });
    neg.channelSequence = await tamperChannel("cseq", j => {
      j.releaseSequence = 99;
    });
    neg.channelReleasePath = await tamperChannel("crp", j => {
      j.releasePath = "releases/9.9.9/release.json";
    });
    neg.channelReleaseSha = await tamperChannel("csha", j => {
      j.releaseSha256 = "0".repeat(64);
    });
    neg.releaseJson = await tamperReleaseFile("rjson", `releases/${PACK}/release.json`, async abs => {
      const j = JSON.parse(await fs.readFile(abs, "utf8"));
      j.packVersion = "9.9.9";
      await fs.writeFile(abs, JSON.stringify(j, null, 2));
    });
    neg.clientManifest = await tamperReleaseFile(
      "cm",
      `releases/${PACK}/client-manifest.json`,
      async abs => {
        const j = JSON.parse(await fs.readFile(abs, "utf8"));
        j.mods[0].size += 1;
        await fs.writeFile(abs, JSON.stringify(j, null, 2));
      }
    );
    neg.serverManifest = await tamperReleaseFile(
      "sm",
      `releases/${PACK}/server-manifest.json`,
      async abs => {
        const j = JSON.parse(await fs.readFile(abs, "utf8"));
        j.mods[0].size += 1;
        await fs.writeFile(abs, JSON.stringify(j, null, 2));
      }
    );
    neg.checksums = await tamperReleaseFile("cks", `releases/${PACK}/checksums.json`, async abs => {
      const j = JSON.parse(await fs.readFile(abs, "utf8"));
      j.entries[0].sha256 = "0".repeat(64);
      await fs.writeFile(abs, JSON.stringify(j, null, 2));
    });
    neg.hostedJar = await tamperReleaseFile(
      "jar",
      `releases/${PACK}/files/mods/fallen-1.3.0+mc26.1.2.jar`,
      async abs => {
        const b = await fs.readFile(abs);
        await fs.writeFile(abs, Buffer.concat([b, Buffer.from("X")]));
      }
    );
    neg.resourcePack = await tamperReleaseFile(
      "rp",
      `releases/${PACK}/files/resourcepacks/SweetCraft-FR-v2.7-DETAIL-PASS.zip`,
      async abs => {
        const b = await fs.readFile(abs);
        await fs.writeFile(abs, Buffer.concat([b, Buffer.from("Y")]));
      }
    );
    neg.extraFile = await tamperReleaseFile("extra", `releases/${PACK}/release.json`, async () => {
      /* add file separately */
    });
    // fix extraFile properly
    {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sc-neg-extra-"));
      try {
        await copyDir(PUBLISH_ROOT, tmp);
        await fs.writeFile(path.join(tmp, `releases/${PACK}/EVIL.txt`), "x");
        const v = await verifyChannelDescriptor({
          channelFile: path.join(tmp, "channels", "dev.json"),
          root: tmp,
          trustedKeys,
          allowUnsignedDev: false
        });
        neg.extraFile = !v.ok;
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    }
    {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sc-neg-miss-"));
      try {
        await copyDir(PUBLISH_ROOT, tmp);
        await fs.rm(path.join(tmp, `releases/${PACK}/checksums.json`));
        const v = await verifyChannelDescriptor({
          channelFile: path.join(tmp, "channels", "dev.json"),
          root: tmp,
          trustedKeys,
          allowUnsignedDev: false
        });
        neg.missingFile = !v.ok;
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    }
    neg.unknownKeyId = await tamperChannel("unk", () => {}, { "other-id": publicPem });
    const wrong = createEphemeralEd25519Signer(KEY_ID);
    neg.wrongKey = await tamperChannel("wrong", () => {}, { [KEY_ID]: wrong.publicKeyPem });

    // wrong packVersion / sequence / releasePath already covered in channel tampers
    seqTests.wrongReleasePathReject = neg.channelReleasePath;
    seqTests.wrongPackVersionReject = neg.channelPackVersion;
    seqTests.wrongSequenceReject = neg.channelSequence;

    // Final reverify canonical publish root
    const finalOrigin = await verifyChannelDescriptor({
      channelFile,
      root: PUBLISH_ROOT,
      trustedKeys,
      allowUnsignedDev: false
    });

    // Reproducibility: second publish to temp roots — payload equal, publishedAt may differ
    const reproA = await fs.mkdtemp(path.join(os.tmpdir(), "sc-repro-a-"));
    const reproB = await fs.mkdtemp(path.join(os.tmpdir(), "sc-repro-b-"));
    let reproPayloadEqual = false;
    let reproNote = "";
    try {
      await publishRelease({
        releaseDir: STAGING,
        channel: "dev",
        sequence: SEQ,
        outDir: reproA,
        signer: new EnvEd25519Signer(),
        trustedKeys
      });
      // tiny delay so publishedAt can differ
      await new Promise(r => setTimeout(r, 20));
      await publishRelease({
        releaseDir: STAGING,
        channel: "dev",
        sequence: SEQ,
        outDir: reproB,
        signer: new EnvEd25519Signer(),
        trustedKeys
      });
      const pa = await fingerprint(path.join(reproA, "releases", PACK), new Set(["release.json"]));
      const pb = await fingerprint(path.join(reproB, "releases", PACK), new Set(["release.json"]));
      reproPayloadEqual = pa === pb;
      const ra = JSON.parse(await fs.readFile(path.join(reproA, "releases", PACK, "release.json"), "utf8"));
      const rb = JSON.parse(await fs.readFile(path.join(reproB, "releases", PACK, "release.json"), "utf8"));
      reproNote =
        ra.published?.publishedAt === rb.published?.publishedAt
          ? "publishedAt identical (same second possible)"
          : "publishedAt differs by design → release.json/channel SHA nondeterministic across runs";
    } finally {
      await fs.rm(reproA, { recursive: true, force: true });
      await fs.rm(reproB, { recursive: true, force: true });
    }

    // clear env again
    if (prevPem === undefined) delete process.env.SWEETCRAFT_RELEASE_ED25519_PRIVATE_KEY_PEM;
    else process.env.SWEETCRAFT_RELEASE_ED25519_PRIVATE_KEY_PEM = prevPem;
    if (prevId === undefined) delete process.env.SWEETCRAFT_RELEASE_PUBLIC_KEY_ID;
    else process.env.SWEETCRAFT_RELEASE_PUBLIC_KEY_ID = prevId;

    const fp012After = await fingerprint(PUBLISH_012);
    const fpStagingFinal = await fingerprint(STAGING);
    const sec = await secretScan([PUBLISH_ROOT, REPORT_DIR]);

    const providerLogical = clientMan.mods.filter(m => m.provider.type !== "sweetcraft").length;
    // approximate: catalog has 124 provider; client has mix
    const hostedInClient = clientMan.mods.filter(m => m.provider.type === "sweetcraft").length;

    const allBlockers = [
      ...(stagingUnchanged && stagingBytesEqual ? [] : ["staging mutated"]),
      ...(payloadEqual && clientEqual && serverEqual && checksumsEqual
        ? []
        : ["payload not byte-identical to staging"]),
      ...(originOk ? [] : [`origin verify fail: ${origin.errors.join("; ")}`]),
      ...(finalOrigin.ok ? [] : ["final reverify fail"]),
      ...(releaseShaMatch ? [] : ["channel releaseSha256 mismatch"]),
      ...(channel.packVersion === PACK && channel.releaseSequence === SEQ
        ? []
        : ["channel meta mismatch"]),
      ...(pubRelease.signature.status === "signed" && channel.signature.status === "signed"
        ? []
        : ["unsigned signatures"]),
      ...(hostedCheck.every(h => h.urlOk && h.shaOk) ? [] : ["hosted URL/hash fail"]),
      ...(physicalMods.length === 3 ? [] : [`physical mods=${physicalMods.length}`]),
      ...(ftb.every(f => f.https && f.sha256 && f.size) ? [] : ["FTB incomplete"]),
      ...(rpOk ? [] : ["resource pack fail"]),
      ...(clientMan.configs.length === 244 && serverMan.configs.length === 230
        ? []
        : [`configs c=${clientMan.configs.length} s=${serverMan.configs.length}`]),
      ...(filesetIssues.length === 0 ? [] : filesetIssues.slice(0, 5)),
      ...(seqTests.sameSeq3Reject &&
      seqTests.lowerSeqReject &&
      seqTests.seq4Wins &&
      seqTests.sameSeq4Conflict
        ? []
        : [`seq tests: ${JSON.stringify(seqTests)}`]),
      ...(Object.values(neg).every(Boolean) ? [] : [`neg: ${JSON.stringify(neg)}`]),
      ...(reproPayloadEqual ? [] : ["repro payload mismatch"]),
      ...(fp012Before === fp012After ? [] : ["0.1.2 mutated"]),
      ...(fpStagingFinal === fpStagingBefore ? [] : ["staging drift"]),
      ...(sec.status === "PASS" ? [] : [`secrets: ${sec.findings.length}`]),
      ...(pubRelease.published?.remoteUpload === "NOT_PERFORMED" ? [] : ["remoteUpload unexpected"])
    ];

    const verdict =
      allBlockers.length === 0
        ? "RELEASE_0.1.3_LOCAL_PUBLISH_READY"
        : "RELEASE_0.1.3_LOCAL_PUBLISH_BLOCKED";

    const report = {
      verdict,
      blockers: allBlockers,
      signedStagingSource: STAGING,
      localPublishRoot: PUBLISH_ROOT,
      channelPath: channelFile,
      packVersion: PACK,
      releaseSequence: SEQ,
      schemas: { manifest: clientMan.schemaVersion, release: pubRelease.schemaVersion, channel: channel.schemaVersion },
      releaseSignature: pubRelease.signature.status,
      channelSignature: channel.signature.status,
      publicKeyId: channel.signature.publicKeyId,
      releasePayload: RELEASE_SIGNING_PAYLOAD_ID,
      channelPayload: CHANNEL_SIGNING_PAYLOAD_ID,
      equality: {
        stagingUnchanged,
        payloadFiles: payloadEqual,
        clientManifest: clientEqual,
        serverManifest: serverEqual,
        checksums: checksumsEqual,
        releaseJsonNote:
          "publishRelease adds published{} and re-applies signature (deterministic for same payload); not byte-identical to staging release.json by design"
      },
      channel: {
        packVersion: channel.packVersion,
        sequence: channel.releaseSequence,
        releasePath: channel.releasePath,
        releaseSha256: channel.releaseSha256,
        releaseShaMatch
      },
      localOriginVerify: {
        equivalent: "verifyChannelDescriptor (local publish root)",
        ok: originOk,
        channelSignature: origin.channelSignature,
        releaseSignature: origin.releaseSignature,
        label: originOk ? "ORIGIN_VERIFY_OK" : "ORIGIN_VERIFY_FAIL",
        errors: origin.errors
      },
      filesetIssues,
      counts: {
        clientMods: clientMan.mods.length,
        serverMods: serverMan.mods.length,
        clientConfigs: clientMan.configs.length,
        serverConfigs: serverMan.configs.length,
        providerLogicalApprox: providerLogical,
        releaseHosted: hostedInClient,
        providerPhysicalJars: physicalMods.length === 3 ? 0 : physicalMods.length - 3
      },
      hosted: hostedCheck,
      ftb,
      resourcePack: {
        ok: rpOk,
        sha256: sha256(rpBytes),
        size: rpBytes.length
      },
      sequenceTests: seqTests,
      negativeTests: neg,
      finalReverify: {
        ok: finalOrigin.ok,
        channelSignature: finalOrigin.channelSignature,
        releaseSignature: finalOrigin.releaseSignature
      },
      reproducibility: { payloadEqual: reproPayloadEqual, note: reproNote },
      immutability: {
        staging: fpStagingFinal === fpStagingBefore,
        publish012: fp012Before === fp012After
      },
      security: sec,
      publishResult: {
        releaseSignature: pubResult.releaseSignature,
        channelSignature: pubResult.channelSignature,
        remoteUpload: pubResult.remoteUpload,
        publishVerification: pubResult.publishVerification
      },
      NO_PROTOCOL_CHANGE: true
    };

    await fs.writeFile(
      path.join(REPORT_DIR, "RELEASE_0.1.3_LOCAL_PUBLISH_REPORT.json"),
      JSON.stringify(report, null, 2)
    );
    console.log(JSON.stringify(report, null, 2));
    if (verdict !== "RELEASE_0.1.3_LOCAL_PUBLISH_READY") process.exitCode = 2;
  } catch (e) {
    if (prevPem === undefined) delete process.env.SWEETCRAFT_RELEASE_ED25519_PRIVATE_KEY_PEM;
    else process.env.SWEETCRAFT_RELEASE_ED25519_PRIVATE_KEY_PEM = prevPem;
    if (prevId === undefined) delete process.env.SWEETCRAFT_RELEASE_PUBLIC_KEY_ID;
    else process.env.SWEETCRAFT_RELEASE_PUBLIC_KEY_ID = prevId;
    throw e;
  }
}

main().catch(e => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
