import { randomBytes } from "node:crypto";
import type { ReleaseChannel } from "./releasePayload.js";

export const INCOMING_ROOT = "/srv/sweetcraft/incoming";
export const PUBLIC_ROOT = "/srv/sweetcraft/public/sweetcraft";
export const DEFAULT_ORIGIN = "https://cdn.xnosweet.fr/sweetcraft";
export const REMOTE_NODE = "/opt/sweetcraft/node/current/bin/node";
/** Default system install path (docs/ORIGIN_VERIFIER.md). */
export const REMOTE_VERIFIER_DEFAULT = "/usr/local/lib/sweetcraft-verifier/cli.js";
export const REMOTE_VERIFIER = REMOTE_VERIFIER_DEFAULT;
export const REMOTE_TRUSTED_KEYS = "/etc/sweetcraft/trusted-keys.json";
export const REMOTE_COMMIT_GATE = "/usr/local/sbin/sweetcraft-release-commit";

/**
 * Resolve remote verify-origin CLI path.
 * Optional SWEETCRAFT_REMOTE_VERIFIER for a rebuilt verifier staged on the VPS
 * when /usr/local/lib is not writable by the deploy user (must still be cli.js).
 */
export function resolveRemoteVerifierPath(
  env: NodeJS.ProcessEnv = process.env
): string {
  const raw = env.SWEETCRAFT_REMOTE_VERIFIER?.trim();
  if (!raw) return REMOTE_VERIFIER_DEFAULT;
  if (raw.includes("\0") || raw.includes("\\") || raw.includes("..")) {
    throw new Error("SWEETCRAFT_REMOTE_VERIFIER path unsafe");
  }
  if (!raw.startsWith("/") || !raw.endsWith("/cli.js")) {
    throw new Error("SWEETCRAFT_REMOTE_VERIFIER must be absolute posix …/cli.js");
  }
  const allowedPrefixes = [
    "/usr/local/lib/sweetcraft-verifier/",
    "/home/sweetcraft-deploy/",
    "/opt/sweetcraft/"
  ];
  if (!allowedPrefixes.some(p => raw.startsWith(p) || raw === REMOTE_VERIFIER_DEFAULT)) {
    throw new Error("SWEETCRAFT_REMOTE_VERIFIER outside allowed prefixes");
  }
  return raw;
}

const TX_RE = /^sc-(dev|beta|stable)-[0-9A-Za-z][0-9A-Za-z._-]{0,63}-s[1-9][0-9]{0,9}-[0-9a-f]{12}$/;
const PACK_VERSION_RE = /^\d+\.\d+\.\d+([.-][0-9A-Za-z.-]+)?$/;

export function assertReleaseChannel(ch: string): asserts ch is ReleaseChannel {
  if (ch !== "dev" && ch !== "beta" && ch !== "stable") {
    throw new Error(`channel invalide (dev|beta|stable): ${ch}`);
  }
}

export function assertPackVersion(v: string): void {
  if (!PACK_VERSION_RE.test(v)) {
    throw new Error(`packVersion invalide: ${v}`);
  }
  if (v.includes("..") || v.includes("/") || v.includes("\\") || v.includes("\0")) {
    throw new Error(`packVersion malveillant rejeté: ${v}`);
  }
}

export function assertPositiveSequence(n: number): void {
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`releaseSequence invalide: ${n}`);
  }
}

/** Validate a client-generated transaction id before any remote use. */
export function assertTransactionId(tx: string): void {
  if (!TX_RE.test(tx)) {
    throw new Error(`transaction ID invalide: ${tx}`);
  }
  if (tx.includes("..") || tx.includes("/") || tx.includes("\\") || tx.includes("\0")) {
    throw new Error(`transaction traversal impossible: ${tx}`);
  }
}

export function generateTransactionId(
  channel: ReleaseChannel,
  packVersion: string,
  sequence: number
): string {
  assertReleaseChannel(channel);
  assertPackVersion(packVersion);
  assertPositiveSequence(sequence);
  const rand = randomBytes(6).toString("hex");
  const tx = `sc-${channel}-${packVersion}-s${sequence}-${rand}`;
  assertTransactionId(tx);
  return tx;
}

export function incomingTransactionPath(tx: string): string {
  assertTransactionId(tx);
  return `${INCOMING_ROOT}/${tx}`;
}

export function incomingReleasePath(tx: string, packVersion: string): string {
  assertTransactionId(tx);
  assertPackVersion(packVersion);
  return `${INCOMING_ROOT}/${tx}/releases/${packVersion}`;
}

export function incomingChannelPath(tx: string, channel: ReleaseChannel): string {
  assertTransactionId(tx);
  assertReleaseChannel(channel);
  return `${INCOMING_ROOT}/${tx}/channels/${channel}.json`;
}

/**
 * POSIX single-quote shell escaping for remote argv that may still pass through a remote shell.
 * Output is always a single-quoted literal safe for /bin/sh.
 */
export function posixShellQuote(value: string): string {
  if (value.includes("\0")) {
    throw new Error("null byte in shell quote");
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function assertNoForbiddenSshOpts(args: string[]): void {
  const joined = args.join(" ");
  if (/StrictHostKeyChecking\s*=\s*no/i.test(joined)) {
    throw new Error("StrictHostKeyChecking=no interdit");
  }
  if (/UserKnownHostsFile\s*=\s*\/dev\/null/i.test(joined)) {
    throw new Error("UserKnownHostsFile=/dev/null interdit");
  }
  if (joined.includes(PUBLIC_ROOT)) {
    throw new Error("écriture public interdite côté client");
  }
}
