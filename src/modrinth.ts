import { promises as fs } from "node:fs";
import path from "node:path";
import type { Catalog, ModRecord } from "./types.js";
import { mapModrinthEnvironment, reconcileSide } from "./side.js";

const API = "https://api.modrinth.com/v2";
const USER_AGENT = process.env.SWEETCRAFT_USER_AGENT ?? "Maidenhead/SweetCraft-PackManager/0.3.0";
type MRFile={hashes:{sha512?:string;sha1?:string};url:string;filename:string;primary:boolean;size:number};
type MRVersion={id:string;project_id:string;version_number:string;game_versions:string[];loaders:string[];environment?:string;files:MRFile[]};
async function postHashes(hashes:string[]):Promise<Record<string,MRVersion>>{
  const r=await fetch(`${API}/version_files`,{method:"POST",headers:{"content-type":"application/json","user-agent":USER_AGENT},body:JSON.stringify({hashes,algorithm:"sha512"})});
  if(!r.ok) throw new Error(`Modrinth HTTP ${r.status}: ${await r.text()}`);
  return await r.json() as Record<string,MRVersion>;
}
export async function resolveModrinth(c:Catalog, cacheDir="data/cache/modrinth"):Promise<{catalog:Catalog;found:number;missing:number;realConflicts:number;compatibleDifferences:number}> {
  await fs.mkdir(cacheDir,{recursive:true});
  const hashes=c.mods.map(m=>m.sha512).filter((x):x is string=>!!x);
  const chunks:string[][]=[]; for(let i=0;i<hashes.length;i+=100) chunks.push(hashes.slice(i,i+100));
  const all:Record<string,MRVersion>={};
  for(const chunk of chunks){
    const key=chunk.join("_").slice(0,80); const cache=path.join(cacheDir,`${key}.json`);
    let data:Record<string,MRVersion>;
    try{data=JSON.parse(await fs.readFile(cache,"utf8"));}catch{data=await postHashes(chunk);await fs.writeFile(cache,JSON.stringify(data,null,2));}
    Object.assign(all,data);
  }
  let found=0,missing=0,realConflicts=0,compatibleDifferences=0;
  const mods:ModRecord[]=c.mods.map(m=>{
    if(!m.sha512){missing++;return m;} const v=all[m.sha512]; if(!v){missing++;return m;} found++;
    const file=v.files.find(x=>x.hashes.sha512===m.sha512)??v.files.find(x=>x.primary)??v.files[0];
    const mrSide=mapModrinthEnvironment(v.environment); const relation=reconcileSide(m.side_class,mrSide);
    let confidence=m.side_confidence;
    if(m.side_class==="UNKNOWN" && mrSide){ confidence="HIGH_MODRINTH"; }
    else if(relation==="REAL_CONFLICT"){ realConflicts++; confidence="CONFLICT_REVIEW_REQUIRED"; }
    else if(relation==="COMPATIBLE"||relation==="UPSTREAM_MORE_PRECISE"){ compatibleDifferences++; if(confidence==="CONFLICT_REVIEW_REQUIRED") confidence="HIGH_RECONCILED"; }
    else if(relation==="EXACT" && confidence==="CONFLICT_REVIEW_REQUIRED") confidence="HIGH_RECONCILED";
    return {...m,side_confidence:confidence,side_web_verified:!!mrSide,side_upstream_relation:relation,
      provider_preference:"modrinth",modrinth_project_id:v.project_id,modrinth_version_id:v.id,
      modrinth_file_url:file?.url??null,modrinth_filename:file?.filename??null,modrinth_environment:v.environment??null,
      modrinth_game_versions:v.game_versions,modrinth_loaders:v.loaders,provider_resolution_status:"RESOLVED",provider_resolved_at:new Date().toISOString()};
  });
  return {catalog:{...c,mods},found,missing,realConflicts,compatibleDifferences};
}
