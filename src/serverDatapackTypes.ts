/** Public server-manifest datapack entry (schema 6 extension on server manifest only). */
export interface ManifestServerDatapackFile {
  /** POSIX path relative to dedicated server root (e.g. world/datapacks/foo/pack.mcmeta). */
  path: string;
  sha256: string;
  size: number;
}

export interface ManifestServerDatapack {
  id: string;
  displayName: string;
  version: string;
  /** Folder root on dedicated server (POSIX). */
  targetPath: string;
  /** Pack-owned server content — force replace on deploy/update. */
  apply: "force";
  fileCount: number;
  totalBytes: number;
  /** Deterministic fingerprint: SHA-256 of sorted `sha256\\tsize\\tpath\\n` lines. */
  treeSha256: string;
  files: ManifestServerDatapackFile[];
}

/** Build-local config (sourcePath never in public manifests). */
export interface ServerDatapackSourceConfig {
  id: string;
  displayName: string;
  version: string;
  sourcePath: string;
  targetPath: string;
  apply?: "force";
}

export interface ServerDatapacksConfigFile {
  serverDatapacks: ServerDatapackSourceConfig[];
}

/** Prepared datapack ready for staging (includes local source for copy only). */
export interface PreparedServerDatapack {
  id: string;
  displayName: string;
  version: string;
  targetPath: string;
  apply: "force";
  fileCount: number;
  totalBytes: number;
  treeSha256: string;
  files: ManifestServerDatapackFile[];
  /** Absolute local folder root — staging only. */
  sourceAbsolutePath: string;
}
