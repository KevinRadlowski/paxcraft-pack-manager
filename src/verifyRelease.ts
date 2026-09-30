import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { hashFile } from "./io.js";
import {
  buildReleaseSigningPayload,
  RELEASE_SIGNING_PAYLOAD_ID,
  type ReleaseSigningFields
} from "./releasePayload.js";
import { verifyEd25519Pem, type TrustedKeys } from "./releaseSigning.js";
import { RELEASE_FILES_BASE, MANIFEST_SCHEMA_VERSION, MANIFEST_SCHEMA_VERSION_LEGACY } from "./types.js";
import { assertSafeFilesPayloadPath } from "./resourcePackPaths.js";
import {
  expectedReleaseStoragePath,
  ManifestResourcePackError,
  validateManifestResourcePacks
} from "./resourcePackManifest.js";
import type { ManifestResourcePack } from "./resourcePackTypes.js";
import type { ManifestServerDatapack } from "./serverDatapackTypes.js";
import { computeDatapackTreeSha256 } from "./serverDatapack.js";
import { stagedServerDatapackFileRelativePath } from "./serverDatapackPaths.js";

export class VerifyReleaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerifyReleaseError";
  }
}

export interface VerifyReleaseOptions {
  releaseDir: string;
  /** publicKeyId -> PEM. Required when signature.status === "signed". */
  trustedKeys?: TrustedKeys;
  /** When true, treat unsigned-dev as integrity-only (default true). */
  allowUnsignedDev?: boolean;
}

export interface VerifyReleaseResult {
  ok: boolean;
  releaseDir: string;
  packVersion: string;
  filesChecked: number;
  releaseIntegrity: "OK" | "FAIL";
  manifestIntegrity: "OK" | "FAIL";
  checksumsIntegrity: "OK" | "FAIL";
  signature: "SIGNED_OK" | "UNSIGNED_DEV" | "FAIL";
  publishableStable: boolean;
  publishableBeta: boolean;
  errors: string[];
  warnings: string[];
}

interface ChecksumEntry {
  path: string;
  size: number;
  sha256: string;
}

interface ReleaseDoc {
  schemaVersion: number;
  product: string;
  packVersion: string;
  minecraft: string;
  fabricLoader: string;
  server: string;
  packManagerVersion: string;
  catalogSchemaVersion: number;
  manifestSchemaVersion: number;
  configBase: string;
  antiRollback?: { packVersion?: string; releaseSequence?: number | null };
  artefacts: {
    clientManifest: { path: string; sha256: string };
    serverManifest: { path: string; sha256: string };
    checksums: { path: string; sha256: string };
  };
  signature: {
    status: string;
    algorithm: string;
    publicKeyId: string | null;
    payload: string;
    value: string | null;
  };
}

const ROOT_ALLOWED = new Set([
  "release.json",
  "checksums.json",
  "client-manifest.json",
  "server-manifest.json"
]);

async function listRelativeFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, relBase: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      const rel = relBase ? `${relBase}/${ent.name}` : ent.name;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(abs, rel.replace(/\\/g, "/"));
      } else if (ent.isFile()) {
        out.push(rel.replace(/\\/g, "/"));
      }
    }
  }
  await walk(root, "");
  return out.sort((a, b) => a.localeCompare(b));
}

function assertSafeReleaseRel(rel: string) {
  if (!rel || rel.includes("\\") || rel.includes("\0")) {
    throw new VerifyReleaseError(`chemin invalide: ${rel}`);
  }
  if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.startsWith("//")) {
    throw new VerifyReleaseError(`chemin absolu refusé: ${rel}`);
  }
  const parts = rel.split("/");
  if (parts.some(p => p === ".." || p === "" || p === ".")) {
    throw new VerifyReleaseError(`path traversal refusé: ${rel}`);
  }
}

export function signingFieldsFromRelease(release: ReleaseDoc): ReleaseSigningFields {
  return {
    product: release.product,
    packVersion: release.packVersion,
    minecraft: release.minecraft,
    fabricLoader: release.fabricLoader,
    server: release.server,
    packManagerVersion: release.packManagerVersion,
    catalogSchemaVersion: release.catalogSchemaVersion,
    manifestSchemaVersion: release.manifestSchemaVersion,
    releaseSchemaVersion: release.schemaVersion,
    configBase: release.configBase,
    releaseSequence: release.antiRollback?.releaseSequence ?? null,
    clientManifestSha256: release.artefacts.clientManifest.sha256,
    serverManifestSha256: release.artefacts.serverManifest.sha256,
    checksumsSha256: release.artefacts.checksums.sha256
  };
}

