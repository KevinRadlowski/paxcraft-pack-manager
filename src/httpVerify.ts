import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { normalizeProductOriginUrl, publicChannelUrl, publicReleaseJsonUrl } from "./originUrl.js";

export interface HttpFetchResult {
  status: number;
  body: Buffer;
}

export type HttpFetcher = (
  url: string,
  init?: { headers?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal }
) => Promise<HttpFetchResult>;

/** Default fetcher: per-attempt AbortController timeout (does not disable retries). */
export function createDefaultHttpFetcher(defaultTimeoutMs: number): HttpFetcher {
  return async (url, init) => {
    const timeoutMs = init?.timeoutMs ?? defaultTimeoutMs;
    const controller = new AbortController();
    const external = init?.signal;
    const onAbort = () => controller.abort();
    if (external) {
      if (external.aborted) controller.abort();
      else external.addEventListener("abort", onAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: init?.headers,
        redirect: "follow",
        signal: controller.signal
      });
      const ab = await res.arrayBuffer();
      return { status: res.status, body: Buffer.from(ab) };
    } catch (e) {
      if (controller.signal.aborted) {
        throw new Error(`HTTP timeout after ${timeoutMs}ms`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
      if (external) external.removeEventListener("abort", onAbort);
    }
  };
}

/** @deprecated prefer createDefaultHttpFetcher(timeoutMs) — kept for tests that inject their own fetcher */
export const defaultHttpFetcher: HttpFetcher = createDefaultHttpFetcher(60_000);

export function sha256Buffer(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export async function sha256File(file: string): Promise<string> {
  return sha256Buffer(await fs.readFile(file));
}

export interface HttpsVerifyOptions {
  origin: string;
  channel: string;
  packVersion: string;
  localChannelPath: string;
  localReleaseJsonPath: string;
  fetchFn?: HttpFetcher;
  /** Max attempts including first try. Default 5. */
  maxAttempts?: number;
  /** Base delay ms between retries. Default 200. */
  retryDelayMs?: number;
  /** Per-attempt HTTP timeout ms. */
  attemptTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface HttpsVerifyResult {
  channelOk: boolean;
  releaseOk: boolean;
  channelUrl: string;
  releaseUrl: string;
  channelRemoteSha256: string;
  releaseRemoteSha256: string;
  channelLocalSha256: string;
  releaseLocalSha256: string;
}

function sleepDefault(ms: number) {
  return new Promise<void>(r => setTimeout(r, ms));
}

async function fetchWithRetry(
  fetchFn: HttpFetcher,
  url: string,
  headers: Record<string, string>,
  maxAttempts: number,
  retryDelayMs: number,
  sleep: (ms: number) => Promise<void>,
  attemptTimeoutMs?: number
): Promise<HttpFetchResult> {
  let last: HttpFetchResult | null = null;
  let lastErr: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      last = await fetchFn(url, { headers, timeoutMs: attemptTimeoutMs });
      if (last.status >= 200 && last.status < 300) return last;
      if (last.status >= 500 || last.status === 404) {
        if (i < maxAttempts - 1) await sleep(retryDelayMs * (i + 1));
        continue;
      }
      return last;
    } catch (e) {
      lastErr = e;
      if (i < maxAttempts - 1) await sleep(retryDelayMs * (i + 1));
    }
  }
  if (last) return last;
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Verify public HTTPS bytes match local channel + release.json exactly (SHA-256 of octets).
 */
export async function verifyHttpsPublication(opts: HttpsVerifyOptions): Promise<HttpsVerifyResult> {
  const origin = normalizeProductOriginUrl(opts.origin);
  const attemptTimeoutMs = opts.attemptTimeoutMs ?? 60_000;
  const fetchFn = opts.fetchFn ?? createDefaultHttpFetcher(attemptTimeoutMs);
  const maxAttempts = opts.maxAttempts ?? 5;
  const retryDelayMs = opts.retryDelayMs ?? 200;
  const sleep = opts.sleep ?? sleepDefault;

  const bust = randomCacheBuster();
  const channelUrl = publicChannelUrl(origin, opts.channel, bust);
  const releaseUrl = publicReleaseJsonUrl(origin, opts.packVersion);

  const headers = { "Cache-Control": "no-cache", Pragma: "no-cache" };

  const channelLocal = await fs.readFile(opts.localChannelPath);
  const releaseLocal = await fs.readFile(opts.localReleaseJsonPath);
  const channelLocalSha256 = sha256Buffer(channelLocal);
  const releaseLocalSha256 = sha256Buffer(releaseLocal);

  const chRes = await fetchWithRetry(
    fetchFn,
    channelUrl,
    headers,
    maxAttempts,
    retryDelayMs,
    sleep,
    attemptTimeoutMs
  );
  if (chRes.status === 404) throw new Error(`HTTPS channel 404: ${channelUrl}`);
  if (chRes.status >= 500) throw new Error(`HTTPS channel ${chRes.status}: ${channelUrl}`);
  if (chRes.status < 200 || chRes.status >= 300) {
    throw new Error(`HTTPS channel HTTP ${chRes.status}`);
  }

  const relRes = await fetchWithRetry(
    fetchFn,
    releaseUrl,
    headers,
    maxAttempts,
    retryDelayMs,
    sleep,
    attemptTimeoutMs
  );
  if (relRes.status === 404) throw new Error(`HTTPS release 404: ${releaseUrl}`);
  if (relRes.status >= 500) throw new Error(`HTTPS release ${relRes.status}: ${releaseUrl}`);
  if (relRes.status < 200 || relRes.status >= 300) {
    throw new Error(`HTTPS release HTTP ${relRes.status}`);
  }

  const channelRemoteSha256 = sha256Buffer(chRes.body);
  const releaseRemoteSha256 = sha256Buffer(relRes.body);

  if (channelRemoteSha256 !== channelLocalSha256) {
    throw new Error("HTTPS channel bytes différents du channel local");
  }
  if (releaseRemoteSha256 !== releaseLocalSha256) {
    throw new Error("HTTPS release bytes différents du release.json local");
  }

  const remoteCh = JSON.parse(chRes.body.toString("utf8")) as Record<string, unknown>;
  const localCh = JSON.parse(channelLocal.toString("utf8")) as Record<string, unknown>;
  for (const k of ["schemaVersion", "channel", "packVersion", "releaseSequence", "releasePath", "releaseSha256"]) {
    if (JSON.stringify(remoteCh[k]) !== JSON.stringify(localCh[k])) {
      throw new Error(`HTTPS channel metadata diverge: ${k}`);
    }
  }
  const rSig = remoteCh.signature as Record<string, unknown> | undefined;
  const lSig = localCh.signature as Record<string, unknown> | undefined;
  for (const k of ["algorithm", "publicKeyId", "value"]) {
    if (JSON.stringify(rSig?.[k]) !== JSON.stringify(lSig?.[k])) {
      throw new Error(`HTTPS channel signature meta diverge: ${k}`);
    }
  }

  const remoteRel = JSON.parse(relRes.body.toString("utf8")) as Record<string, unknown>;
  const localRel = JSON.parse(releaseLocal.toString("utf8")) as Record<string, unknown>;
  for (const k of ["schemaVersion", "packVersion", "product"]) {
    if (JSON.stringify(remoteRel[k]) !== JSON.stringify(localRel[k])) {
      throw new Error(`HTTPS release metadata diverge: ${k}`);
    }
  }

  return {
    channelOk: true,
    releaseOk: true,
    channelUrl,
    releaseUrl,
    channelRemoteSha256,
    releaseRemoteSha256,
    channelLocalSha256,
    releaseLocalSha256
  };
}

function randomCacheBuster(): string {
  return createHash("sha256").update(String(Date.now()) + Math.random()).digest("hex").slice(0, 12);
}
