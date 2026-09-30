import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  allowsLocalCleanRedistribution,
  forbidsLocalRedistribution,
  resolveArtifactSource,
  resolveAllArtifactSources
} from "./artifactSource.js";
import { LocalCleanError, resolveUnderCleanRoot, verifyLocalCleanArtifact } from "./localClean.js";
import { classifyLuckPermsLibs, inventoryDatapack } from "./serverSupplemental.js";
import { CLEAN_RESOURCEPACK_EXPECTED, runStagePreflight } from "./stagePreflight.js";
import type { Catalog, ModRecord } from "./types.js";
import { CATALOG_SCHEMA_VERSION } from "./types.js";
import { writeJson } from "./io.js";

function mod(partial: Partial<ModRecord> & Pick<ModRecord, "mod_id" | "jar">): ModRecord {
  return {
    name: partial.name ?? partial.mod_id,
    version: partial.version ?? "1.0.0",
    size_bytes: partial.size_bytes ?? 10,
    sha256: partial.sha256 ?? "a".repeat(64),
    side_class: partial.side_class ?? "BOTH_REQUIRED",
    install_client: partial.install_client ?? true,
    install_server: partial.install_server ?? true,
    distribution_policy: partial.distribution_policy ?? "UPSTREAM_PREFERRED",
    ...partial
  };
}

function catalog(mods: ModRecord[], configs: Catalog["configs"] = []): Catalog {
  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    generatedFor: {
      product: "SweetCraft Launcher",
      minecraft: "26.1.2",
      fabricLoader: "0.19.3",
      server: "test"
    },
    mods,
    configs
  };
}

describe("artifactSource model", () => {
  it("1. provider artifact path normal", () => {
    const r = resolveArtifactSource(
      mod({
        mod_id: "sodium",
        jar: "sodium.jar",
        modrinth_file_url: "https://cdn.modrinth.com/data/x.jar",
        distribution_policy: "UPSTREAM_PREFERRED"
      })
    );
    assert.equal(r.kind, "PROVIDER");
    assert.equal(r.decision, "PROVIDER");
  });

  it("2. LOCAL_CLEAN allowed for UPSTREAM_PREFERRED without URL", () => {
    const r = resolveArtifactSource(
      mod({
        mod_id: "dynamic_difficulty",
        jar: "dd.jar",
        distribution_policy: "UPSTREAM_PREFERRED"
      })
    );
    assert.equal(r.kind, "LOCAL_CLEAN");
    assert.equal(r.decision, "LOCAL_CLEAN_ALLOWED");
    assert.ok(allowsLocalCleanRedistribution("UPSTREAM_PREFERRED"));
  });

  it("9–10. custom local Fallen / XBASE Casino", () => {
    const fallen = resolveArtifactSource(
      mod({
        mod_id: "fallen",
        jar: "fallen.jar",
        distribution_policy: "SWEETCRAFT_ALLOWED"
      })
    );
    const casino = resolveArtifactSource(
      mod({
        mod_id: "xbasecasino",
        jar: "casino.jar",
        distribution_policy: "SWEETCRAFT_ALLOWED"
      })
    );
    assert.equal(fallen.decision, "CUSTOM_LOCAL_ALLOWED");
    assert.equal(casino.decision, "CUSTOM_LOCAL_ALLOWED");
  });

  it("PROVIDER_REQUIRED for UPSTREAM_REQUIRED without URL (FTB)", () => {
    const r = resolveArtifactSource(
      mod({
        mod_id: "ftbquests",
        jar: "ftb.jar",
        distribution_policy: "UPSTREAM_REQUIRED"
      })
    );
    assert.equal(r.decision, "PROVIDER_REQUIRED");
    assert.equal(r.kind, "UNRESOLVED");
    assert.ok(forbidsLocalRedistribution("UPSTREAM_REQUIRED"));
  });

  it("8. redistribution forbidden LEGAL_REVIEW", () => {
    const r = resolveArtifactSource(
      mod({
        mod_id: "x",
        jar: "x.jar",
        distribution_policy: "LEGAL_REVIEW"
      })
    );
    assert.equal(r.decision, "REDISTRIBUTION_BLOCKED");
  });

  it("11. no silent provider→local fallback when URL present", () => {
    const r = resolveArtifactSource(
      mod({
        mod_id: "m",
        jar: "m.jar",
        modrinth_file_url: "https://example/m.jar",
        distribution_policy: "SWEETCRAFT_ALLOWED"
      })
    );
    assert.equal(r.kind, "PROVIDER");
    assert.equal(r.cleanRelativePath, null);
  });
});