/**
 * Verify a staged release directory (strict fileset + hashes + optional signature).
 */
export async function verifyRelease(opts: VerifyReleaseOptions): Promise<VerifyReleaseResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const releaseDir = path.resolve(opts.releaseDir);
  const allowUnsigned = opts.allowUnsignedDev !== false;
  const fail = (msg: string) => {
    errors.push(msg);
  };

  let packVersion = "?";
  let filesChecked = 0;
  let signatureStatus: VerifyReleaseResult["signature"] = "FAIL";

  try {
    await fs.access(releaseDir);
  } catch {
    fail(`release introuvable: ${releaseDir}`);
    return result(releaseDir, packVersion, 0, signatureStatus, errors, warnings);
  }

  let release: ReleaseDoc;
  try {
    release = JSON.parse(await fs.readFile(path.join(releaseDir, "release.json"), "utf8")) as ReleaseDoc;
    packVersion = release.packVersion;
  } catch (e) {
    fail(`release.json illisible: ${e instanceof Error ? e.message : String(e)}`);
    return result(releaseDir, packVersion, 0, signatureStatus, errors, warnings);
  }

  if (release.product !== "SweetCraft") fail(`product inattendu: ${release.product}`);
  if (!release.packVersion) fail("packVersion manquant");
  if (release.configBase !== RELEASE_FILES_BASE) {
    fail(`configBase attendu "${RELEASE_FILES_BASE}", reçu "${release.configBase}"`);
  }
  if (release.schemaVersion !== 1 && release.schemaVersion !== 2) {
    fail(`schemaVersion release non supporté: ${release.schemaVersion}`);
  }

  let checksums: { schemaVersion: number; entries: ChecksumEntry[] } = { schemaVersion: 0, entries: [] };
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(releaseDir, "checksums.json"), "utf8")) as {
      schemaVersion?: number;
      entries?: ChecksumEntry[];
    };
    if (!parsed || !Array.isArray(parsed.entries)) {
      fail("checksums.entries manquant ou invalide");
      checksums = { schemaVersion: 0, entries: [] };
    } else {
      checksums = { schemaVersion: parsed.schemaVersion ?? 0, entries: parsed.entries };
    }
  } catch (e) {
    fail(`checksums.json illisible: ${e instanceof Error ? e.message : String(e)}`);
  }

  const checksumsActual = await hashFile(path.join(releaseDir, "checksums.json"), "sha256").catch(() => "");
  if (!checksumsActual || checksumsActual !== release.artefacts.checksums.sha256.toLowerCase()) {
    fail(
      `checksums.json hash mismatch: release=${release.artefacts.checksums.sha256} actual=${checksumsActual || "(missing)"}`
    );
  }

  if (checksums.entries.some(e => e.path === "release.json")) {
    fail("checksums.json ne doit PAS contenir release.json (dépendance circulaire)");
  }

  const entryByPath = new Map<string, ChecksumEntry>();
  for (const e of checksums.entries) {
    try {
      assertSafeReleaseRel(e.path);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
      continue;
    }
    if (entryByPath.has(e.path)) fail(`checksums entry dupliquée: ${e.path}`);
    entryByPath.set(e.path, e);
  }

  for (const req of ["client-manifest.json", "server-manifest.json"] as const) {
    if (!entryByPath.has(req)) fail(`checksums manque ${req}`);
  }

  const onDisk = await listRelativeFiles(releaseDir);
  for (const rel of onDisk) {
    try {
      assertSafeReleaseRel(rel);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
      continue;
    }
    if (ROOT_ALLOWED.has(rel)) continue;
    if (rel.startsWith("files/")) {
      if (!entryByPath.has(rel)) fail(`fichier inattendu dans la release: ${rel}`);
      continue;
    }
    fail(`fichier inattendu dans la release: ${rel}`);
  }

  for (const [rel] of entryByPath) {
    if (rel === "client-manifest.json" || rel === "server-manifest.json") continue;
    if (!rel.startsWith("files/")) {
      fail(`checksums path hors fileset autorisé: ${rel}`);
      continue;
    }
    const after = rel.slice("files/".length);
    try {
      assertSafeFilesPayloadPath(after);
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
  }

  for (const e of checksums.entries) {
    const abs = path.join(releaseDir, ...e.path.split("/"));
    let st;
    try {
      st = await fs.stat(abs);
    } catch {
      fail(`fichier checksum manquant: ${e.path}`);
      continue;
    }
    if (!st.isFile()) {
      fail(`checksum n'est pas un fichier: ${e.path}`);
      continue;
    }
    if (st.size !== e.size) {
      fail(`taille mismatch ${e.path}: expected=${e.size} actual=${st.size}`);
    }
    const sha = await hashFile(abs, "sha256");
    if (sha !== e.sha256.toLowerCase()) {
      fail(`SHA-256 mismatch ${e.path}: expected=${e.sha256} actual=${sha}`);
    } else {
      filesChecked++;
    }
  }

  const clientSha = entryByPath.get("client-manifest.json")?.sha256?.toLowerCase();
  const serverSha = entryByPath.get("server-manifest.json")?.sha256?.toLowerCase();
  if (clientSha && clientSha !== release.artefacts.clientManifest.sha256.toLowerCase()) {
    fail("client-manifest sha256 diverge entre checksums et release.artefacts");
  }
  if (serverSha && serverSha !== release.artefacts.serverManifest.sha256.toLowerCase()) {
    fail("server-manifest sha256 diverge entre checksums et release.artefacts");
  }

  try {
    const clientActual = await hashFile(path.join(releaseDir, "client-manifest.json"), "sha256");
    const serverActual = await hashFile(path.join(releaseDir, "server-manifest.json"), "sha256");
    if (clientActual !== release.artefacts.clientManifest.sha256.toLowerCase()) {
      fail("client-manifest.json hash != release.artefacts");
    }
    if (serverActual !== release.artefacts.serverManifest.sha256.toLowerCase()) {
      fail("server-manifest.json hash != release.artefacts");
    }
    const client = JSON.parse(await fs.readFile(path.join(releaseDir, "client-manifest.json"), "utf8"));
    const server = JSON.parse(await fs.readFile(path.join(releaseDir, "server-manifest.json"), "utf8"));
    if (client.packVersion && client.packVersion !== release.packVersion) {
      fail(`client-manifest packVersion != release (${client.packVersion})`);
    }
    if (server.packVersion && server.packVersion !== release.packVersion) {
      fail(`server-manifest packVersion != release (${server.packVersion})`);
    }
    if (client.configBase !== release.configBase) fail("client-manifest configBase diverge");
    if (server.configBase !== release.configBase) fail("server-manifest configBase diverge");

    await verifyManifestResourcePacksSection({
      client,
      server,
      releaseManifestSchema: release.manifestSchemaVersion,
      releaseDir,
      entryByPath,
      fail
    });
  } catch (e) {
    fail(`lecture manifests: ${e instanceof Error ? e.message : String(e)}`);
  }

  const sig = release.signature;
  if (!sig) {
    fail("bloc signature manquant");
    signatureStatus = "FAIL";
  } else if (sig.status === "unsigned-dev") {
    if (!allowUnsigned) {
      fail("unsigned-dev refusé (allowUnsignedDev=false)");
      signatureStatus = "FAIL";
    } else {
      signatureStatus = "UNSIGNED_DEV";
      if (sig.value) warnings.push("unsigned-dev avec value non-null (ignoré)");
    }
  } else if (sig.status === "signed") {
    if (sig.algorithm !== "ed25519") fail(`algorithm non supporté: ${sig.algorithm}`);
    if (!sig.publicKeyId) fail("publicKeyId manquant pour signature signed");
    if (!sig.value) fail("signature.value manquant");
    if (sig.payload !== RELEASE_SIGNING_PAYLOAD_ID) {
      fail(`payload attendu ${RELEASE_SIGNING_PAYLOAD_ID}, reçu ${sig.payload}`);
    }
    const keys = opts.trustedKeys ?? {};
    const pem = sig.publicKeyId ? keys[sig.publicKeyId] : undefined;
    if (!pem) {
      fail(`clé publique inconnue: ${sig.publicKeyId}`);
      signatureStatus = "FAIL";
    } else if (sig.value) {
      try {
        const payload = buildReleaseSigningPayload(signingFieldsFromRelease(release));
        if (!verifyEd25519Pem(pem, payload, sig.value)) {
          fail("signature Ed25519 INVALIDE");
          signatureStatus = "FAIL";
        } else {
          signatureStatus = "SIGNED_OK";
        }
      } catch (e) {
        fail(`reconstruction payload: ${e instanceof Error ? e.message : String(e)}`);
        signatureStatus = "FAIL";
      }
    }
  } else {
    fail(`signature.status inconnu: ${sig.status}`);
    signatureStatus = "FAIL";
  }

  return result(releaseDir, packVersion, filesChecked, signatureStatus, errors, warnings, release);
}

