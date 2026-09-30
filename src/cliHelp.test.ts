import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BASELINE_CATALOG_DEFAULT,
  RELEASE_CATALOG_DEFAULT,
  formatCommandHelp,
  resolveCurrentCatalogDefault
} from "./cliHelp.js";

describe("resolveCurrentCatalogDefault", () => {
  it("stage/validate default to catalog.configs.json", () => {
    assert.equal(resolveCurrentCatalogDefault("stage", {}).current, RELEASE_CATALOG_DEFAULT);
    assert.equal(resolveCurrentCatalogDefault("validate", {}).current, RELEASE_CATALOG_DEFAULT);
    assert.equal(resolveCurrentCatalogDefault("manifests", {}).current, RELEASE_CATALOG_DEFAULT);
  });

  it("scan/diff default to baseline", () => {
    assert.equal(resolveCurrentCatalogDefault("scan", {}).current, BASELINE_CATALOG_DEFAULT);
    assert.equal(resolveCurrentCatalogDefault("diff", {}).current, BASELINE_CATALOG_DEFAULT);
    assert.equal(resolveCurrentCatalogDefault("classify-configs", {}).current, BASELINE_CATALOG_DEFAULT);
  });

  it("--current overrides release default", () => {
    assert.equal(
      resolveCurrentCatalogDefault("stage", { currentOpt: "data/other.json" }).current,
      "data/other.json"
    );
  });
});

describe("formatCommandHelp", () => {
  it("stage help mentions required flags without throwing", () => {
    const h = formatCommandHelp("stage");
    assert.match(h, /--version/);
    assert.match(h, /--source/);
    assert.match(h, /catalog\.configs/);
  });

  it("upload help documents product origin base URL", () => {
    const h = formatCommandHelp("upload");
    assert.match(h, /--origin/);
    assert.match(h, /sweetcraft/);
    assert.match(h, /PRODUIT|produit|product/i);
  });
});
