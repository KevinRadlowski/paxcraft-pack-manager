/**
 * Public product base URL for CDN verification (--origin).
 * Example production: https://cdn.xnosweet.fr/sweetcraft
 * → https://cdn.xnosweet.fr/sweetcraft/channels/dev.json
 */

export class OriginUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OriginUrlError";
  }
}

export interface NormalizeOriginOptions {
  /** Default true — production CDN must be HTTPS. */
  requireHttps?: boolean;
}

/**
 * Normalize a SweetCraft product public base URL.
 * - Absolute URL
 * - HTTPS required by default
 * - No credentials, fragment, or query
 * - Trailing slash stripped (path preserved, e.g. /sweetcraft)
 * - Never produces double slashes when joining /channels or /releases
 */
export function normalizeProductOriginUrl(
  raw: string,
  opts: NormalizeOriginOptions = {}
): string {
  const requireHttps = opts.requireHttps !== false;
  if (typeof raw !== "string" || !raw.trim()) {
    throw new OriginUrlError("--origin vide ou invalide");
  }
  const trimmed = raw.trim();

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new OriginUrlError(`--origin URL absolue invalide: ${raw}`);
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new OriginUrlError(`--origin protocole non supporté: ${url.protocol}`);
  }
  if (requireHttps && url.protocol !== "https:") {
    throw new OriginUrlError("--origin doit être HTTPS (http refusé par défaut)");
  }
  if (url.username || url.password) {
    throw new OriginUrlError("--origin ne doit pas contenir de credentials user:password");
  }
  if (url.hash) {
    throw new OriginUrlError("--origin ne doit pas contenir de fragment (#...)");
  }
  if (url.search) {
    throw new OriginUrlError("--origin ne doit pas contenir de query string (?...)");
  }

  // pathname: collapse duplicate slashes, strip trailing slash (except root-only)
  let pathname = url.pathname.replace(/\/{2,}/g, "/");
  if (pathname.length > 1 && pathname.endsWith("/")) {
    pathname = pathname.slice(0, -1);
  }
  if (pathname === "/") {
    pathname = "";
  }

  const host = url.host; // includes port if non-default
  return `${url.protocol}//${host}${pathname}`;
}

/** Join origin + relative path without producing //seg (except after scheme). */
export function joinOriginPath(origin: string, ...segments: string[]): string {
  const base = normalizeProductOriginUrl(origin);
  const parts = segments
    .flatMap(s => s.split("/"))
    .map(s => s.trim())
    .filter(s => s.length > 0);
  if (parts.some(p => p === ".." || p === ".")) {
    throw new OriginUrlError("segments de path interdits (.. ou .)");
  }
  return parts.length ? `${base}/${parts.join("/")}` : base;
}

export function publicChannelUrl(origin: string, channel: string, cacheBuster?: string): string {
  const url = joinOriginPath(origin, "channels", `${channel}.json`);
  return cacheBuster ? `${url}?verify=${cacheBuster}` : url;
}

export function publicReleaseJsonUrl(origin: string, packVersion: string): string {
  return joinOriginPath(origin, "releases", packVersion, "release.json");
}

/** {origin}/releases/{packVersion}/files/{relativeUnderFiles} */
export function publicReleaseFilesUrl(
  origin: string,
  packVersion: string,
  relativeUnderFiles: string
): string {
  const rel = relativeUnderFiles.replace(/\\/g, "/").replace(/^\/+/, "");
  if (rel.includes("..") || rel.startsWith("/") || /^[a-zA-Z]:/.test(rel)) {
    throw new OriginUrlError(`relativeUnderFiles unsafe: ${relativeUnderFiles}`);
  }
  return joinOriginPath(origin, "releases", packVersion, "files", ...rel.split("/"));
}
