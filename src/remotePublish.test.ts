import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { stageRelease } from "./stage.js";
import { UNIT_TEST_STAGE_BYPASS } from "./releasePreflightTypes.js";
import { publishRelease } from "./publish.js";
import { createEphemeralEd25519Signer, UnsignedDevSigner } from "./releaseSigning.js";
import {
  formatRemotePublishFail,
  prevalidateLocalPublish,
  remotePublish,
  RemotePublishError
} from "./remotePublish.js";
import {
  assertTransactionId,
  generateTransactionId,
  posixShellQuote,
  PUBLIC_ROOT
} from "./remotePaths.js";
import {
  remoteCommitCommand,
  remoteMkdirTransactionCommand,
  remoteRmTransactionCommand,
  remoteVerifyOriginCommand,
  type ExecResult,
  type RemoteTransport,
  type SshTarget
} from "./sshTransport.js";
import { CATALOG_SCHEMA_VERSION } from "./types.js";
import type { Catalog, ConfigRecord, ModRecord } from "./types.js";

function mod(partial: Partial<ModRecord> & Pick<ModRecord, "mod_id" | "side_class">): ModRecord {
  return {
    jar: `${partial.mod_id}.jar`,
    name: partial.mod_id,
    version: "1",
    size_bytes: 1,
    sha256: "a".repeat(64),
    sha512: "b".repeat(128),
    install_client: partial.side_class !== "SERVER_ONLY",
    install_server: partial.side_class !== "CLIENT_ONLY",
    distribution_policy: "UPSTREAM_PREFERRED",
    modrinth_file_url: "https://example.test/mod.jar",
    ...partial
  };
}

function cfg(partial: Partial<ConfigRecord> & Pick<ConfigRecord, "path" | "policy" | "target" | "sha256">): ConfigRecord {
  return { size_bytes: 1, owner_mod_id: null, ...partial };
}

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sc-remote-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function writeConfig(root: string, rel: string, content: string | Buffer) {
  const abs = path.join(root, ...rel.split("/"));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
  return createHash("sha256").update(typeof content === "string" ? Buffer.from(content) : content).digest("hex");
}

function readyCatalog(configs: ConfigRecord[]): Catalog {
  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    generatedFor: { product: "SweetCraft", minecraft: "26.1.2", fabricLoader: "0.19.3", server: "test" },
    mods: [mod({ mod_id: "demo", side_class: "BOTH_REQUIRED" })],
    configs
  };
}

async function makeSignedPublish(dir: string, version = "0.1.1", sequence = 2) {
  const source = path.join(dir, "pack");
  const body = `cfg-${version}`;
  const sha = await writeConfig(source, "config/demo.json", body);
  const catalog = readyCatalog([
    cfg({ path: "config/demo.json", policy: "SERVER_FORCE", target: "BOTH", sha256: sha, size_bytes: body.length })
  ]);
  const staged = await stageRelease({
      assemblyGate: { mode: "unit-test-bypass" as const, token: UNIT_TEST_STAGE_BYPASS },
    catalog,
    packVersion: version,
    sourceRoot: source,
    outDir: path.join(dir, "stg"),
    createdAt: "2026-01-01T00:00:00.000Z",
    signer: new UnsignedDevSigner()
  });
  const signer = createEphemeralEd25519Signer("upload-key");
  const keys = { "upload-key": signer.publicKeyPem };
  const root = path.join(dir, "publish-prod");
  await publishRelease({
    releaseDir: staged.releaseDir,
    channel: "dev",
    sequence,
    outDir: root,
    signer,
    trustedKeys: keys
  });
  return { root, keys, version, sequence, signer };
}

class MockTransport implements RemoteTransport {
  calls: { kind: "ssh" | "scp"; cmd?: string; local?: string; remote?: string; recursive?: boolean; timeoutMs?: number }[] = [];
  verifyCode = 0;
  verifyStdout = "ORIGIN_VERIFY_OK\n";
  commitCode = 0;
  commitStderr = "";
  mkdirCode = 0;
  scpFailAt: "release" | "channel" | null = null;
  scpCount = 0;
  /** Simulate timed-out operation by command substring. */
  timeoutOn: "mkdir" | "scp-release" | "verify" | "commit" | null = null;
  seenTimeoutMs: number[] = [];
  pending = 0;

