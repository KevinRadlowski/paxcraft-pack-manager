/**
 * STEP-4.6-M7 — Release preflight contract (READ-ONLY).
 * Status precedence: ERROR > BLOCKED > EXTERNAL_VERIFY > PASS
 */

export type PreflightStatus = "PASS" | "BLOCKED" | "EXTERNAL_VERIFY" | "ERROR";

/** Exit codes for CLI / automation. */
export const PREFLIGHT_EXIT: Record<PreflightStatus, number> = {
  PASS: 0,
  ERROR: 1,
  BLOCKED: 2,
  EXTERNAL_VERIFY: 3
};

export const PREFLIGHT_SCHEMA_VERSION = 1 as const;

/** M5 certified deterministic FR RP ZIP SHA-256. */
export const APPROVED_FR_RP_ZIP_SHA256 =
  "7f69b6d0bf86ec8a78230cce6dd53d873edec7367c60947b97d1c6ceb883768d";

export const CASINO_MOD_ID = "xbasecasino";

export interface GateResult {
  id: string;
  status: PreflightStatus;
  detail: string;
  evidence?: Record<string, unknown>;
}

export interface CasinoGateEvidence {
  assemblyConsistency: PreflightStatus;
  certifiedProvenance: PreflightStatus;
  clientSha256?: string;
  serverSha256?: string;
  catalogSha256?: string;
  embeddedVersion?: string;
  catalogVersion?: string;
  provenanceReason?: string;
}

export interface ReleaseBomCandidate {
  schemaVersion: 1;
  generatedAt: "bom-dry-run";
  packVersion: string | "UNKNOWN";
  releaseSequence: number | "UNKNOWN";
  minecraft: string | "UNKNOWN";
  java: string | "UNKNOWN";
  fabricLoader: string | "UNKNOWN";
  fabricApi: string | "UNKNOWN";
  contentSourceIdentity: string | "UNKNOWN";
  contentTreeHash: string | "UNKNOWN";
  questSourceHash: string | "UNKNOWN";
  datapackSourceHash: string | "UNKNOWN";
  rpSourceHash: string | "UNKNOWN";
  rpZipSha256: string | "UNKNOWN";
  casinoVersion: string | "UNKNOWN";
  casinoClientSha256: string | "UNKNOWN";
  casinoServerSha256: string | "UNKNOWN";
  casinoCertifiedCommit: string | "UNKNOWN";
  casinoCertifiedArtifactSha256: string | "UNKNOWN";
  casinoProvenanceStatus: PreflightStatus | "UNKNOWN";
  packManagerSourceIdentity: string | "UNKNOWN";
  configCatalogueHash: string | "UNKNOWN";
  clientManifestIdentity: string | "UNKNOWN";
  serverManifestIdentity: string | "UNKNOWN";
  notes: string[];
}

export interface ReleasePreflightReport {
  schemaVersion: typeof PREFLIGHT_SCHEMA_VERSION;
  protocol: "STEP-4.6-M7-RELEASE-PREFLIGHT";
  status: PreflightStatus;
  exitCode: number;
  generatedAt: string;
  mutable: false;
  roots: {
    contentRoot: string;
    mfcRoot: string;
    catalogPath: string;
    casinoProvenancePath: string | null;
  };
  gates: GateResult[];
  casino: CasinoGateEvidence;
  bom: ReleaseBomCandidate;
  summary: string;
}

export interface CasinoProvenanceProof {
  schemaVersion: 1;
  approvedSourceCommit: string;
  certifiedArtifactSha256: string;
  certifiedVersion: string;
  attestationRef?: string;
  bomRef?: string;
}

export interface ReleasePreflightOptions {
  contentRoot: string;
  mfcRoot: string;
  /** Absolute path to release-ready catalogue (catalog.configs.json). */
  catalogPath: string;
  /** Optional Casino certified provenance proof JSON. Absent → provenance BLOCKED. */
  casinoProvenancePath?: string | null;
  /** Optional pack version for BOM (does not invent). */
  packVersion?: string | null;
  /** Optional release sequence for BOM. */
  releaseSequence?: number | null;
  /** Fixed timestamp for deterministic reports (tests). */
  generatedAt?: string;
  /** Optional PM repo root for source identity (git HEAD). */
  packManagerRoot?: string | null;
  /**
   * When true, DatHost / live remote Fabric version is marked EXTERNAL_VERIFY
   * (never inferred from notes).
   */
  requireDatHostExternalVerify?: boolean;
  /** Override approved FR RP ZIP SHA (fixtures only; production omits → M5 constant). */
  approvedFrRpSha256?: string;
}

/** Symbol token — only unit tests may bypass the stage assembly gate. */
export const UNIT_TEST_STAGE_BYPASS = Symbol.for("sweetcraft.releasePreflight.unitTestBypass");

export type StageAssemblyGate =
  | { mode: "run"; options: ReleasePreflightOptions }
  | { mode: "report"; report: ReleasePreflightReport }
  | { mode: "unit-test-bypass"; token: typeof UNIT_TEST_STAGE_BYPASS };
