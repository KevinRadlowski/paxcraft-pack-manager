import type { SideClass } from "./types.js";

export function mapModrinthEnvironment(e?: string | null): SideClass | null {
  switch (e) {
    case "client_only": return "CLIENT_ONLY";
    case "server_only":
    case "dedicated_server_only": return "SERVER_ONLY";
    case "client_and_server": return "BOTH_REQUIRED";
    case "client_only_server_optional": return "CLIENT_REQUIRED_SERVER_OPTIONAL";
    case "server_only_client_optional": return "SERVER_REQUIRED_CLIENT_OPTIONAL";
    case "client_or_server": return "BOTH_INDEPENDENT";
    case "client_or_server_prefers_both": return "BOTH_INDEPENDENT";
    default: return null;
  }
}

type Rules = { clientAllowed:boolean; serverAllowed:boolean; clientRequired:boolean; serverRequired:boolean };
export function sideRules(s: SideClass): Rules {
  switch (s) {
    case "CLIENT_ONLY": return {clientAllowed:true,serverAllowed:false,clientRequired:true,serverRequired:false};
    case "SERVER_ONLY": return {clientAllowed:false,serverAllowed:true,clientRequired:false,serverRequired:true};
    case "BOTH_REQUIRED": return {clientAllowed:true,serverAllowed:true,clientRequired:true,serverRequired:true};
    case "CLIENT_REQUIRED_SERVER_OPTIONAL": return {clientAllowed:true,serverAllowed:true,clientRequired:true,serverRequired:false};
    case "SERVER_REQUIRED_CLIENT_OPTIONAL": return {clientAllowed:true,serverAllowed:true,clientRequired:false,serverRequired:true};
    case "BOTH_INDEPENDENT":
    case "INDEPENDENT": return {clientAllowed:true,serverAllowed:true,clientRequired:false,serverRequired:false};
    default: return {clientAllowed:true,serverAllowed:true,clientRequired:false,serverRequired:false};
  }
}

export type SideRelation = "EXACT" | "COMPATIBLE" | "UPSTREAM_MORE_PRECISE" | "REAL_CONFLICT" | "UNKNOWN";
export function reconcileSide(current: SideClass, upstream: SideClass | null): SideRelation {
  if (!upstream) return "UNKNOWN";
  if (current === upstream || ((current === "INDEPENDENT" || current === "BOTH_INDEPENDENT") && (upstream === "INDEPENDENT" || upstream === "BOTH_INDEPENDENT"))) return "EXACT";
  const a=sideRules(current), b=sideRules(upstream);
  // A SweetCraft deployment cannot install on a side explicitly forbidden upstream.
  if ((a.clientRequired && !b.clientAllowed) || (a.serverRequired && !b.serverAllowed)) return "REAL_CONFLICT";
  // If upstream says a side is mandatory but SweetCraft explicitly forbids/omits it, conflict.
  if ((b.clientRequired && !a.clientAllowed) || (b.serverRequired && !a.serverAllowed)) return "REAL_CONFLICT";
  // Optional/permissive differences are not conflicts; the curated SweetCraft deployment may be stricter.
  if (b.clientRequired !== a.clientRequired || b.serverRequired !== a.serverRequired) return "UPSTREAM_MORE_PRECISE";
  return "COMPATIBLE";
}

export function installFlags(side: SideClass){
  return { install_client: side !== "SERVER_ONLY", install_server: side !== "CLIENT_ONLY" };
}