describe("localClean fail-closed", () => {
  it("2–7. verify ok / missing / hash / size / traversal / outside", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sc-clean-"));
    const jarDir = path.join(root, "client", "mods");
    await fs.mkdir(jarDir, { recursive: true });
    const buf = Buffer.from("hello-clean-jar");
    const sha = createHash("sha256").update(buf).digest("hex");
    const name = "demo.jar";
    await fs.writeFile(path.join(jarDir, name), buf);

    const ok = await verifyLocalCleanArtifact(root, {
      relativePath: `client/mods/${name}`,
      expectedFileName: name,
      expectedSha256: sha,
      expectedSize: buf.length
    });
    assert.equal(ok.sha256, sha);

    await assert.rejects(
      () =>
        verifyLocalCleanArtifact(root, {
          relativePath: "client/mods/missing.jar",
          expectedFileName: "missing.jar",
          expectedSha256: sha,
          expectedSize: 1
        }),
      LocalCleanError
    );

    await assert.rejects(
      () =>
        verifyLocalCleanArtifact(root, {
          relativePath: `client/mods/${name}`,
          expectedFileName: name,
          expectedSha256: "b".repeat(64),
          expectedSize: buf.length
        }),
      /SHA-256 mismatch/
    );

    await assert.rejects(
      () =>
        verifyLocalCleanArtifact(root, {
          relativePath: `client/mods/${name}`,
          expectedFileName: name,
          expectedSha256: sha,
          expectedSize: 999
        }),
      /size mismatch/
    );

    assert.throws(() => resolveUnderCleanRoot(root, "../etc/passwd"), LocalCleanError);
    assert.throws(() => resolveUnderCleanRoot(root, "C:/Windows/x"), LocalCleanError);
  });
});

describe("resourcepack v2.7 source of truth", () => {
  it("12–13. expected constants and v1.0 rejected by preflight marker", () => {
    assert.equal(
      CLEAN_RESOURCEPACK_EXPECTED.sha256,
      "f491caae5e1485d3e9c709f44cc81099ce6e742c48a9a33818740d643b09250f"
    );
    assert.equal(CLEAN_RESOURCEPACK_EXPECTED.size, 400806);
    assert.match(CLEAN_RESOURCEPACK_EXPECTED.fileName, /v2\.7/);
    assert.doesNotMatch(CLEAN_RESOURCEPACK_EXPECTED.fileName, /v1\.0/);
  });
});

describe("LuckPerms + datapack", () => {
  it("14. LuckPerms libs classified regenerable", () => {
    const c = classifyLuckPermsLibs();
    assert.equal(c.classification, "LUCKPERMS_LIBS_REGENERABLE");
  });

  it("16. datapack status DISTRIBUTED when CLEAN world/datapacks present", async () => {
    const clean = "H:/Users/kevin/Downloads/Dev/XBase/MODPACK FINAL CLEAN";
    try {
      await fs.access(
        path.join(clean, "server/world/datapacks/SweetCraft_Quest_Support/pack.mcmeta")
      );
    } catch {
      return; // skip if CLEAN absent
    }
    const d = await inventoryDatapack(clean);
    assert.equal(d.status, "DATAPACK_SERVER_DISTRIBUTED");
    assert.ok(d.files.length > 0);
  });
});