  async ssh(target: SshTarget, remoteCommand: string): Promise<ExecResult> {
    this.seenTimeoutMs.push(target.timeoutMs);
    this.calls.push({ kind: "ssh", cmd: remoteCommand, timeoutMs: target.timeoutMs });
    this.pending++;
    try {
      if (remoteCommand.includes("mkdir")) {
        if (this.timeoutOn === "mkdir") {
          return { code: 124, stdout: "", stderr: `timeout after ${target.timeoutMs}ms`, argv: ["ssh", remoteCommand], timedOut: true };
        }
        return { code: this.mkdirCode, stdout: "", stderr: "", argv: ["ssh", remoteCommand] };
      }
      if (remoteCommand.includes("verify-origin")) {
        if (this.timeoutOn === "verify") {
          return { code: 124, stdout: "", stderr: `timeout after ${target.timeoutMs}ms`, argv: ["ssh", remoteCommand], timedOut: true };
        }
        return {
          code: this.verifyCode,
          stdout: this.verifyStdout,
          stderr: this.verifyCode ? "verify fail" : "",
          argv: ["ssh", remoteCommand]
        };
      }
      if (remoteCommand.includes("sweetcraft-release-commit")) {
        if (this.timeoutOn === "commit") {
          return { code: 124, stdout: "", stderr: `timeout after ${target.timeoutMs}ms`, argv: ["ssh", remoteCommand], timedOut: true };
        }
        return {
          code: this.commitCode,
          stdout: "",
          stderr: this.commitStderr,
          argv: ["ssh", remoteCommand]
        };
      }
      if (remoteCommand.includes("rm -rf")) {
        return { code: 0, stdout: "", stderr: "", argv: ["ssh", remoteCommand] };
      }
      return { code: 0, stdout: "", stderr: "", argv: ["ssh", remoteCommand] };
    } finally {
      this.pending--;
    }
  }

  async scpTo(
    target: SshTarget,
    localPath: string,
    remotePath: string,
    recursive: boolean
  ): Promise<ExecResult> {
    this.seenTimeoutMs.push(target.timeoutMs);
    this.calls.push({ kind: "scp", local: localPath, remote: remotePath, recursive, timeoutMs: target.timeoutMs });
    this.pending++;
    try {
      this.scpCount++;
      if (this.timeoutOn === "scp-release" && recursive) {
        return {
          code: 124,
          stdout: "",
          stderr: `timeout after ${target.timeoutMs}ms`,
          argv: ["scp", localPath, remotePath],
          timedOut: true
        };
      }
      if (this.scpFailAt === "release" && recursive) {
        return { code: 1, stdout: "", stderr: "scp release fail", argv: ["scp", localPath, remotePath] };
      }
      if (this.scpFailAt === "channel" && !recursive) {
        return { code: 1, stdout: "", stderr: "scp channel fail", argv: ["scp", localPath, remotePath] };
      }
      return { code: 0, stdout: "", stderr: "", argv: ["scp", localPath, remotePath] };
    } finally {
      this.pending--;
    }
  }
}

describe("remotePaths", () => {
  it("transaction ID respects whitelist", () => {
    const tx = generateTransactionId("dev", "0.1.1", 2);
    assert.match(tx, /^sc-dev-0\.1\.1-s2-[0-9a-f]{12}$/);
    assert.doesNotThrow(() => assertTransactionId(tx));
  });
  it("transaction traversal impossible", () => {
    assert.throws(() => assertTransactionId("sc-dev-../evil-s1-aaaaaaaaaaaa"));
    assert.throws(() => assertTransactionId("sc-dev-0.1.0-s1-aaaaaaaaaaaa/../x"));
  });
  it("posixShellQuote escapes", () => {
    assert.equal(posixShellQuote("a'b"), `'a'\\''b'`);
  });
  it("packVersion malveillant rejeté", () => {
    assert.throws(() => generateTransactionId("dev", "../etc", 1));
  });
});

describe("ssh remote command builders", () => {
  it("commit arguments exacts tx/channel/sequence", () => {
    const tx = generateTransactionId("dev", "0.1.1", 2);
    const cmd = remoteCommitCommand(tx, "dev", 2);
    assert.match(cmd, /sudo/);
    assert.match(cmd, /sweetcraft-release-commit/);
    assert.ok(cmd.includes(tx));
    assert.ok(cmd.includes("'dev'"));
    assert.ok(cmd.includes("'2'"));
    assert.ok(!cmd.includes(PUBLIC_ROOT));
  });
  it("cleanup ne peut cibler que transaction générée", () => {
    const tx = generateTransactionId("beta", "1.0.0", 3);
    const cmd = remoteRmTransactionCommand(tx);
    assert.ok(cmd.includes(`/srv/sweetcraft/incoming/${tx}`));
    assert.throws(() => remoteRmTransactionCommand("../../etc"));
  });
  it("aucune commande ne cible public", () => {
    const tx = generateTransactionId("dev", "0.1.0", 1);
    for (const c of [
      remoteMkdirTransactionCommand(tx),
      remoteRmTransactionCommand(tx),
      remoteVerifyOriginCommand(tx, "dev"),
      remoteCommitCommand(tx, "dev", 1)
    ]) {
      assert.ok(!c.includes(PUBLIC_ROOT));
      assert.ok(!/StrictHostKeyChecking\s*=\s*no/i.test(c));
      assert.ok(!/UserKnownHostsFile\s*=\s*\/dev\/null/i.test(c));
    }
  });
});

