import type { Catalog } from "./types.js";
export function diffCatalog(a: Catalog, b: Catalog) {
  const A = new Map(a.mods.map(x => [x.mod_id, x])), B = new Map(b.mods.map(x => [x.mod_id, x]));
  const added = [...B.keys()].filter(k => !A.has(k)).map(k => B.get(k)!);
  const removed = [...A.keys()].filter(k => !B.has(k)).map(k => A.get(k)!);
  const changed = [...B.keys()].filter(k => A.has(k) && (
    A.get(k)!.sha256 !== B.get(k)!.sha256 ||
    A.get(k)!.version !== B.get(k)!.version ||
    A.get(k)!.side_class !== B.get(k)!.side_class
  )).map(k => ({before:A.get(k)!, after:B.get(k)!}));
  const ca = new Map(a.configs.map(x => [x.path,x])), cb = new Map(b.configs.map(x => [x.path,x]));
  return {
    mods: {added, removed, changed},
    configs: {
      added:[...cb.keys()].filter(k=>!ca.has(k)).map(k=>cb.get(k)!),
      removed:[...ca.keys()].filter(k=>!cb.has(k)).map(k=>ca.get(k)!),
      changed:[...cb.keys()].filter(k=>ca.has(k)&&ca.get(k)!.sha256!==cb.get(k)!.sha256).map(k=>({before:ca.get(k)!,after:cb.get(k)!}))
    }
  };
}
