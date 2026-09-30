import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import AdmZip from "adm-zip";
import {
  escapeRawLfCrInsideJsonStrings,
  extractNestedFabricModules,
  parseFabricModJsonBytes,
  parseFabricModJsonCompatible
} from "./fabricMeta.js";

const BETTEREND_JAR =
  "H:/Users/kevin/Downloads/Dev/XBase/MODPACK FINAL CLEAN/client/mods/better-end-26.101.2.jar";
const BETTEREND_SHA256 =
  "11bd14f8bf4b7e0a1bc4e2c4ebc26cfc57218f2270516f3d21ed6d5b4e4078ab";

function fmj(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

describe("parseFabricModJsonCompatible — Fabric Loader LF/CR tolerance", () => {
  it("A. strict-valid FMJ → PASS unchanged", () => {
    const text = fmj({
      id: "demo",
      version: "1.0.0",
      description: "ok"
    });
    const meta = parseFabricModJsonBytes(Buffer.from(text, "utf8"));
    assert.equal(meta.parse_error, undefined);
    assert.equal(meta.id, "demo");
    assert.equal(meta.version, "1.0.0");
    assert.equal(escapeRawLfCrInsideJsonStrings(text), text);
  });

  it("B. raw LF inside string → PASS", () => {
    const text = '{\n  "id": "x",\n  "version": "1",\n  "description": "line1\nline2"\n}';
    const meta = parseFabricModJsonBytes(Buffer.from(text, "utf8"));
    assert.equal(meta.parse_error, undefined);
    assert.equal(meta.id, "x");
    const raw = parseFabricModJsonCompatible(text) as { description: string };
    assert.equal(raw.description, "line1\nline2");
  });

  it("C. raw CR inside string → PASS", () => {
    const text = '{"id":"x","version":"1","description":"a\rb"}';
    const raw = parseFabricModJsonCompatible(text) as { description: string };
    assert.equal(raw.description, "a\rb");
  });

  it("D. raw CRLF inside string → PASS", () => {
    const text = '{"id":"x","version":"1","description":"a\r\nb"}';
    const raw = parseFabricModJsonCompatible(text) as { description: string };
    assert.equal(raw.description, "a\r\nb");
  });

  it('E. already-escaped "\\n" → PASS, no double-escape', () => {
    const text = '{"id":"x","version":"1","description":"a\\nb"}';
    const normalized = escapeRawLfCrInsideJsonStrings(text);
    assert.equal(normalized, text);
    const raw = parseFabricModJsonCompatible(text) as { description: string };
    assert.equal(raw.description, "a\nb");
  });

  it('F. "\\\\" then characters — correct escape state', () => {
    // JSON text: description contains \\ then a raw LF (the LF is not part of an escape).
    const text = '{"id":"x","description":"trail\\\\\nend"}';
    const normalized = escapeRawLfCrInsideJsonStrings(text);
    assert.equal(normalized, '{"id":"x","description":"trail\\\\\\nend"}');
    assert.equal(normalized.includes("\n"), false);
    const raw = parseFabricModJsonCompatible(text) as { description: string };
    assert.equal(raw.description, "trail\\\nend");
    assert.equal(raw.description.charCodeAt(5), 0x5c);
    assert.equal(raw.description.charCodeAt(6), 0x0a);
  });

  it("G. LF outside string → left alone; JSON.parse accepts as whitespace", () => {
    const text = '{\n"id"\n:\n"x"\n}';
    assert.equal(escapeRawLfCrInsideJsonStrings(text), text);
    const raw = parseFabricModJsonCompatible(text) as { id: string };
    assert.equal(raw.id, "x");
  });

  it("H. raw TAB inside string → FAIL", () => {
    const text = '{"id":"x","description":"a\tb"}';
    assert.throws(() => parseFabricModJsonCompatible(text));
    const meta = parseFabricModJsonBytes(Buffer.from(text, "utf8"));
    assert.ok(meta.parse_error);
  });

  it("I. raw U+0001 inside string → FAIL", () => {
    const text = '{"id":"x","description":"a\u0001b"}';
    assert.throws(() => parseFabricModJsonCompatible(text));
    const meta = parseFabricModJsonBytes(Buffer.from(text, "utf8"));
    assert.ok(meta.parse_error);
  });

  it("J. unclosed quote → FAIL", () => {
    const text = '{"id":"x","description":"oops';
    assert.throws(() => parseFabricModJsonCompatible(text));
    const meta = parseFabricModJsonBytes(Buffer.from(text, "utf8"));
    assert.ok(meta.parse_error);
  });

  it("K. bad escape → FAIL", () => {
    const text = '{"id":"x","description":"bad\\q"}';
    assert.throws(() => parseFabricModJsonCompatible(text));
    const meta = parseFabricModJsonBytes(Buffer.from(text, "utf8"));
    assert.ok(meta.parse_error);
  });

  it("L. BetterEnd-style minimal fixture + real JAR when present", () => {
    // Minimal reproduction: only the LF-in-description pattern (not full metadata).
    const fixture =
      '{\n' +
      '  "schemaVersion": 1,\n' +
      '  "id": "betterend",\n' +
      '  "version": "26.101.2",\n' +
      '  "name": "Better End",\n' +
      '  "description": "Better End adds...\nMade by:\\n- paulevs"\n' +
      "}";
    assert.throws(() => JSON.parse(fixture));
    const meta = parseFabricModJsonBytes(Buffer.from(fixture, "utf8"));
    assert.equal(meta.parse_error, undefined);
    assert.equal(meta.id, "betterend");
    assert.equal(meta.version, "26.101.2");

    if (!existsSync(BETTEREND_JAR)) return;
    const jarBytes = readFileSync(BETTEREND_JAR);
    const sha = createHash("sha256").update(jarBytes).digest("hex");
    assert.equal(sha, BETTEREND_SHA256);
    const zip = new AdmZip(jarBytes);
    const entry = zip.getEntry("fabric.mod.json");
    assert.ok(entry);
    const fmjText = entry.getData().toString("utf8");
    assert.throws(() => JSON.parse(fmjText));
    const real = parseFabricModJsonBytes(entry.getData());
    assert.equal(real.parse_error, undefined);
    assert.equal(real.id, "betterend");
    assert.equal(real.version, "26.101.2");
  });

  it("nested jar FMJ with raw LF uses the same compatible parser", () => {
    const nestedFmj =
      '{"id":"nested_mod","version":"1.0.0","description":"one\ntwo"}';
    const inner = new AdmZip();
    inner.addFile("fabric.mod.json", Buffer.from(nestedFmj, "utf8"));
    const host = new AdmZip();
    host.addFile(
      "fabric.mod.json",
      Buffer.from(
        JSON.stringify({
          id: "host",
          version: "1",
          jars: [{ file: "META-INF/jars/nested.jar" }]
        }),
        "utf8"
      )
    );
    host.addFile("META-INF/jars/nested.jar", inner.toBuffer());
    const { modules, errors } = extractNestedFabricModules(host.toBuffer());
    assert.equal(errors.length, 0);
    assert.equal(modules.length, 1);
    assert.equal(modules[0]!.id, "nested_mod");
    assert.equal(modules[0]!.parse_error, undefined);
  });
});