async function verifyManifestResourcePacksSection(args: {
  client: Record<string, unknown>;
  server: Record<string, unknown>;
  releaseManifestSchema: number;
  releaseDir: string;
  entryByPath: Map<string, ChecksumEntry>;
  fail: (msg: string) => void;
}): Promise<void> {
  const { client, server, releaseManifestSchema, releaseDir, entryByPath, fail } = args;

  const clientSchema = Number(client.schemaVersion);
  const serverSchema = Number(server.schemaVersion);
  if (clientSchema !== releaseManifestSchema) {
    fail(`client-manifest schemaVersion ${clientSchema} != release.manifestSchemaVersion ${releaseManifestSchema}`);
  }
  if (serverSchema !== releaseManifestSchema) {
    fail(`server-manifest schemaVersion ${serverSchema} != release.manifestSchemaVersion ${releaseManifestSchema}`);
  }

  const legacy = releaseManifestSchema === MANIFEST_SCHEMA_VERSION_LEGACY;
  const current = releaseManifestSchema === MANIFEST_SCHEMA_VERSION;
  if (!legacy && !current) {
    fail(`manifest schemaVersion non supporté: ${releaseManifestSchema} (supportés: ${MANIFEST_SCHEMA_VERSION_LEGACY}, ${MANIFEST_SCHEMA_VERSION})`);
    return;
  }

  let clientPacks: ManifestResourcePack[] = [];
  let serverPacks: ManifestResourcePack[] = [];
  try {
    clientPacks = validateManifestResourcePacks(client.resourcePacks, "client", {
      allowImplicitEmpty: legacy
    });
    serverPacks = validateManifestResourcePacks(server.resourcePacks, "server", {
      allowImplicitEmpty: legacy
    });
  } catch (e) {
    fail(e instanceof ManifestResourcePackError || e instanceof Error ? e.message : String(e));
    return;
  }

  if (current) {
    if (!Array.isArray(client.resourcePacks)) fail("client-manifest resourcePacks doit être un tableau (schema 6)");
    if (!Array.isArray(server.resourcePacks)) fail("server-manifest resourcePacks doit être un tableau (schema 6)");
  }

  // Server must never carry client resource packs
  if (serverPacks.length > 0) {
    fail("server-manifest resourcePacks doit être []");
  }

  for (const rp of clientPacks) {
    const storage = expectedReleaseStoragePath(rp.targetPath);
    const entry = entryByPath.get(storage);
    if (!entry) {
      fail(`resource pack absent des checksums: ${storage} (id=${rp.id})`);
      continue;
    }
    if (entry.size !== rp.size) {
      fail(`resource pack size mismatch ${rp.id}: manifest=${rp.size} checksums=${entry.size}`);
    }
    if (entry.sha256.toLowerCase() !== rp.sha256.toLowerCase()) {
      fail(`resource pack sha256 mismatch ${rp.id}: manifest=${rp.sha256} checksums=${entry.sha256}`);
    }
    const abs = path.join(releaseDir, ...storage.split("/"));
    try {
      const st = await fs.stat(abs);
      if (st.size !== rp.size) {
        fail(`resource pack fichier size mismatch ${rp.id}: expected=${rp.size} actual=${st.size}`);
      }
      const sha = await hashFile(abs, "sha256");
      if (sha !== rp.sha256.toLowerCase()) {
        fail(`resource pack fichier sha256 mismatch ${rp.id}: expected=${rp.sha256} actual=${sha}`);
      }
    } catch {
      fail(`resource pack fichier manquant: ${storage}`);
    }
  }

  await verifyServerDatapacks({
    client,
    server,
    releaseDir,
    entryByPath,
    fail
  });
}

