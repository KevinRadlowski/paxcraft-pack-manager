import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SystemSshTransport,
  remoteMkdirTransactionCommand,
  remoteVerifyOriginCommand,
  remoteRmTransactionCommand
} from "../dist/sshTransport.js";
import { generateTransactionId, incomingTransactionPath } from "../dist/remotePaths.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const QUEST_PATHS = [
  "files/world/datapacks/SweetCraft_Quest_Support/pack.mcmeta",
  "files/world/datapacks/SweetCraft_Quest_Support/data/sweetcraft/advancement/eat_cooked_food.json",
  "files/world/datapacks/SweetCraft_Quest_Support/data/sweetcraft/advancement/trade_with_villager.json",
  "files/world/datapacks/SweetCraft_Quest_Support/data/sweetcraft/tags/item/beds.json",
  "files/world/datapacks/SweetCraft_Quest_Support/data/sweetcraft/tags/item/cooked_foods.json",
  "files/world/datapacks/SweetCraft_Quest_Support/data/sweetcraft/tags/item/cooking_pot_outputs.json",
  "files/world/datapacks/SweetCraft_Quest_Support/data/sweetcraft/tags/worldgen/structure/better_archeology_sites.json"
];

const target = {
  host: "87.106.2.194",
  user: "sweetcraft-deploy",
  port: 22,
  identity: `${process.env.USERPROFILE}/.ssh/sweetcraft/deploy_ed25519`,
  batchMode: true,
  timeoutMs: 180000
};
const transport = new SystemSshTransport();
const tx = generateTransactionId("dev", "0.1.4", 5);

async function sha256File(p) {
  return createHash("sha256").update(await fs.readFile(p)).digest("hex");
}

function emit(label, obj) {
  console.log(`${label} ${JSON.stringify(obj)}`);
}

let verifyRes = null;
try {
  for (const rel of QUEST_PATHS) {
    const abs = path.join(root, "data/publish/releases/0.1.4", rel);
    await fs.access(abs);
    emit("local_quest_file", { path: rel, sha256: await sha256File(abs) });
  }

  emit("transaction_id", { tx });
  const mkdirRes = await transport.ssh(target, remoteMkdirTransactionCommand(tx));
  emit("mkdir_tx", { code: mkdirRes.code, out: (mkdirRes.stderr || mkdirRes.stdout).trim() });
  if (mkdirRes.code !== 0) process.exit(2);

  const publishRelease = path.join(root, "data/publish/releases/0.1.4");
  const publishChannel = path.join(root, "data/publish/channels/dev.json");
  const remoteRelease = `${incomingTransactionPath(tx)}/releases/0.1.4`;
  const remoteChannel = `${incomingTransactionPath(tx)}/channels/dev.json`;

  const scpRel = await transport.scpTo(target, publishRelease, remoteRelease, true);
  emit("scp_release", { code: scpRel.code, out: (scpRel.stderr || scpRel.stdout).trim().slice(0, 200) });
  if (scpRel.code !== 0) process.exit(3);

  const scpCh = await transport.scpTo(target, publishChannel, remoteChannel, false);
  emit("scp_channel", { code: scpCh.code, out: (scpCh.stderr || scpCh.stdout).trim().slice(0, 200) });
  if (scpCh.code !== 0) process.exit(4);

  const verifyCmd = remoteVerifyOriginCommand(tx, "dev");
  emit("verify_cmd", { cmd: verifyCmd });
  verifyRes = await transport.ssh(target, verifyCmd);
  const out = (verifyRes.stdout + verifyRes.stderr).trim();
  emit("remote_verify", { code: verifyRes.code, out });

  const filesMatch = out.match(/Files checked:\s*(\d+)/i);
  emit("parsed", {
    origin_verify_ok: /ORIGIN_VERIFY_OK/.test(out),
    release_signature: /Release signature:\s*(\S+)/i.exec(out)?.[1] ?? null,
    channel_signature: /Channel signature:\s*(\S+)/i.exec(out)?.[1] ?? null,
    files_checked: filesMatch ? Number(filesMatch[1]) : null,
    pack_version: /Pack version:\s*(\S+)/i.exec(out)?.[1] ?? null,
    release_sequence: /Release sequence:\s*(\d+)/i.exec(out)?.[1] ?? null
  });
} finally {
  const rm = remoteRmTransactionCommand(tx);
  emit("cleanup_cmd", { cmd: rm });
  const cleanupRes = await transport.ssh(target, rm);
  emit("cleanup", { code: cleanupRes.code, out: (cleanupRes.stderr || cleanupRes.stdout).trim() });
}

if (!verifyRes || verifyRes.code !== 0 || !/ORIGIN_VERIFY_OK/.test(verifyRes.stdout + verifyRes.stderr)) {
  process.exit(5);
}
