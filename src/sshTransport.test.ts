import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildScpArgv } from "./sshTransport.js";
import { assertNoForbiddenSshOpts } from "./remotePaths.js";
import type { SshTarget } from "./sshTransport.js";

function baseTarget(partial: Partial<SshTarget> = {}): SshTarget {
  return {
    host: "87.106.2.194",
    user: "sweetcraft-deploy",
    port: 22,
    timeoutMs: 60_000,
    ...partial
  };
}

describe("buildScpArgv — SEC-04.6 legacy SCP (-O)", () => {
  it("1. always includes -O (legacy SCP protocol)", () => {
    const args = buildScpArgv(baseTarget(), "/local/release", "/srv/sweetcraft/incoming/tx/releases", true);
    assert.ok(args.includes("-O"));
  });

  it("2. uses -P for port (not -p)", () => {
    const args = buildScpArgv(baseTarget({ port: 2222 }), "a", "b", false);
    assert.ok(args.includes("-P"));
    assert.equal(args[args.indexOf("-P") + 1], "2222");
    assert.equal(args.includes("-p"), false);
  });

  it("3. BatchMode=yes present by default", () => {
    const args = buildScpArgv(baseTarget(), "a", "b", false);
    const i = args.indexOf("-o");
    assert.ok(i >= 0);
    assert.equal(args[i + 1], "BatchMode=yes");
  });

  it("4. identity via -i when set", () => {
    const id = "C:\\Users\\kevin\\.ssh\\sweetcraft\\deploy_ed25519";
    const args = buildScpArgv(baseTarget({ identity: id }), "a", "b", false);
    const i = args.indexOf("-i");
    assert.ok(i >= 0);
    assert.equal(args[i + 1], id);
  });

  it("5. recursive=true keeps -r", () => {
    const args = buildScpArgv(baseTarget(), "a", "b", true);
    assert.ok(args.includes("-r"));
  });

  it("6. recursive=false does not add -r", () => {
    const args = buildScpArgv(baseTarget(), "a", "b", false);
    assert.equal(args.includes("-r"), false);
  });

  it("7. source and destination are separate trailing operands", () => {
    const local = "H:\\pack\\release";
    const remote = "/srv/sweetcraft/incoming/tx/x";
    const t = baseTarget();
    const args = buildScpArgv(t, local, remote, true);
    const dest = `${t.user}@${t.host}:${remote}`;
    assert.equal(args[args.length - 2], local);
    assert.equal(args[args.length - 1], dest);
    // -O appears before operands
    const oIdx = args.indexOf("-O");
    assert.ok(oIdx >= 0);
    assert.ok(oIdx < args.length - 2);
  });

  it("8. argv is a plain string[] suitable for spawn (no shell string)", () => {
    const args = buildScpArgv(baseTarget({ identity: "/id" }), "loc", "rem", true);
    assert.ok(Array.isArray(args));
    assert.ok(args.every(a => typeof a === "string"));
    assert.equal(args.some(a => a.includes(" && ") || a.includes("|")), false);
  });

  it("9. forbidden SSH opts still rejected", () => {
    assert.throws(
      () => assertNoForbiddenSshOpts(["-o", "StrictHostKeyChecking=no"]),
      /StrictHostKeyChecking/
    );
    assert.throws(
      () => assertNoForbiddenSshOpts(["-o", "UserKnownHostsFile=/dev/null"]),
      /UserKnownHostsFile/
    );
    // buildScpArgv itself never injects them
    const args = buildScpArgv(baseTarget(), "a", "b", false);
    assert.equal(args.join(" ").includes("StrictHostKeyChecking=no"), false);
    assert.equal(args.join(" ").includes("UserKnownHostsFile=/dev/null"), false);
  });

  it("argv shape: -P … -o BatchMode=yes [-i …] -O [-r] local remote", () => {
    const args = buildScpArgv(
      baseTarget({ port: 22, identity: "/key" }),
      "/local",
      "/remote/path",
      true
    );
    assert.deepEqual(args, [
      "-P",
      "22",
      "-o",
      "BatchMode=yes",
      "-i",
      "/key",
      "-O",
      "-r",
      "/local",
      "sweetcraft-deploy@87.106.2.194:/remote/path"
    ]);
  });
});
