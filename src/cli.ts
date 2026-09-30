import path from "node:path";
import { readCatalog, writeJson } from "./io.js";
import { validate, releaseReady } from "./validate.js";
import { diffCatalog } from "./diff.js";
import { buildClientManifest, buildServerManifest } from "./manifest.js";
import { applyCuration } from "./curation.js";
import { scanInstance } from "./scan.js";
import { resolveModrinth } from "./modrinth.js";
import { resolveCurseForge } from "./curseforge.js";
import { resolveGitHub } from "./github.js";
import { classifyConfigs } from "./configPolicy.js";
import { stageRelease, StageError } from "./stage.js";
import { prepareResourcePacksFromConfig, ResourcePackError } from "./resourcePack.js";
import { formatVerifyReport, verifyRelease } from "./verifyRelease.js";
import { formatVerifyChannelReport, verifyChannelDescriptor } from "./verifyChannel.js";
import { formatPublishReport, publishRelease, PublishError } from "./publish.js";
import { loadTrustedKeys } from "./trustedKeys.js";
import {
  formatOriginVerifyReport,
  originVerifyToJson,
  OriginVerifyError,
  verifyOrigin
} from "./verifyOrigin.js";
import {
  formatRemotePublishFail,
  formatRemotePublishReport,
  remotePublish,
  RemotePublishError
} from "./remotePublish.js";
import { runStagePreflight } from "./stagePreflight.js";
import {
  formatReleasePreflightSummary,
  runReleasePreflight
} from "./releasePreflight.js";
import { VERSION } from "./version.js";
import { promises as fs } from "node:fs";
import type { TrustedKeys } from "./releaseSigning.js";
import type { ReleaseChannel } from "./releasePayload.js";
import {
  formatCommandHelp,
  resolveCurrentCatalogDefault
} from "./cliHelp.js";

