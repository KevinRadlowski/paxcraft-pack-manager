import type { Catalog, ModRecord } from "./types.js";

interface GHAsset {name:string;browser_download_url:string;size:number;}
interface GHRelease {tag_name:string;assets:GHAsset[];html_url:string;}
async function release(repo:string, tag:string):Promise<GHRelease|null>{
  const headers:Record<string,string>={"accept":"application/vnd.github+json","user-agent":"Maidenhead/SweetCraft-PackManager/0.3.0"};
  if(process.env.GITHUB_TOKEN) headers.authorization=`Bearer ${process.env.GITHUB_TOKEN}`;
  const r=await fetch(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`,{headers});
  if(r.status===404) return null;
  if(!r.ok) throw new Error(`GitHub HTTP ${r.status}: ${await r.text()}`);
  return await r.json() as GHRelease;
}
export async function resolveGitHub(c:Catalog):Promise<{catalog:Catalog;found:number;missing:number}> {
  let found=0,missing=0; const mods:ModRecord[]=[];
  for(const m of c.mods){
    if(m.modrinth_version_id || m.curseforge_file_id || m.author_provider!=="github-releases" || !m.author_project){mods.push(m);continue;}
    const tags=[m.version.startsWith("v")?m.version:`v${m.version}`,m.version];
    let rel:GHRelease|null=null;
    for(const t of tags){rel=await release(m.author_project,t);if(rel)break;}
    if(!rel){missing++;mods.push({...m,provider_resolution_status:"AUTHOR_RELEASE_NOT_FOUND"});continue;}
    const asset=rel.assets.find(a=>a.name===m.jar) ?? rel.assets.find(a=>a.name.endsWith('.jar') && a.size===m.size_bytes);
    if(!asset){missing++;mods.push({...m,provider_resolution_status:"AUTHOR_ASSET_NOT_FOUND"});continue;}
    found++; mods.push({...m,provider_preference:"author",author_release_url:rel.html_url,author_file_url:asset.browser_download_url,
      author_filename:asset.name,provider_resolution_status:"RESOLVED",provider_resolved_at:new Date().toISOString()});
  }
  return {catalog:{...c,mods},found,missing};
}