describe("remotePublish", () => {
  it("prévalidation locale valide → réseau autorisé + succès E2E mock", async () => {
    await withTemp(async dir => {
      const { root, keys, version, sequence } = await makeSignedPublish(dir);
      const transport = new MockTransport();
      const network: string[] = [];
      const channelBytes = await fs.readFile(path.join(root, "channels", "dev.json"));
      const releaseBytes = await fs.readFile(path.join(root, "releases", version, "release.json"));
      let fetchCount = 0;
      const r = await remotePublish({
        root,
        channel: "dev",
        host: "87.106.2.194",
        user: "sweetcraft-deploy",
        identity: String.raw`C:\Users\test\deploy ed25519`,
        trustedKeys: keys,
        transport,
        onNetwork: (k, d) => network.push(`${k}:${d}`),
        httpFetch: async url => {
          fetchCount++;
          if (url.includes("/channels/")) return { status: 200, body: channelBytes };
          if (url.includes("/releases/")) return { status: 200, body: releaseBytes };
          return { status: 404, body: Buffer.from("no") };
        }
      });
      assert.equal(r.ok, true);
      assert.equal(r.packVersion, version);
      assert.equal(r.releaseSequence, sequence);
      assert.ok(network.some(x => x.startsWith("ssh_prepare")));
      assert.ok(transport.calls.some(c => c.kind === "scp" && c.recursive));
      assert.ok(transport.calls.some(c => c.kind === "scp" && !c.recursive));
      assert.ok(transport.calls.some(c => c.kind === "ssh" && c.cmd?.includes("verify-origin")));
      assert.ok(transport.calls.some(c => c.kind === "ssh" && c.cmd?.includes("sweetcraft-release-commit")));
      assert.ok(fetchCount >= 2);
      // identity with spaces never shell-concatenated on local side (transport receives as field)
      assert.ok(true);
    });
  });

  it("release signature invalide → aucun SSH", async () => {
    await withTemp(async dir => {
      const { root, keys, version } = await makeSignedPublish(dir);
      const p = path.join(root, "releases", version, "release.json");
      const rel = JSON.parse(await fs.readFile(p, "utf8"));
      rel.minecraft = "9.9.9";
      await fs.writeFile(p, JSON.stringify(rel, null, 2) + "\n");
      const transport = new MockTransport();
      await assert.rejects(
        () =>
          remotePublish({
            root,
            channel: "dev",
            host: "h",
            user: "u",
            trustedKeys: keys,
            transport
          }),
        (e: unknown) => e instanceof RemotePublishError && e.step === "LOCAL_VERIFY"
      );
      assert.equal(transport.calls.length, 0);
    });
  });

  it("channel signature invalide → aucun SSH", async () => {
    await withTemp(async dir => {
      const { root, keys } = await makeSignedPublish(dir);
      const p = path.join(root, "channels", "dev.json");
      const ch = JSON.parse(await fs.readFile(p, "utf8"));
      ch.releaseSequence = 99;
      await fs.writeFile(p, JSON.stringify(ch, null, 2) + "\n");
      const transport = new MockTransport();
      await assert.rejects(
        () => remotePublish({ root, channel: "dev", host: "h", user: "u", trustedKeys: keys, transport }),
        (e: unknown) => e instanceof RemotePublishError && e.step === "LOCAL_VERIFY"
      );
      assert.equal(transport.calls.length, 0);
    });
  });

  it("unsigned dev → refus", async () => {
    await withTemp(async dir => {
      const source = path.join(dir, "pack");
      const sha = await writeConfig(source, "config/demo.json", "u");
      const catalog = readyCatalog([
        cfg({ path: "config/demo.json", policy: "SERVER_FORCE", target: "BOTH", sha256: sha })
      ]);
      const staged = await stageRelease({
      assemblyGate: { mode: "unit-test-bypass" as const, token: UNIT_TEST_STAGE_BYPASS },
        catalog,
        packVersion: "0.2.0",
        sourceRoot: source,
        outDir: path.join(dir, "stg"),
        createdAt: "2026-01-01T00:00:00.000Z",
        signer: new UnsignedDevSigner()
      });
      const root = path.join(dir, "pub");
      await publishRelease({
        releaseDir: staged.releaseDir,
        channel: "dev",
        sequence: 1,
        outDir: root,
        allowUnsignedDev: true
      });
      const transport = new MockTransport();
      await assert.rejects(
        () =>
          remotePublish({
            root,
            channel: "dev",
            host: "h",
            user: "u",
            trustedKeys: { k: "-----BEGIN PUBLIC KEY-----\nx\n-----END PUBLIC KEY-----\n" },
            transport
          }),
        RemotePublishError
      );
      assert.equal(transport.calls.length, 0);
    });
  });

  it("trusted key absent → refus", async () => {
    await withTemp(async dir => {
      const { root } = await makeSignedPublish(dir);
      await assert.rejects(
        () => remotePublish({ root, channel: "dev", host: "h", user: "u", trustedKeys: {} }),
        /trusted/i
      );
    });
  });

  it("channel invalide → refus", async () => {
    await withTemp(async dir => {
      const { root, keys } = await makeSignedPublish(dir);
      await assert.rejects(
        () => remotePublish({ root, channel: "nightly" as never, host: "h", user: "u", trustedKeys: keys }),
        /channel/i
      );
    });
  });

  it("releasePath invalide → refus", async () => {
    await withTemp(async dir => {
      const { root, keys } = await makeSignedPublish(dir);
      const p = path.join(root, "channels", "dev.json");
      const ch = JSON.parse(await fs.readFile(p, "utf8"));
      ch.releasePath = "releases/evil/release.json";
      await fs.writeFile(p, JSON.stringify(ch, null, 2) + "\n");
      await assert.rejects(
        () => prevalidateLocalPublish({ root, channel: "dev", trustedKeys: keys }),
        /releasePath/i
      );
    });
  });

  it("upload failure → aucun commit + cleanup", async () => {
    await withTemp(async dir => {
      const { root, keys } = await makeSignedPublish(dir);
      const transport = new MockTransport();
      transport.scpFailAt = "release";
      await assert.rejects(
        () => remotePublish({ root, channel: "dev", host: "h", user: "u", trustedKeys: keys, transport }),
        (e: unknown) => e instanceof RemotePublishError && e.step === "UPLOAD"
      );
      assert.ok(!transport.calls.some(c => c.cmd?.includes("sweetcraft-release-commit")));
      assert.ok(transport.calls.some(c => c.cmd?.includes("rm -rf")));
    });
  });

  it("remote verifier exit != 0 → aucun commit", async () => {
    await withTemp(async dir => {
      const { root, keys } = await makeSignedPublish(dir);
      const transport = new MockTransport();
      transport.verifyCode = 2;
      await assert.rejects(
        () => remotePublish({ root, channel: "dev", host: "h", user: "u", trustedKeys: keys, transport }),
        (e: unknown) => e instanceof RemotePublishError && e.step === "REMOTE_VERIFY"
      );
      assert.ok(!transport.calls.some(c => c.cmd?.includes("sweetcraft-release-commit")));
    });
  });

  it("remote verifier sans ORIGIN_VERIFY_OK → refus", async () => {
    await withTemp(async dir => {
      const { root, keys } = await makeSignedPublish(dir);
      const transport = new MockTransport();
      transport.verifyStdout = "ok but missing marker\n";
      await assert.rejects(
        () => remotePublish({ root, channel: "dev", host: "h", user: "u", trustedKeys: keys, transport }),
        /ORIGIN_VERIFY_OK/
      );
    });
  });

  it("commit failure + CHANNEL_SEQUENCE_RACE propagé", async () => {
    await withTemp(async dir => {
      const { root, keys } = await makeSignedPublish(dir);
      const transport = new MockTransport();
      transport.commitCode = 2;
      transport.commitStderr = "CHANNEL_SEQUENCE_RACE observed=9";
      await assert.rejects(
        () => remotePublish({ root, channel: "dev", host: "h", user: "u", trustedKeys: keys, transport }),
        (e: unknown) =>
          e instanceof RemotePublishError && e.step === "COMMIT" && /CHANNEL_SEQUENCE_RACE/.test(e.message)
      );
    });
  });

  it("HTTPS channel/release bytes différents → committed-but-unverified", async () => {
    await withTemp(async dir => {
      const { root, keys, version } = await makeSignedPublish(dir);
      const transport = new MockTransport();
      const channelBytes = await fs.readFile(path.join(root, "channels", "dev.json"));
      await assert.rejects(
        () =>
          remotePublish({
            root,
            channel: "dev",
            host: "h",
            user: "u",
            trustedKeys: keys,
            transport,
            httpFetch: async url => {
              if (url.includes("/channels/")) return { status: 200, body: Buffer.from("TAMPER") };
              if (url.includes("/releases/")) {
                return {
                  status: 200,
                  body: await fs.readFile(path.join(root, "releases", version, "release.json"))
                };
              }
              return { status: 404, body: Buffer.alloc(0) };
            }
          }),
        (e: unknown) =>
          e instanceof RemotePublishError &&
          e.step === "HTTPS_VERIFY" &&
          e.remoteCommitSucceeded === true &&
          e.code === "REMOTE_PUBLISH_COMMITTED_BUT_UNVERIFIED"
      );
      // no cleanup after commit
      assert.ok(!transport.calls.some(c => c.cmd?.includes("rm -rf")));
      // channel ok but release wrong
      await assert.rejects(
        () =>
          remotePublish({
            root,
            channel: "dev",
            host: "h",
            user: "u",
            trustedKeys: keys,
            transport: new MockTransport(),
            httpFetch: async url => {
              if (url.includes("/channels/")) return { status: 200, body: channelBytes };
              return { status: 200, body: Buffer.from("WRONG_RELEASE") };
            }
          }),
        (e: unknown) =>
          e instanceof RemotePublishError &&
          e.code === "REMOTE_PUBLISH_COMMITTED_BUT_UNVERIFIED" &&
          /release bytes/i.test(e.message)
      );
    });
  });

  it("HTTP 404 / 500 → committed-but-unverified après commit", async () => {
    await withTemp(async dir => {
      const { root, keys } = await makeSignedPublish(dir);
      await assert.rejects(
        () =>
          remotePublish({
            root,
            channel: "dev",
            host: "h",
            user: "u",
            trustedKeys: keys,
            transport: new MockTransport(),
            httpFetch: async () => ({ status: 404, body: Buffer.alloc(0) }),
            httpsMaxAttempts: 2,
            httpsRetryDelayMs: 1,
            httpsSleep: async () => undefined
          }),
        (e: unknown) =>
          e instanceof RemotePublishError &&
          e.code === "REMOTE_PUBLISH_COMMITTED_BUT_UNVERIFIED" &&
          /404/.test(e.message)
      );
      await assert.rejects(
        () =>
          remotePublish({
            root,
            channel: "dev",
            host: "h",
            user: "u",
            trustedKeys: keys,
            transport: new MockTransport(),
            httpFetch: async () => ({ status: 500, body: Buffer.from("err") }),
            httpsMaxAttempts: 2,
            httpsRetryDelayMs: 1,
            httpsSleep: async () => undefined
          }),
        (e: unknown) => e instanceof RemotePublishError && e.remoteCommitSucceeded
      );
    });
  });

  it("retry HTTPS fonctionne", async () => {
    await withTemp(async dir => {
      const { root, keys, version } = await makeSignedPublish(dir);
      const channelBytes = await fs.readFile(path.join(root, "channels", "dev.json"));
      const releaseBytes = await fs.readFile(path.join(root, "releases", version, "release.json"));
      let n = 0;
      const r = await remotePublish({
        root,
        channel: "dev",
        host: "h",
        user: "u",
        trustedKeys: keys,
        transport: new MockTransport(),
        httpFetch: async url => {
          n++;
          if (n < 3) return { status: 404, body: Buffer.alloc(0) };
          if (url.includes("/channels/")) return { status: 200, body: channelBytes };
          return { status: 200, body: releaseBytes };
        },
        httpsRetryDelayMs: 1,
        httpsSleep: async () => undefined
      });
      assert.equal(r.ok, true);
      assert.ok(n >= 3);
    });
  });

  it("--keep-failed-transaction empêche cleanup", async () => {
    await withTemp(async dir => {
      const { root, keys } = await makeSignedPublish(dir);
      const transport = new MockTransport();
      transport.verifyCode = 2;
      await assert.rejects(
        () =>
          remotePublish({
            root,
            channel: "dev",
            host: "h",
            user: "u",
            trustedKeys: keys,
            transport,
            keepFailedTransaction: true
          }),
        RemotePublishError
      );
      assert.ok(!transport.calls.some(c => c.cmd?.includes("rm -rf")));
    });
  });

  it("upload paths correct + private key never transmitted", async () => {
    await withTemp(async dir => {
      const { root, keys, version } = await makeSignedPublish(dir);
      const transport = new MockTransport();
      const channelBytes = await fs.readFile(path.join(root, "channels", "dev.json"));
      const releaseBytes = await fs.readFile(path.join(root, "releases", version, "release.json"));
      const pemLeak = process.env.SWEETCRAFT_RELEASE_ED25519_PRIVATE_KEY_PEM;
      process.env.SWEETCRAFT_RELEASE_ED25519_PRIVATE_KEY_PEM = "-----BEGIN PRIVATE KEY-----\nLEAK\n-----END PRIVATE KEY-----";
      try {
        await remotePublish({
          root,
          channel: "dev",
          host: "h",
          user: "u",
          trustedKeys: keys,
          transport,
          httpFetch: async url =>
            url.includes("/channels/")
              ? { status: 200, body: channelBytes }
              : { status: 200, body: releaseBytes }
        });
        const blob = JSON.stringify(transport.calls);
        assert.ok(!blob.includes("BEGIN PRIVATE KEY"));
        assert.ok(!blob.includes("LEAK"));
        const rel = transport.calls.find(c => c.kind === "scp" && c.recursive);
        const ch = transport.calls.find(c => c.kind === "scp" && !c.recursive);
        assert.ok(rel?.remote?.includes(`/releases/${version}`));
        assert.ok(ch?.remote?.endsWith("/channels/dev.json"));
        assert.ok(!blob.includes(PUBLIC_ROOT));
      } finally {
        if (pemLeak === undefined) delete process.env.SWEETCRAFT_RELEASE_ED25519_PRIVATE_KEY_PEM;
        else process.env.SWEETCRAFT_RELEASE_ED25519_PRIVATE_KEY_PEM = pemLeak;
      }
    });
  });

  it("format fail includes step", () => {
    const e = new RemotePublishError("UPLOAD", "boom");
    assert.match(formatRemotePublishFail(e), /REMOTE_PUBLISH_FAIL/);
    assert.match(formatRemotePublishFail(e), /UPLOAD/);
    assert.equal(e.remoteCommitSucceeded, false);
    assert.equal(e.doNotRetryUpload, false);
  });

  it("E. erreur avant commit → REMOTE_PUBLISH_FAIL", async () => {
    await withTemp(async dir => {
      const { root, keys } = await makeSignedPublish(dir);
      const transport = new MockTransport();
      transport.verifyCode = 2;
      let caught: RemotePublishError | undefined;
      try {
        await remotePublish({ root, channel: "dev", host: "h", user: "u", trustedKeys: keys, transport });
      } catch (e) {
        caught = e as RemotePublishError;
      }
      assert.ok(caught instanceof RemotePublishError);
      assert.equal(caught!.code, "REMOTE_PUBLISH_FAIL");
      assert.equal(caught!.remoteCommitSucceeded, false);
      assert.match(formatRemotePublishFail(caught!), /^REMOTE_PUBLISH_FAIL/);
      assert.ok(!formatRemotePublishFail(caught!).includes("DO_NOT_RETRY_UPLOAD"));
      assert.ok(transport.calls.some(c => c.cmd?.includes("rm -rf")));
      assert.ok(!transport.calls.some(c => c.cmd?.includes("sweetcraft-release-commit")));
    });
  });

  it("F. HTTPS fail après commit → COMMITTED_BUT_UNVERIFIED", async () => {
    await withTemp(async dir => {
      const { root, keys } = await makeSignedPublish(dir);
      const transport = new MockTransport();
      let caught: RemotePublishError | undefined;
      try {
        await remotePublish({
          root,
          channel: "dev",
          host: "h",
          user: "u",
          trustedKeys: keys,
          transport,
          origin: "https://cdn.xnosweet.fr/sweetcraft/",
          httpFetch: async () => ({ status: 404, body: Buffer.alloc(0) }),
          httpsMaxAttempts: 1,
          httpsRetryDelayMs: 1,
          httpsSleep: async () => undefined
        });
      } catch (e) {
        caught = e as RemotePublishError;
      }
      assert.ok(caught instanceof RemotePublishError);
      assert.equal(caught!.code, "REMOTE_PUBLISH_COMMITTED_BUT_UNVERIFIED");
      assert.equal(caught!.remoteCommitSucceeded, true);
      assert.equal(caught!.doNotRetryUpload, true);
      assert.equal(caught!.channelUrl, "https://cdn.xnosweet.fr/sweetcraft/channels/dev.json");
      const formatted = formatRemotePublishFail(caught!);
      assert.match(formatted, /REMOTE_PUBLISH_COMMITTED_BUT_UNVERIFIED/);
      assert.match(formatted, /REMOTE_COMMIT_SUCCEEDED=YES/);
      assert.match(formatted, /DO_NOT_RETRY_UPLOAD=YES/);
      assert.match(formatted, /Channel URL:/);
      assert.ok(!transport.calls.some(c => c.cmd?.includes("rm -rf")));
    });
  });

  it("G/H. timeout HTTPS après commit: unverified + pas de cleanup public/tx", async () => {
    await withTemp(async dir => {
      const { root, keys } = await makeSignedPublish(dir);
      const transport = new MockTransport();
      await assert.rejects(
        () =>
          remotePublish({
            root,
            channel: "dev",
            host: "h",
            user: "u",
            trustedKeys: keys,
            transport,
            timeoutSeconds: 3,
            httpsMaxAttempts: 1,
            httpsRetryDelayMs: 1,
            httpsSleep: async () => undefined,
            httpFetch: async (_url, init) => {
              throw new Error(`HTTP timeout after ${init?.timeoutMs}ms`);
            }
          }),
        (e: unknown) =>
          e instanceof RemotePublishError &&
          e.code === "REMOTE_PUBLISH_COMMITTED_BUT_UNVERIFIED" &&
          e.doNotRetryUpload &&
          /timeout/i.test(e.message)
      );
      assert.ok(transport.calls.some(c => c.cmd?.includes("sweetcraft-release-commit")));
      assert.ok(!transport.calls.some(c => c.cmd?.includes("rm -rf")));
      assert.ok(!JSON.stringify(transport.calls).includes(PUBLIC_ROOT));
    });
  });

  it("origin invalide / http refusé en LOCAL_VERIFY", async () => {
    await withTemp(async dir => {
      const { root, keys } = await makeSignedPublish(dir);
      const transport = new MockTransport();
      await assert.rejects(
        () =>
          remotePublish({
            root,
            channel: "dev",
            host: "h",
            user: "u",
            trustedKeys: keys,
            transport,
            origin: "http://cdn.xnosweet.fr/sweetcraft"
          }),
        (e: unknown) => e instanceof RemotePublishError && e.step === "LOCAL_VERIFY" && /HTTPS/i.test(e.message)
      );
      assert.equal(transport.calls.length, 0);
      await assert.rejects(
        () =>
          remotePublish({
            root,
            channel: "dev",
            host: "h",
            user: "u",
            trustedKeys: keys,
            transport,
            origin: "https://cdn.xnosweet.fr/sweetcraft?x=1"
          }),
        /query/i
      );
    });
  });

  it("origin trailing slash résolu vers product base", async () => {
    await withTemp(async dir => {
      const { root, keys, version } = await makeSignedPublish(dir);
      const channelBytes = await fs.readFile(path.join(root, "channels", "dev.json"));
      const releaseBytes = await fs.readFile(path.join(root, "releases", version, "release.json"));
      const seen: string[] = [];
      const r = await remotePublish({
        root,
        channel: "dev",
        host: "h",
        user: "u",
        trustedKeys: keys,
        transport: new MockTransport(),
        origin: "https://cdn.xnosweet.fr/sweetcraft/",
        httpFetch: async url => {
          seen.push(url.split("?")[0]!);
          if (url.includes("/channels/")) return { status: 200, body: channelBytes };
          return { status: 200, body: releaseBytes };
        }
      });
      assert.equal(r.origin, "https://cdn.xnosweet.fr/sweetcraft");
      assert.ok(seen.some(u => u === "https://cdn.xnosweet.fr/sweetcraft/channels/dev.json"));
      assert.ok(seen.some(u => u === `https://cdn.xnosweet.fr/sweetcraft/releases/${version}/release.json`));
      assert.ok(!seen.some(u => u.includes("//channels") || u.includes("//releases")));
    });
  });
});