const args = process.argv.slice(2);
const cmd = args[0] ?? "status";
const opt = (name: string, fallback?: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const flag = (name: string) => args.includes(name);

if (cmd === "--help" || cmd === "-h") {
  console.log(formatCommandHelp(""));
  process.exit(0);
}
if (flag("--help") || flag("-h")) {
  console.log(formatCommandHelp(cmd));
  process.exit(0);
}

const { baseline, current } = resolveCurrentCatalogDefault(cmd, {
  currentOpt: opt("--current"),
  catalogOpt: opt("--catalog")
});

function summary(c: any) {
  const counts = new Map<string, number>();
  for (const m of c.mods) counts.set(m.side_class, (counts.get(m.side_class) || 0) + 1);
  console.log(`SweetCraft Pack Manager v${VERSION}`);
  console.log(`Minecraft ${c.generatedFor.minecraft} | Fabric ${c.generatedFor.fabricLoader} | ${c.mods.length} mods | ${c.configs.length} configs`);
  for (const [k, v] of [...counts].sort()) console.log(`  ${k}: ${v}`);
}

if (cmd === "status") summary(await readCatalog(current));
else if (cmd === "validate") {
  const c = await readCatalog(current);
  summary(c);
  const f = validate(c);
  const errors = f.filter(x => x.severity === "ERROR");
  const warns = f.filter(x => x.severity === "WARN");
  for (const x of f.slice(0, 100)) console.log(`${x.severity} ${x.code} ${x.subject} — ${x.message}`);
  if (f.length > 100) console.log(`... ${f.length - 100} autres constats`);
  const review = c.configs.filter(x => x.policy === "COMMON_FORCE_REVIEW").length;
  const excluded = c.configs.filter(x => x.policy === "EXCLUDED").length;
  const never = c.configs.filter(x => x.policy === "NEVER_CLIENT_SECRET_REVIEW").length;
  const byPol = new Map<string, number>();
  const byTarget = new Map<string, number>();
  for (const cf of c.configs) {
    byPol.set(cf.policy, (byPol.get(cf.policy) || 0) + 1);
    byTarget.set(String(cf.target ?? "(missing)"), (byTarget.get(String(cf.target ?? "(missing)")) || 0) + 1);
  }
  console.log("Policies:");
  for (const [k, v] of [...byPol].sort()) console.log(`  ${k}: ${v}`);
  console.log("Targets:");
  for (const [k, v] of [...byTarget].sort()) console.log(`  ${k}: ${v}`);
  console.log(`Validation: ${errors.length} erreur(s), ${warns.length} avertissement(s)`);
  console.log(`RELEASE_READY=${errors.length === 0 ? "YES" : "NO"} (REVIEW=${review}, NEVER=${never}, EXCLUDED=${excluded})`);
  process.exitCode = errors.length ? 2 : 0;
} else if (cmd === "diff") {
  const a = await readCatalog(baseline), b = await readCatalog(current), d = diffCatalog(a, b);
  console.log(`Mods: +${d.mods.added.length} -${d.mods.removed.length} ~${d.mods.changed.length}`);
  for (const x of d.mods.added) console.log(` + ${x.name} ${x.version}`);
  for (const x of d.mods.removed) console.log(` - ${x.name} ${x.version}`);
  for (const x of d.mods.changed) console.log(` ~ ${x.before.name}: ${x.before.version} -> ${x.after.version}`);
  console.log(`Configs: +${d.configs.added.length} -${d.configs.removed.length} ~${d.configs.changed.length}`);
} else if (cmd === "resolve-modrinth") {
  const c = await readCatalog(current), out = opt("--out", "data/catalog.modrinth.json")!, r = await resolveModrinth(c, opt("--cache", "data/cache/modrinth"));
  await writeJson(out, r.catalog);
  console.log(`Modrinth: ${r.found} trouvé(s), ${r.missing} absent(s), ${r.realConflicts} vrai(s) conflit(s), ${r.compatibleDifferences} différence(s) compatible(s).`);
  console.log(`Catalogue écrit: ${out}`);
  if (r.realConflicts) process.exitCode = 2;
} else if (cmd === "resolve-curseforge") {
  const c = await readCatalog(current), out = opt("--out", "data/catalog.curseforge.json")!, r = await resolveCurseForge(c);
  await writeJson(out, r.catalog);
  console.log(`CurseForge: ${r.found} résolu(s), ${r.missing} en attente, ${r.skipped} sans projet CurseForge.`);
  if (r.needsApiKey) console.log("CURSEFORGE_API_KEY absent : les projets connus sont conservés, mais aucun File ID/download URL ne peut être résolu via l’API officielle.");
  console.log(`Catalogue écrit: ${out}`);
} else if (cmd === "resolve-providers") {
  let c = await readCatalog(current);
  const mr = await resolveModrinth(c, opt("--cache", "data/cache/modrinth"));
  c = mr.catalog;
  const cf = await resolveCurseForge(c);
  c = cf.catalog;
  const gh = await resolveGitHub(c);
  c = gh.catalog;
  const out = opt("--out", "data/catalog.providers.json")!;
  await writeJson(out, c);
  console.log(`Providers: Modrinth ${mr.found}/${c.mods.length}; CurseForge +${cf.found}; auteur/GitHub +${gh.found}.`);
  console.log(`Restants sans fichier direct: ${c.mods.filter(m => !(m.modrinth_file_url || m.curseforge_file_url || m.author_file_url)).length}`);
  console.log(`Catalogue écrit: ${out}`);
  if (mr.realConflicts) process.exitCode = 2;
} else if (cmd === "curate") {
  const c = await readCatalog(current), r = applyCuration(c), out = opt("--out", "data/catalog.curated.json")!;
  await writeJson(out, r.catalog);
  console.log(
    `Curation: ${r.changed} changement(s) (presence=${r.presenceChanged}, closure=${r.closurePromoted}).`
  );
  console.log(`Catalogue écrit: ${out}`);
} else if (cmd === "classify-configs") {
  const c = await readCatalog(current), r = classifyConfigs(c), out = opt("--out", "data/catalog.configs.json")!;
  await writeJson(out, r.catalog);
  console.log(`Configs: ${r.changed} politique(s) changée(s), ${r.mapped} owner(s) mappé(s), ${r.excluded} exclu(s), ${r.migratedLegacy} legacy migré(s), ${r.orphans.length} candidate(s) orpheline(s).`);
  for (const x of r.orphans.slice(0, 30)) console.log(` ? ${x}`);
  if (r.orphans.length > 30) console.log(`... ${r.orphans.length - 30} autres`);
  console.log(`Catalogue écrit: ${out} (schemaVersion=${r.catalog.schemaVersion})`);
} else if (cmd === "preflight-stage") {
  const clean = opt("--clean");
  if (!clean) throw new Error("--clean <MODPACK FINAL CLEAN root> obligatoire");
  const c = await readCatalog(current);
  const rp = opt("--resourcepacks", "data/resourcepacks.json")!;
  const r = await runStagePreflight({
    catalog: c,
    cleanRoot: path.resolve(clean),
    configSourceRoot: path.resolve(opt("--source", path.join(clean, "client"))!),
    resourcePacksFile: path.resolve(rp),
    packVersion: opt("--version", "0.1.3")
  });
  const out = opt("--out", "data/candidates/0.1.3-seq4-NONPUBLISHABLE/STAGE_PREFLIGHT.json")!;
  await writeJson(out, r);
  console.log(`preflight=${r.verdict} protocol=${r.protocolImpact}`);
  console.log(
    `sources: PROVIDER=${r.counts.provider} LOCAL_CLEAN=${r.counts.localClean} CUSTOM_LOCAL=${r.counts.customLocal} UNRESOLVED=${r.counts.unresolved}`
  );
  console.log(`resourcepack: ${r.resourcePack.detail} ok=${r.resourcePack.ok}`);
  console.log(`luckperms: ${r.luckperms.classification} inventoried=${r.luckperms.inventoried}`);
  console.log(`datapack: ${r.datapack.status}`);
  for (const b of r.blockers.slice(0, 40)) console.log(` BLOCK ${b}`);
  if (r.blockers.length > 40) console.log(` ... ${r.blockers.length - 40} autres blockers`);
  for (const w of r.warnings.slice(0, 20)) console.log(` WARN ${w}`);
  console.log(`Rapport: ${out}`);
  if (r.verdict !== "STAGE_PREFLIGHT_READY") process.exitCode = 2;
} else if (cmd === "release-preflight") {
  const content = opt("--content");
  const clean = opt("--clean") ?? opt("--mfc");
  if (!content) throw new Error("--content <sweetcraft-content root> obligatoire");
  if (!clean) throw new Error("--clean <MODPACK FINAL CLEAN root> obligatoire");
  const seqRaw = opt("--sequence");
  let releaseSequence: number | undefined;
  if (seqRaw) {
    const n = Number(seqRaw);
    if (!Number.isInteger(n) || n < 1) throw new Error(`--sequence invalide: ${seqRaw}`);
    releaseSequence = n;
  }
  const report = await runReleasePreflight({
    contentRoot: path.resolve(content),
    mfcRoot: path.resolve(clean),
    catalogPath: path.resolve(current),
    casinoProvenancePath: opt("--casino-provenance") ?? null,
    packVersion: opt("--version") ?? null,
    releaseSequence: releaseSequence ?? null,
    packManagerRoot: path.resolve("."),
    requireDatHostExternalVerify: !flag("--no-dathost-external"),
    generatedAt: opt("--generated-at") ?? undefined
  });
  const out = opt("--out");
  if (out) await writeJson(path.resolve(out), report);
  const bomOut = opt("--bom-out");
  if (bomOut) await writeJson(path.resolve(bomOut), report.bom);
  console.log(formatReleasePreflightSummary(report));
  if (out) console.log(`Rapport: ${out}`);
  process.exitCode = report.exitCode;
} else if (cmd === "manifests") {
  const c = await readCatalog(current), findings = validate(c), errors = findings.filter(x => x.severity === "ERROR");
  if (errors.length) throw new Error(`Publication bloquée: ${errors.length} erreur(s) de validation.`);
  const version = opt("--version");
  if (!version) throw new Error("--version obligatoire");
  const dir = opt("--out-dir", "data/release")!;
  await writeJson(`${dir}/client-manifest.json`, buildClientManifest(c, version));
  await writeJson(`${dir}/server-manifest.json`, buildServerManifest(c, version));
  console.log(`Manifests client + serveur générés: ${dir}`);
} else if (cmd === "manifest") {
  const c = await readCatalog(current), findings = validate(c), errors = findings.filter(x => x.severity === "ERROR");
  if (errors.length) throw new Error(`Publication bloquée: ${errors.length} erreur(s) de validation.`);
  const version = opt("--version");
  if (!version) throw new Error("--version obligatoire");
  const out = opt("--out", "data/manifest.generated.json")!;
  await writeJson(out, buildClientManifest(c, version));
  console.log(`Manifest client généré: ${out}`);
} else if (cmd === "stage") {
  const version = opt("--version");
  if (!version) throw new Error("--version obligatoire");
  const source = opt("--source");
  if (!source) throw new Error("--source <pack root contenant config/> obligatoire");
  const outDir = opt("--out-dir", "data/releases")!;
  try {
    await fs.access(path.resolve(current));
  } catch {
    throw new Error(
      `catalogue release-ready introuvable: ${current} — générer via \`pnpm pack:configs\` (CLI: classify-configs) ou passer --current <fichier>`
    );
  }
  const c = await readCatalog(current);
  summary(c);
  const ready = releaseReady(c);
  console.log(`RELEASE_READY=${ready.ready ? "YES" : "NO"}`);
  const rpOpt = opt("--resourcepacks");
  let resourcePacksFile: string | undefined = rpOpt ? path.resolve(rpOpt) : undefined;
  if (!resourcePacksFile) {
    const defaultRp = path.resolve("data/resourcepacks.json");
    try {
      await fs.access(defaultRp);
      resourcePacksFile = defaultRp;
    } catch {
      // optional: no resource packs
    }
  }
  const sdpOpt = opt("--server-datapacks");
  let serverDatapacksFile: string | undefined = sdpOpt ? path.resolve(sdpOpt) : undefined;
  if (!serverDatapacksFile) {
    const defaultSdp = path.resolve("data/serverDatapacks.json");
    try {
      await fs.access(defaultSdp);
      serverDatapacksFile = defaultSdp;
    } catch {
      // optional
    }
  }
  const cleanOpt = opt("--clean");
  const originOpt = opt("--product-origin") ?? opt("--origin");
  const seqRaw = opt("--sequence");
  let releaseSequence: number | undefined;
  if (seqRaw) {
    const n = Number(seqRaw);
    if (!Number.isInteger(n) || n < 1) throw new Error(`--sequence invalide: ${seqRaw}`);
    releaseSequence = n;
  }
  const { UnsignedDevSigner } = await import("./releaseSigning.js");
  const signer = flag("--unsigned-dev") ? new UnsignedDevSigner() : undefined;
  const contentOpt = opt("--content");
  if (!contentOpt) {
    throw new Error(
      "--content <sweetcraft-content root> obligatoire (STEP-4.6-M7 release preflight fail-closed)"
    );
  }
  if (!cleanOpt) {
    throw new Error(
      "--clean <MODPACK FINAL CLEAN root> obligatoire (STEP-4.6-M7 release preflight fail-closed)"
    );
  }
  // No --skip-preflight: production path cannot opt out.
  try {
    const r = await stageRelease({
      catalog: c,
      packVersion: version,
      sourceRoot: path.resolve(source),
      outDir: path.resolve(outDir),
      force: flag("--force"),
      resourcePacksFile,
      serverDatapacksFile,
      cleanRoot: path.resolve(cleanOpt),
      productOrigin: originOpt,
      releaseSequence,
      signer,
      assemblyGate: {
        mode: "run",
        options: {
          contentRoot: path.resolve(contentOpt),
          mfcRoot: path.resolve(cleanOpt),
          catalogPath: path.resolve(current),
          casinoProvenancePath: opt("--casino-provenance") ?? null,
          packVersion: version,
          releaseSequence: releaseSequence ?? null,
          packManagerRoot: path.resolve("."),
          requireDatHostExternalVerify: true
        }
      }
    });
    console.log(`Release staged: ${r.releaseDir}`);
    console.log(`Version: ${r.packVersion}`);
    console.log(`Client mods: ${r.clientMods}`);
    console.log(`Server mods: ${r.serverMods}`);
    console.log(`Configs staged: ${r.configsStaged}`);
    console.log(`Resource packs staged: ${r.resourcePacksStaged}`);
    console.log(`Server datapacks staged: ${r.serverDatapacksStaged}`);
    console.log(`Release-hosted mods: ${r.releaseHostedModsStaged}`);
    console.log(`Excluded: ${r.excluded}`);
    console.log(`Checksums: ${r.checksumEntries}`);
    console.log(`Signature: ${r.signatureStatus}${r.publicKeyId ? ` (key=${r.publicKeyId})` : ""}`);
    if (releaseSequence != null) console.log(`Candidate sequence: ${releaseSequence}`);
    console.log(`RELEASE_READY: YES`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Staging échoué: ${msg}`);
    process.exitCode = e instanceof StageError ? 2 : 1;
  }
} else if (cmd === "validate-resourcepacks") {
  const file = opt("--file", "data/resourcepacks.json")!;
  try {
    const packs = await prepareResourcePacksFromConfig(path.resolve(file));
    console.log(`Resource packs OK: ${packs.length}`);
    for (const p of packs) {
      console.log(`  - ${p.id} ${p.version} sha256=${p.sha256} size=${p.size} -> ${p.targetPath}`);
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = e instanceof ResourcePackError ? 2 : 1;
  }
} else if (cmd === "validate-server-datapacks") {
  const file = opt("--file", "data/serverDatapacks.json")!;
  try {
    const { prepareServerDatapacksFromConfig } = await import("./serverDatapack.js");
    const dps = await prepareServerDatapacksFromConfig(path.resolve(file));
    console.log(`Server datapacks OK: ${dps.length}`);
    for (const dp of dps) {
      console.log(
        `  - ${dp.id} ${dp.version} files=${dp.fileCount} bytes=${dp.totalBytes} tree=${dp.treeSha256} -> ${dp.targetPath}`
      );
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = e instanceof (await import("./serverDatapack.js")).ServerDatapackError ? 2 : 1;
  }
} else if (cmd === "verify-release") {
  const release = opt("--release");
  if (!release) throw new Error("--release <dir> obligatoire");
  let trustedKeys: TrustedKeys | undefined;
  const keysPath = opt("--trusted-keys");
  if (keysPath || process.env.SWEETCRAFT_TRUSTED_PUBLIC_KEYS_FILE) {
    trustedKeys = await loadTrustedKeys({ file: keysPath, fromEnv: !keysPath });
  }
  const r = await verifyRelease({
    releaseDir: path.resolve(release),
    trustedKeys,
    allowUnsignedDev: !flag("--require-signed")
  });
  console.log(formatVerifyReport(r));
  process.exitCode = r.ok ? 0 : 2;
} else if (cmd === "verify-channel") {
  const channel = opt("--channel");
  if (!channel) throw new Error("--channel <file> obligatoire");
  const root = opt("--root");
  if (!root) throw new Error("--root <publish root> obligatoire");
  let trustedKeys: TrustedKeys | undefined;
  const keysPath = opt("--trusted-keys");
  if (keysPath || process.env.SWEETCRAFT_TRUSTED_PUBLIC_KEYS_FILE) {
    trustedKeys = await loadTrustedKeys({ file: keysPath, fromEnv: !keysPath });
  }
  const r = await verifyChannelDescriptor({
    channelFile: path.resolve(channel),
    root: path.resolve(root),
    trustedKeys,
    allowUnsignedDev: !flag("--require-signed")
  });
  console.log(formatVerifyChannelReport(r));
  process.exitCode = r.ok ? 0 : 2;
} else if (cmd === "publish") {
  const release = opt("--release");
  if (!release) throw new Error("--release <dir> obligatoire");
  const channelRaw = opt("--channel");
  if (!channelRaw) throw new Error("--channel <dev|beta|stable> obligatoire");
  const sequenceRaw = opt("--sequence");
  if (!sequenceRaw) throw new Error("--sequence <entier positif> obligatoire");
  const outDir = opt("--out-dir");
  if (!outDir) throw new Error("--out-dir <dir> obligatoire");
  const sequence = Number(sequenceRaw);
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new Error("--sequence doit être un entier positif");
  }
  let trustedKeys: TrustedKeys | undefined;
  const keysPath = opt("--trusted-keys");
  if (keysPath || process.env.SWEETCRAFT_TRUSTED_PUBLIC_KEYS_FILE) {
    trustedKeys = await loadTrustedKeys({ file: keysPath, fromEnv: !keysPath });
  }
  try {
    const r = await publishRelease({
      releaseDir: path.resolve(release),
      channel: channelRaw as ReleaseChannel,
      sequence,
      outDir: path.resolve(outDir),
      trustedKeys,
      allowUnsignedDev: flag("--allow-unsigned-dev")
    });
    console.log(formatPublishReport(r, "OK"));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Publication échouée: ${msg}`);
    process.exitCode = e instanceof PublishError ? 2 : 1;
  }
} else if (cmd === "verify-origin") {
  const transaction = opt("--transaction");
  if (!transaction) throw new Error("--transaction <dir> obligatoire");
  const channelRaw = opt("--channel");
  if (!channelRaw) throw new Error("--channel <dev|beta|stable> obligatoire");
  const keysPath = opt("--trusted-keys");
  if (!keysPath && !process.env.SWEETCRAFT_TRUSTED_PUBLIC_KEYS_FILE) {
    throw new Error("--trusted-keys <json> obligatoire (ou SWEETCRAFT_TRUSTED_PUBLIC_KEYS_FILE)");
  }
  try {
    const trustedKeys = await loadTrustedKeys({ file: keysPath, fromEnv: !keysPath });
    const r = await verifyOrigin({
      transactionDir: path.resolve(transaction),
      channel: channelRaw as ReleaseChannel,
      trustedKeys
    });
    if (flag("--json")) console.log(JSON.stringify(originVerifyToJson(r)));
    else console.log(formatOriginVerifyReport(r));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (flag("--json")) {
      console.log(JSON.stringify({ ok: false, error: msg, channel: channelRaw }));
    } else {
      console.error(`ORIGIN_VERIFY_FAIL: ${msg}`);
    }
    process.exitCode = e instanceof OriginVerifyError ? 2 : 1;
  }
} else if (cmd === "upload") {
  const root = opt("--root");
  if (!root) throw new Error("--root <publish root> obligatoire");
  const channelRaw = opt("--channel");
  if (!channelRaw) throw new Error("--channel <dev|beta|stable> obligatoire");
  const host = opt("--host");
  if (!host) throw new Error("--host obligatoire");
  const user = opt("--user");
  if (!user) throw new Error("--user obligatoire");
  for (const bad of ["--password", "--root-password", "--disable-host-key-check", "--insecure"]) {
    if (flag(bad) || args.includes(bad)) throw new Error(`option interdite: ${bad}`);
  }
  const portRaw = opt("--port", "22")!;
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port invalide");
  const timeoutRaw = opt("--timeout", "60")!;
  const timeoutSeconds = Number(timeoutRaw);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error("--timeout doit être un nombre fini strictement positif (secondes)");
  }
  const keysPath = opt("--trusted-keys");
  if (!keysPath && !process.env.SWEETCRAFT_TRUSTED_PUBLIC_KEYS_FILE) {
    throw new Error("--trusted-keys <json> obligatoire (ou SWEETCRAFT_TRUSTED_PUBLIC_KEYS_FILE)");
  }
  try {
    const trustedKeys = await loadTrustedKeys({ file: keysPath, fromEnv: !keysPath });
    const r = await remotePublish({
      root: path.resolve(root),
      channel: channelRaw as ReleaseChannel,
      host,
      user,
      identity: opt("--identity"),
      port,
      origin: opt("--origin"),
      timeoutSeconds,
      keepFailedTransaction: flag("--keep-failed-transaction"),
      trustedKeys
    });
    console.log(formatRemotePublishReport(r));
  } catch (e) {
    if (e instanceof RemotePublishError) {
      console.error(formatRemotePublishFail(e));
      process.exitCode = 2;
    } else {
      console.error(`REMOTE_PUBLISH_FAIL\n${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
    }
  }
} else if (cmd === "scan") {
  const mods = opt("--mods");
  if (!mods) throw new Error("--mods <dossier> obligatoire");
  const config = opt("--config"), out = opt("--out", "data/current.json")!, base = await readCatalog(baseline);
  const scanned = await scanInstance(path.resolve(mods), config ? path.resolve(config) : undefined, base);
  const byHash = new Map(base.mods.map(m => [m.sha256, m])), byId = new Map(base.mods.map(m => [m.mod_id, m]));
  scanned.mods = scanned.mods.map(m => {
    const old = byHash.get(m.sha256) ?? byId.get(m.mod_id);
    if (!old) return m;
    return {
      ...m,
      side_class: old.side_class,
      install_client: old.install_client,
      install_server: old.install_server,
      client_required_to_join: old.client_required_to_join,
      server_required: old.server_required,
      side_confidence: old.side_confidence,
      side_web_verified: old.side_web_verified,
      license_class: old.license_class,
      distribution_policy: old.distribution_policy,
      legal_note: old.legal_note,
      provider_preference: old.provider_preference,
      modrinth_url: old.modrinth_url,
      curseforge_url: old.curseforge_url,
      curseforge_project_id: old.curseforge_project_id,
      author_provider: old.author_provider,
      author_project: old.author_project,
      homepage: old.homepage ?? m.homepage
    };
  });
  await writeJson(out, scanned);
  console.log(`Scan écrit: ${out} (${scanned.mods.length} mods)`);
} else throw new Error(`Commande inconnue: ${cmd}`);