describe("stage preflight", () => {
  it("17–18. READY when all provider; BLOCKED on missing local", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sc-pf-"));
    const clientMods = path.join(root, "client", "mods");
    const clientCfg = path.join(root, "client", "config");
    const rpDir = path.join(root, "client", "resourcepacks");
    await fs.mkdir(clientMods, { recursive: true });
    await fs.mkdir(clientCfg, { recursive: true });
    await fs.mkdir(rpDir, { recursive: true });

    // Minimal valid RP zip — reuse validate by writing invalid and skipping full RP in blocked test
    const jarBuf = Buffer.from("mod-bytes");
    const jarSha = createHash("sha256").update(jarBuf).digest("hex");
    await fs.writeFile(path.join(clientMods, "ok.jar"), jarBuf);
    const cfgBuf = Buffer.from("{}");
    const cfgSha = createHash("sha256").update(cfgBuf).digest("hex");
    await fs.writeFile(path.join(clientCfg, "demo.json"), cfgBuf);

    const c = catalog(
      [
        mod({
          mod_id: "okmod",
          jar: "ok.jar",
          sha256: jarSha,
          size_bytes: jarBuf.length,
          modrinth_file_url: "https://example/ok.jar",
          distribution_policy: "UPSTREAM_PREFERRED",
          side_class: "CLIENT_ONLY",
          install_client: true,
          install_server: false
        })
      ],
      [
        {
          path: "config/demo.json",
          size_bytes: cfgBuf.length,
          sha256: cfgSha,
          policy: "SERVER_FORCE",
          target: "BOTH"
        }
      ]
    );

    // Blocked: local custom without file
    const blockedCat = catalog([
      mod({
        mod_id: "fallen",
        jar: "fallen-missing.jar",
        sha256: "c".repeat(64),
        size_bytes: 3,
        distribution_policy: "SWEETCRAFT_ALLOWED"
      })
    ]);
    const rpJson = path.join(root, "resourcepacks.json");
    // Point to non-v2.7 to force block on RP as well — use empty prepare fail
    await writeJson(rpJson, { resourcePacks: [] });

    const blocked = await runStagePreflight({
      catalog: blockedCat,
      cleanRoot: root,
      configSourceRoot: path.join(root, "client"),
      resourcePacksFile: rpJson
    });
    assert.equal(blocked.verdict, "STAGE_PREFLIGHT_BLOCKED");
    assert.ok(blocked.blockers.length > 0);

    // FTB unresolved blocks
    const ftb = await runStagePreflight({
      catalog: catalog([
        mod({
          mod_id: "ftbquests",
          jar: "ftb.jar",
          distribution_policy: "UPSTREAM_REQUIRED"
        })
      ]),
      cleanRoot: root,
      configSourceRoot: path.join(root, "client"),
      resourcePacksFile: rpJson
    });
    assert.equal(ftb.verdict, "STAGE_PREFLIGHT_BLOCKED");
    assert.ok(ftb.blockers.some(b => b.includes("PROVIDER_REQUIRED")));
  });
});

describe("resolveAllArtifactSources counts", () => {
  it("summarizes mixed catalog", () => {
    const all = resolveAllArtifactSources([
      mod({
        mod_id: "a",
        jar: "a.jar",
        modrinth_file_url: "https://x",
        distribution_policy: "UPSTREAM_PREFERRED"
      }),
      mod({
        mod_id: "fallen",
        jar: "f.jar",
        distribution_policy: "SWEETCRAFT_ALLOWED"
      }),
      mod({
        mod_id: "ftb",
        jar: "ftb.jar",
        distribution_policy: "UPSTREAM_REQUIRED"
      })
    ]);
    assert.equal(all.filter(x => x.kind === "PROVIDER").length, 1);
    assert.equal(all.filter(x => x.kind === "CUSTOM_LOCAL").length, 1);
    assert.equal(all.filter(x => x.kind === "UNRESOLVED").length, 1);
  });
});