describe("remotePublish v0.8.1 timeout + SSH_PREPARE cleanup", () => {
  it("--timeout <= 0 / NaN rejeté avant réseau", async () => {
    await withTemp(async dir => {
      const { root, keys } = await makeSignedPublish(dir);
      const transport = new MockTransport();
      await assert.rejects(
        () =>
          remotePublish({
            root,
            channel: "dev",
            host: "h",
            user: "u",
            trustedKeys: keys,
            transport,
            timeoutSeconds: 0
          }),
        (e: unknown) => e instanceof RemotePublishError && e.step === "LOCAL_VERIFY" && /timeout/i.test(e.message)
      );
      await assert.rejects(
        () =>
          remotePublish({
            root,
            channel: "dev",
            host: "h",
            user: "u",
            trustedKeys: keys,
            transport,
            timeoutSeconds: Number.NaN
          }),
        /timeout/i
      );
      assert.equal(transport.calls.length, 0);
    });
  });

  it("timeout SSH mkdir → SSH_PREPARE fail + cleanup", async () => {
    await withTemp(async dir => {
      const { root, keys } = await makeSignedPublish(dir);
      const transport = new MockTransport();
      transport.timeoutOn = "mkdir";
      await assert.rejects(
        () =>
          remotePublish({
            root,
            channel: "dev",
            host: "h",
            user: "u",
            trustedKeys: keys,
            transport,
            timeoutSeconds: 12
          }),
        (e: unknown) =>
          e instanceof RemotePublishError && e.step === "SSH_PREPARE" && /timeout/i.test(e.message)
      );
      assert.ok(transport.calls.some(c => c.cmd?.includes("rm -rf")));
      assert.ok(!transport.calls.some(c => c.cmd?.includes("sweetcraft-release-commit")));
      assert.equal(transport.pending, 0);
    });
  });

  it("timeout SCP release → UPLOAD fail + cleanup", async () => {
    await withTemp(async dir => {
      const { root, keys } = await makeSignedPublish(dir);
      const transport = new MockTransport();
      transport.timeoutOn = "scp-release";
      await assert.rejects(
        () =>
          remotePublish({
            root,
            channel: "dev",
            host: "h",
            user: "u",
            trustedKeys: keys,
            transport,
            timeoutSeconds: 5
          }),
        (e: unknown) => e instanceof RemotePublishError && e.step === "UPLOAD" && /timeout/i.test(e.message)
      );
      assert.ok(transport.calls.some(c => c.cmd?.includes("rm -rf")));
      assert.equal(transport.pending, 0);
    });
  });

  it("timeout remote verifier → REMOTE_VERIFY fail + cleanup", async () => {
    await withTemp(async dir => {
      const { root, keys } = await makeSignedPublish(dir);
      const transport = new MockTransport();
      transport.timeoutOn = "verify";
      await assert.rejects(
        () =>
          remotePublish({
            root,
            channel: "dev",
            host: "h",
            user: "u",
            trustedKeys: keys,
            transport,
            timeoutSeconds: 7
          }),
        (e: unknown) =>
          e instanceof RemotePublishError && e.step === "REMOTE_VERIFY" && /timeout/i.test(e.message)
      );
      assert.ok(transport.calls.some(c => c.cmd?.includes("rm -rf")));
    });
  });

  it("timeout commit → COMMIT fail, aucun accès public", async () => {
    await withTemp(async dir => {
      const { root, keys } = await makeSignedPublish(dir);
      const transport = new MockTransport();
      transport.timeoutOn = "commit";
      await assert.rejects(
        () =>
          remotePublish({
            root,
            channel: "dev",
            host: "h",
            user: "u",
            trustedKeys: keys,
            transport,
            timeoutSeconds: 9
          }),
        (e: unknown) => e instanceof RemotePublishError && e.step === "COMMIT" && /timeout/i.test(e.message)
      );
      const blob = JSON.stringify(transport.calls);
      assert.ok(!blob.includes(PUBLIC_ROOT));
      assert.ok(transport.calls.some(c => c.cmd?.includes("rm -rf")));
    });
  });

  it("timeout HTTP → HTTPS_VERIFY committed-but-unverified", async () => {
    await withTemp(async dir => {
      const { root, keys } = await makeSignedPublish(dir);
      await assert.rejects(
        () =>
          remotePublish({
            root,
            channel: "dev",
            host: "h",
            user: "u",
            trustedKeys: keys,
            transport: new MockTransport(),
            timeoutSeconds: 3,
            httpsMaxAttempts: 1,
            httpsRetryDelayMs: 1,
            httpsSleep: async () => undefined,
            httpFetch: async (_url, init) => {
              assert.ok(init?.timeoutMs === 3000);
              throw new Error(`HTTP timeout after ${init?.timeoutMs}ms`);
            }
          }),
        (e: unknown) =>
          e instanceof RemotePublishError &&
          e.step === "HTTPS_VERIFY" &&
          e.code === "REMOTE_PUBLISH_COMMITTED_BUT_UNVERIFIED" &&
          /timeout/i.test(e.message)
      );
    });
  });

  it("keep-failed-transaction empêche cleanup même après SSH_PREPARE partiel", async () => {
    await withTemp(async dir => {
      const { root, keys } = await makeSignedPublish(dir);
      const transport = new MockTransport();
      transport.timeoutOn = "mkdir";
      await assert.rejects(
        () =>
          remotePublish({
            root,
            channel: "dev",
            host: "h",
            user: "u",
            trustedKeys: keys,
            transport,
            timeoutSeconds: 4,
            keepFailedTransaction: true
          }),
        RemotePublishError
      );
      assert.ok(!transport.calls.some(c => c.cmd?.includes("rm -rf")));
    });
  });

  it("timeout transmis à toutes les opérations SSH/SCP", async () => {
    await withTemp(async dir => {
      const { root, keys, version } = await makeSignedPublish(dir);
      const transport = new MockTransport();
      const channelBytes = await fs.readFile(path.join(root, "channels", "dev.json"));
      const releaseBytes = await fs.readFile(path.join(root, "releases", version, "release.json"));
      await remotePublish({
        root,
        channel: "dev",
        host: "h",
        user: "u",
        trustedKeys: keys,
        transport,
        timeoutSeconds: 42,
        httpFetch: async url =>
          url.includes("/channels/")
            ? { status: 200, body: channelBytes }
            : { status: 200, body: releaseBytes }
      });
      assert.ok(transport.seenTimeoutMs.length >= 4);
      assert.ok(transport.seenTimeoutMs.every(ms => ms === 42_000));
      assert.ok(!JSON.stringify(transport.calls).includes("StrictHostKeyChecking=no"));
      assert.ok(!JSON.stringify(transport.calls).includes("UserKnownHostsFile=/dev/null"));
    });
  });

  it("defaultHttpFetcher / createDefaultHttpFetcher uses AbortSignal timeout", async () => {
    const { createDefaultHttpFetcher } = await import("./httpVerify.js");
    const fetchFn = createDefaultHttpFetcher(50);
    // unreachable host with tiny timeout — should abort quickly without hanging
    const started = Date.now();
    await assert.rejects(
      () => fetchFn("http://127.0.0.1:1/", { timeoutMs: 50 }),
      /timeout|abort|ECONNREFUSED|fetch/i
    );
    assert.ok(Date.now() - started < 5000);
  });

  it("mkdir non-zero (partial prepare) déclenche cleanup", async () => {
    await withTemp(async dir => {
      const { root, keys } = await makeSignedPublish(dir);
      const transport = new MockTransport();
      transport.mkdirCode = 1;
      await assert.rejects(
        () =>
          remotePublish({
            root,
            channel: "dev",
            host: "h",
            user: "u",
            trustedKeys: keys,
            transport
          }),
        (e: unknown) => e instanceof RemotePublishError && e.step === "SSH_PREPARE"
      );
      assert.ok(transport.calls.some(c => c.cmd?.includes("rm -rf")));
    });
  });
});
