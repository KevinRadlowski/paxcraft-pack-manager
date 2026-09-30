/**
 * Canonical signing payloads for SweetCraft releases and channels.
 * UTF-8, LF only, fixed field order — no JSON indentation dependency.
 */

export const RELEASE_SIGNING_PAYLOAD_ID = "SWEETCRAFT-RELEASE-SIGNATURE-V1";
export const CHANNEL_SIGNING_PAYLOAD_ID = "SWEETCRAFT-CHANNEL-SIGNATURE-V1";

export type ReleaseChannel = "stable" | "beta" | "dev";

export interface ReleaseSigningFields {
  product: string;
  packVersion: string;
  minecraft: string;
  fabricLoader: string;
  server: string;
  packManagerVersion: string;
  catalogSchemaVersion: number;
  manifestSchemaVersion: number;
  releaseSchemaVersion: number;
  configBase: string;
  /** null/undefined = unset (local staging). Positive integer when published. */
  releaseSequence: number | null | undefined;
  clientManifestSha256: string;
  serverManifestSha256: string;
  checksumsSha256: string;
}

export interface ChannelSigningFields {
  channel: ReleaseChannel | string;
  packVersion: string;
  releaseSequence: number;
  releasePath: string;
  releaseSha256: string;
}

function assertScalar(name: string, value: string) {
  if (value.includes("\n") || value.includes("\r") || value.includes("\0")) {
    throw new Error(`signing field ${name} contains forbidden control characters`);
  }
}

function line(key: string, value: string): string {
  assertScalar(key, value);
  return `${key}=${value}`;
}

/**
 * Build the exact bytes signed for a SweetCraft release.
 * Trailing LF after the last line is required.
 */
export function buildReleaseSigningPayload(f: ReleaseSigningFields): Buffer {
  const seq =
    f.releaseSequence === null || f.releaseSequence === undefined
      ? ""
      : String(f.releaseSequence);
  if (seq !== "" && !/^[1-9][0-9]*$/.test(seq)) {
    throw new Error(`releaseSequence must be empty or a positive integer, got: ${seq}`);
  }
  const lines = [
    RELEASE_SIGNING_PAYLOAD_ID,
    line("product", f.product),
    line("packVersion", f.packVersion),
    line("minecraft", f.minecraft),
    line("fabricLoader", f.fabricLoader),
    line("server", f.server),
    line("packManagerVersion", f.packManagerVersion),
    line("catalogSchemaVersion", String(f.catalogSchemaVersion)),
    line("manifestSchemaVersion", String(f.manifestSchemaVersion)),
    line("releaseSchemaVersion", String(f.releaseSchemaVersion)),
    line("configBase", f.configBase),
    line("releaseSequence", seq),
    line("clientManifestSha256", f.clientManifestSha256.toLowerCase()),
    line("serverManifestSha256", f.serverManifestSha256.toLowerCase()),
    line("checksumsSha256", f.checksumsSha256.toLowerCase())
  ];
  return Buffer.from(lines.join("\n") + "\n", "utf8");
}

/**
 * Build the exact bytes signed for a channel pointer descriptor.
 */
export function buildChannelSigningPayload(f: ChannelSigningFields): Buffer {
  if (!/^[1-9][0-9]*$/.test(String(f.releaseSequence))) {
    throw new Error(`channel releaseSequence must be a positive integer`);
  }
  const lines = [
    CHANNEL_SIGNING_PAYLOAD_ID,
    line("channel", f.channel),
    line("packVersion", f.packVersion),
    line("releaseSequence", String(f.releaseSequence)),
    line("releasePath", f.releasePath.replace(/\\/g, "/")),
    line("releaseSha256", f.releaseSha256.toLowerCase())
  ];
  return Buffer.from(lines.join("\n") + "\n", "utf8");
}

export interface ChannelDescriptor {
  schemaVersion: number;
  channel: ReleaseChannel | string;
  packVersion: string;
  releaseSequence: number;
  /** Relative path from CDN root, e.g. releases/0.1.0/release.json */
  releasePath: string;
  /** SHA-256 of the release.json bytes (includes its signature block). */
  releaseSha256: string;
  signature: {
    status: "signed" | "unsigned-dev";
    algorithm: "ed25519";
    publicKeyId: string | null;
    payload: typeof CHANNEL_SIGNING_PAYLOAD_ID;
    value: string | null;
  };
}

export const CHANNEL_SCHEMA_VERSION = 1;
