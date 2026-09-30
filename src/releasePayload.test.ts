import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildChannelSigningPayload,
  buildReleaseSigningPayload,
  RELEASE_SIGNING_PAYLOAD_ID
} from "./releasePayload.js";

const base = {
  product: "SweetCraft",
  packVersion: "0.1.0",
  minecraft: "26.1.2",
  fabricLoader: "0.19.3",
  server: "sweetcraft.datho.st",
  packManagerVersion: "0.5.0",
  catalogSchemaVersion: 2,
  manifestSchemaVersion: 5,
  releaseSchemaVersion: 2,
  configBase: "files/",
  releaseSequence: null as number | null,
  clientManifestSha256: "a".repeat(64),
  serverManifestSha256: "b".repeat(64),
  checksumsSha256: "c".repeat(64)
};

describe("buildReleaseSigningPayload", () => {
  it("is deterministic byte-for-byte", () => {
    const a = buildReleaseSigningPayload(base);
    const b = buildReleaseSigningPayload({ ...base });
    assert.deepEqual(a, b);
  });

  it("uses LF only and trailing newline", () => {
    const s = buildReleaseSigningPayload(base).toString("utf8");
    assert.equal(s.includes("\r"), false);
    assert.ok(s.endsWith("\n"));
    assert.ok(s.startsWith(RELEASE_SIGNING_PAYLOAD_ID + "\n"));
  });

  it("empty releaseSequence when unset", () => {
    const s = buildReleaseSigningPayload({ ...base, releaseSequence: null }).toString("utf8");
    assert.ok(s.includes("releaseSequence=\n"));
  });

  it("encodes positive releaseSequence", () => {
    const s = buildReleaseSigningPayload({ ...base, releaseSequence: 7 }).toString("utf8");
    assert.ok(s.includes("releaseSequence=7\n"));
  });

  it("rejects zero / negative sequence", () => {
    assert.throws(() => buildReleaseSigningPayload({ ...base, releaseSequence: 0 }));
    assert.throws(() => buildReleaseSigningPayload({ ...base, releaseSequence: -1 }));
  });

  it("lowercases hashes", () => {
    const s = buildReleaseSigningPayload({
      ...base,
      clientManifestSha256: "AA".repeat(32)
    }).toString("utf8");
    assert.ok(s.includes("clientManifestSha256=" + "aa".repeat(32)));
  });

  it("field order is fixed (JSON key order irrelevant)", () => {
    const s = buildReleaseSigningPayload(base).toString("utf8");
    const keys = s
      .trimEnd()
      .split("\n")
      .slice(1)
      .map(l => l.split("=")[0]);
    assert.deepEqual(keys, [
      "product",
      "packVersion",
      "minecraft",
      "fabricLoader",
      "server",
      "packManagerVersion",
      "catalogSchemaVersion",
      "manifestSchemaVersion",
      "releaseSchemaVersion",
      "configBase",
      "releaseSequence",
      "clientManifestSha256",
      "serverManifestSha256",
      "checksumsSha256"
    ]);
  });

  it("rejects newline in field values", () => {
    assert.throws(() => buildReleaseSigningPayload({ ...base, server: "a\nb" }));
  });
});

describe("buildChannelSigningPayload", () => {
  it("deterministic", () => {
    const f = {
      channel: "stable" as const,
      packVersion: "0.1.0",
      releaseSequence: 1,
      releasePath: "releases/0.1.0/release.json",
      releaseSha256: "d".repeat(64)
    };
    assert.deepEqual(buildChannelSigningPayload(f), buildChannelSigningPayload({ ...f }));
  });
});
