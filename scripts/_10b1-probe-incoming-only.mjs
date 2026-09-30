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
const target = {
  host: "87.106.2.194",
  user: "sweetcraft-deploy",
  port: 22,
  identity: `${process.env.USERPROFILE}/.ssh/sweetcraft/deploy_ed25519`,
  batchMode: true,
  timeoutMs: 120000
};
const transport = new SystemSshTransport();
const tx = generateTransactionId("dev", "0.1.4", 5);

async function log(label, res) {
  console.log(label, "code=", res.code, "out=", JSON.stringify((res.stderr || res.stdout).trim().slice(0, 400)));
}

try {
  await log("mkdir_tx", await transport.ssh(target, remoteMkdirTransactionCommand(tx)));

  const publishRelease = path.join(root, "data/publish/releases/0.1.4");
  const publishChannel = path.join(root, "data/publish/channels/dev.json");
  const remoteRelease = `${incomingTransactionPath(tx)}/releases/0.1.4`;
  const remoteChannel = `${incomingTransactionPath(tx)}/channels/dev.json`;

  await log("scp_release", await transport.scpTo(target, publishRelease, remoteRelease, true));
  await log("scp_channel", await transport.scpTo(target, publishChannel, remoteChannel, false));

  const verifyCmd = remoteVerifyOriginCommand(tx, "dev");
  console.log("verify_cmd", verifyCmd);
  await log("remote_verify", await transport.ssh(target, verifyCmd));

  const verifierDir = `${incomingTransactionPath(tx)}/verifier-staging`;
  await log("scp_verifier_to_incoming", await transport.scpTo(target, path.join(root, "dist-origin"), verifierDir, true));
} finally {
  const rm = remoteRmTransactionCommand(tx);
  console.log("cleanup", rm);
  await log("cleanup", await transport.ssh(target, rm));
}
