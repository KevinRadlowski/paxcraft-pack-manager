/** Public manifest resource pack entry (schema 6). No local sourcePath. */
export interface ManifestResourcePack {
  id: string;
  displayName: string;
  version: string;
  targetPath: string;
  sha256: string;
  size: number;
  autoEnable: boolean;
}

/** Build-local config entry (sourcePath must never appear in public manifests). */
export interface ResourcePackSourceConfig {
  id: string;
  displayName: string;
  version: string;
  sourcePath: string;
  target: "CLIENT";
  targetPath: string;
  autoEnable: boolean;
}

export interface ResourcePacksConfigFile {
  resourcePacks: ResourcePackSourceConfig[];
}

/** Prepared pack ready for staging (includes local source for copy only). */
export interface PreparedResourcePack {
  id: string;
  displayName: string;
  version: string;
  target: "CLIENT";
  targetPath: string;
  autoEnable: boolean;
  sha256: string;
  size: number;
  /** Absolute local path — staging only, never written to manifests. */
  sourceAbsolutePath: string;
  /** Path inside release tree: files/resourcepacks/... */
  releaseStoragePath: string;
}
