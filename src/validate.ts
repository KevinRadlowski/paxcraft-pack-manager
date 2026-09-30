import type { Catalog } from "./types.js";
import { KNOWN_TARGETS, LEGACY_CLIENT_DEFAULT_PRESERVE } from "./configPolicyRules.js";
import {
  findClientDependencyClosureGaps,
  findServerDependencyClosureGaps
} from "./dependencyClosure.js";
import { CLEAN_FORBIDDEN_MOD_IDS } from "./curation.js";
import { resolveArtifactSource } from "./artifactSource.js";

export interface Finding {
  severity: "ERROR" | "WARN";
  code: string;
  subject: string;
  message: string;
}

export function releaseReady(c: Catalog): { ready: boolean; blocking: Finding[] } {
  const findings = validate(c);
  const blocking = findings.filter(x => x.severity === "ERROR");
  return { ready: blocking.length === 0, blocking };
}

export function validate(c: Catalog): Finding[] {
  const f: Finding[] = [];
  const ids = new Set<string>();
  const jars = new Set<string>();

  for (const m of c.mods) {
    if (ids.has(m.mod_id)) f.push({ severity: "ERROR", code: "DUPLICATE_MOD_ID", subject: m.mod_id, message: "mod_id dupliqué" });
    ids.add(m.mod_id);
    if (jars.has(m.jar)) f.push({ severity: "ERROR", code: "DUPLICATE_JAR", subject: m.jar, message: "nom de JAR dupliqué" });
    jars.add(m.jar);
    if (m.parse_error) f.push({ severity: "ERROR", code: "JAR_PARSE", subject: m.jar, message: m.parse_error });
    if (m.side_class === "UNKNOWN" || m.side_confidence === "REVIEW_REQUIRED") {
      f.push({ severity: "ERROR", code: "SIDE_REVIEW", subject: m.jar, message: "côté client/serveur non validé" });
    }
    if (m.side_upstream_relation === "REAL_CONFLICT" || m.side_confidence === "CONFLICT_REVIEW_REQUIRED") {
      f.push({ severity: "ERROR", code: "SIDE_CONFLICT", subject: m.jar, message: `SweetCraft=${m.side_class}, upstream=${m.modrinth_environment ?? "inconnu"}` });
    }
    if (["LEGAL_REVIEW", "BLOCKED"].includes(m.distribution_policy)) {
      f.push({ severity: "ERROR", code: "LEGAL_BLOCK", subject: m.jar, message: `distribution=${m.distribution_policy}` });
    }
    if (!m.sha256 || m.sha256.length !== 64) {
      f.push({ severity: "ERROR", code: "HASH", subject: m.jar, message: "SHA-256 absent/invalide" });
    }
    if (CLEAN_FORBIDDEN_MOD_IDS.has(m.mod_id)) {
      f.push({
        severity: "ERROR",
        code: "FORBIDDEN_MOD",
        subject: m.jar,
        message: `mod_id « ${m.mod_id} » interdit pour la baseline CLEAN (remplacé / retiré volontairement)`
      });
    }
    if (m.nested_errors?.length) {
      for (const err of m.nested_errors.slice(0, 5)) {
        f.push({
          severity: "ERROR",
          code: "NESTED_JAR",
          subject: m.jar,
          message: err
        });
      }
    }
    const hasUrl = !!(m.modrinth_file_url || m.curseforge_file_url || m.author_file_url);
    const staging = resolveArtifactSource(m);
    if (!hasUrl && staging.kind === "UNRESOLVED") {
      f.push({
        severity: "WARN",
        code: "PROVIDER_UNRESOLVED",
        subject: m.jar,
        message: `${staging.decision}: ${staging.reason}`
      });
    } else if (!hasUrl && (staging.kind === "LOCAL_CLEAN" || staging.kind === "CUSTOM_LOCAL")) {
      f.push({
        severity: "WARN",
        code: "RELEASE_HOSTED_NO_UPSTREAM_URL",
        subject: m.jar,
        message: `${staging.kind} from FINAL CLEAN — upstream URL optional for staging`
      });
    }
  }

  for (const cf of c.configs) {
    if (cf.policy === LEGACY_CLIENT_DEFAULT_PRESERVE) {
      f.push({
        severity: "ERROR",
        code: "LEGACY_CONFIG_POLICY",
        subject: cf.path,
        message: "CLIENT_DEFAULT_PRESERVE est obsolète — exécuter pnpm pack:configs (CLI: classify-configs) pour migrer"
      });
    }
    if (cf.policy === "COMMON_FORCE_REVIEW") {
      f.push({
        severity: "ERROR",
        code: "CONFIG_POLICY_REVIEW",
        subject: cf.path,
        message: "politique indéterminée (COMMON_FORCE_REVIEW) — release non prête"
      });
    }
    // Unresolved sensitive still blocks release (PHASE 0.6.2).
    if (cf.policy === "NEVER_CLIENT_SECRET_REVIEW") {
      f.push({
        severity: "ERROR",
        code: "SENSITIVE_CONFIG_UNRESOLVED",
        subject: cf.path,
        message: "NEVER_CLIENT_SECRET_REVIEW non résolu — EXCLUDE ou reclasse avant release"
      });
    } else if (cf.sensitive_review && cf.policy !== "EXCLUDED") {
      f.push({
        severity: "ERROR",
        code: "SENSITIVE_CONFIG_UNRESOLVED",
        subject: cf.path,
        message: "sensitive_review encore ouvert — résoudre via exclusion ou reclassification"
      });
    }
    if (cf.policy === "EXCLUDED") {
      f.push({
        severity: "WARN",
        code: "CONFIG_EXCLUDED",
        subject: cf.path,
        message: cf.exclusion_reason ?? cf.policy_reason ?? "exclu des manifests pack"
      });
    }

    if (cf.target == null || cf.target === "") {
      f.push({
        severity: "ERROR",
        code: "CONFIG_TARGET_MISSING",
        subject: cf.path,
        message: "target manquant — exécuter pnpm pack:configs (CLI: classify-configs)"
      });
    } else     if (!KNOWN_TARGETS.has(String(cf.target))) {
      f.push({
        severity: "ERROR",
        code: "CONFIG_TARGET_UNKNOWN",
        subject: cf.path,
        message: `target inconnu: ${cf.target}`
      });
    } else {
      const t = String(cf.target);
      if (cf.policy === "EXCLUDED" && t !== "NONE") {
        f.push({
          severity: "ERROR",
          code: "CONFIG_TARGET_INCOHERENT",
          subject: cf.path,
          message: `EXCLUDED exige target=NONE (reçu ${t})`
        });
      }
      if (cf.policy === "NEVER_CLIENT_SECRET_REVIEW" && (t === "CLIENT" || t === "BOTH")) {
        f.push({
          severity: "ERROR",
          code: "CONFIG_TARGET_INCOHERENT",
          subject: cf.path,
          message: `NEVER_CLIENT_SECRET_REVIEW ne peut pas cibler CLIENT/BOTH (reçu ${t})`
        });
      }
      if (cf.policy === "CLIENT_PRESERVE" && t !== "CLIENT") {
        f.push({
          severity: "ERROR",
          code: "CONFIG_TARGET_INCOHERENT",
          subject: cf.path,
          message: `CLIENT_PRESERVE exige target=CLIENT (reçu ${t})`
        });
      }
      if (cf.policy === "CLIENT_DEFAULT" && t !== "CLIENT") {
        f.push({
          severity: "ERROR",
          code: "CONFIG_TARGET_INCOHERENT",
          subject: cf.path,
          message: `CLIENT_DEFAULT exige target=CLIENT (reçu ${t})`
        });
      }
    }
  }

  // Pack-internal Fabric depends closure (source of truth: fabric.mod.json → ModRecord.depends).
  // Refuses publishing a client/server manifest that omits a required pack dependency.
  for (const gap of findClientDependencyClosureGaps(c)) {
    f.push({
      severity: "ERROR",
      code: "CLIENT_DEP_CLOSURE",
      subject: `${gap.dependentId}->${gap.dependencyId}`,
      message: gap.message
    });
  }
  for (const gap of findServerDependencyClosureGaps(c)) {
    f.push({
      severity: "ERROR",
      code: "SERVER_DEP_CLOSURE",
      subject: `${gap.dependentId}->${gap.dependencyId}`,
      message: gap.message
    });
  }

  return f;
}
