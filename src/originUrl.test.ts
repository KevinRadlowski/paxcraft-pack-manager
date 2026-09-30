import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  joinOriginPath,
  normalizeProductOriginUrl,
  OriginUrlError,
  publicChannelUrl,
  publicReleaseJsonUrl
} from "./originUrl.js";

describe("normalizeProductOriginUrl", () => {
  it("A. product base without trailing slash", () => {
    assert.equal(
      normalizeProductOriginUrl("https://cdn.xnosweet.fr/sweetcraft"),
      "https://cdn.xnosweet.fr/sweetcraft"
    );
    assert.equal(
      publicChannelUrl("https://cdn.xnosweet.fr/sweetcraft", "dev"),
      "https://cdn.xnosweet.fr/sweetcraft/channels/dev.json"
    );
  });

  it("B. trailing slash yields identical URLs", () => {
    const a = normalizeProductOriginUrl("https://cdn.xnosweet.fr/sweetcraft");
    const b = normalizeProductOriginUrl("https://cdn.xnosweet.fr/sweetcraft/");
    assert.equal(a, b);
    assert.equal(publicChannelUrl(a, "dev"), publicChannelUrl(b, "dev"));
    assert.equal(
      publicReleaseJsonUrl(a, "0.1.1"),
      "https://cdn.xnosweet.fr/sweetcraft/releases/0.1.1/release.json"
    );
    assert.ok(!publicChannelUrl(a, "dev").includes("//channels"));
    assert.ok(!publicReleaseJsonUrl(a, "0.1.1").includes("//releases"));
  });

  it("C. invalid origin refused", () => {
    assert.throws(() => normalizeProductOriginUrl("not-a-url"), OriginUrlError);
    assert.throws(() => normalizeProductOriginUrl(""), OriginUrlError);
    assert.throws(() => normalizeProductOriginUrl("https://cdn.xnosweet.fr/sweetcraft?x=1"), /query/);
    assert.throws(() => normalizeProductOriginUrl("https://cdn.xnosweet.fr/sweetcraft#frag"), /fragment/);
    assert.throws(
      () => normalizeProductOriginUrl("https://user:pass@cdn.xnosweet.fr/sweetcraft"),
      /credentials/
    );
  });

  it("D. HTTP refused by default", () => {
    assert.throws(() => normalizeProductOriginUrl("http://cdn.xnosweet.fr/sweetcraft"), /HTTPS/);
    assert.equal(
      normalizeProductOriginUrl("http://cdn.xnosweet.fr/sweetcraft", { requireHttps: false }),
      "http://cdn.xnosweet.fr/sweetcraft"
    );
  });

  it("preserves arbitrary product path (no hardcoded /sweetcraft)", () => {
    assert.equal(
      publicChannelUrl("https://example.test/my-product", "beta"),
      "https://example.test/my-product/channels/beta.json"
    );
    assert.equal(
      publicChannelUrl("https://cdn.example/cdn-root", "dev"),
      "https://cdn.example/cdn-root/channels/dev.json"
    );
  });

  it("joinOriginPath never doubles slashes", () => {
    assert.equal(
      joinOriginPath("https://cdn.xnosweet.fr/sweetcraft/", "channels", "dev.json"),
      "https://cdn.xnosweet.fr/sweetcraft/channels/dev.json"
    );
  });
});