async function verifyServerDatapacks(args: {
  client: Record<string, unknown>;
  server: Record<string, unknown>;
  releaseDir: string;
  entryByPath: Map<string, { path: string; size: number; sha256: string }>;
  fail: (msg: string) => void;
}): Promise<void> {
  const { client, server, releaseDir, entryByPath, fail } = args;
  const clientDps = client.serverDatapacks;
  if (clientDps !== undefined) {
    fail("client-manifest must not contain serverDatapacks");
  }
  const raw = server.serverDatapacks;
  if (raw === undefined) return;
  if (!Array.isArray(raw)) {
    fail("server-manifest serverDatapacks must be an array");
    return;
  }
  const dps = raw as ManifestServerDatapack[];
  for (const dp of dps) {
    if (dp.apply !== "force") {
      fail(`server datapack ${dp.id} apply must be force`);
    }
    if (!Array.isArray(dp.files) || !dp.files.length) {
      fail(`server datapack ${dp.id} files[] empty`);
      continue;
    }
    const tree = computeDatapackTreeSha256(dp.files);
    if (tree !== dp.treeSha256.toLowerCase()) {
      fail(`server datapack treeSha256 mismatch ${dp.id}`);
    }
    let bytes = 0;
    for (const f of dp.files) {
      bytes += f.size;
      const storage = stagedServerDatapackFileRelativePath(f.path);
      try {
        assertSafeFilesPayloadPath(storage.replace(/^files\//, ""));
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
      }
      const entry = entryByPath.get(storage);
      if (!entry) {
        fail(`server datapack absent des checksums: ${storage}`);
        continue;
      }
      if (entry.size !== f.size || entry.sha256.toLowerCase() !== f.sha256.toLowerCase()) {
        fail(`server datapack checksum mismatch ${f.path}`);
      }
      const abs = path.join(releaseDir, ...storage.split("/"));
      try {
        const sha = await hashFile(abs, "sha256");
        if (sha !== f.sha256.toLowerCase()) {
          fail(`server datapack file sha mismatch ${f.path}`);
        }
      } catch {
        fail(`server datapack file missing ${storage}`);
      }
    }
    if (bytes !== dp.totalBytes) {
      fail(`server datapack totalBytes mismatch ${dp.id}`);
    }
    if (dp.files.length !== dp.fileCount) {
      fail(`server datapack fileCount mismatch ${dp.id}`);
    }
  }
}

function result(
  releaseDir: string,
  packVersion: string,
  filesChecked: number,
  signature: VerifyReleaseResult["signature"],
  errors: string[],
  warnings: string[],
  release?: ReleaseDoc
): VerifyReleaseResult {
  const integrityOk = errors.length === 0;
  const seq = release?.antiRollback?.releaseSequence;
  const publishable =
    integrityOk &&
    signature === "SIGNED_OK" &&
    seq != null &&
    Number.isInteger(seq) &&
    seq >= 1;

  return {
    ok: integrityOk && (signature === "UNSIGNED_DEV" || signature === "SIGNED_OK"),
    releaseDir,
    packVersion,
    filesChecked,
    releaseIntegrity: integrityOk ? "OK" : "FAIL",
    manifestIntegrity: integrityOk ? "OK" : "FAIL",
    checksumsIntegrity: integrityOk ? "OK" : "FAIL",
    signature,
    publishableStable: !!publishable,
    publishableBeta: !!publishable,
    errors,
    warnings
  };
}

export function formatVerifyReport(r: VerifyReleaseResult): string {
  const lines = [
    `Release integrity: ${r.releaseIntegrity}`,
    `Files checked: ${r.filesChecked}`,
    `Manifest integrity: ${r.manifestIntegrity}`,
    `Checksums integrity: ${r.checksumsIntegrity}`,
    `Signature: ${r.signature}`,
    `Publishable stable: ${r.publishableStable ? "YES" : "NO"}`,
    `Publishable beta: ${r.publishableBeta ? "YES" : "NO"}`
  ];
  if (r.warnings.length) {
    lines.push("Warnings:");
    for (const w of r.warnings) lines.push(`  - ${w}`);
  }
  if (r.errors.length) {
    lines.push("Errors:");
    for (const e of r.errors) lines.push(`  - ${e}`);
  }
  return lines.join("\n");
}

export function digestReleaseJsonBytes(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}
