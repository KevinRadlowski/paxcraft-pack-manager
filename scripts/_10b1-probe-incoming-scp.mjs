import { SystemSshTransport } from "../dist/sshTransport.js";
import {
  generateTransactionId,
  incomingTransactionPath,
  remoteMkdirTransactionCommand,
  posixShellQuote
} from "../dist/remotePaths.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tx = generateTransactionId("dev", "0.1.4", 5);
const target = {
  host: "87.106.2.194",
  user: "sweetcraft-deploy",
  port: 22,
  identity: `${process.env.USERPROFILE}/.ssh/sweetcraft/deploy_ed25519`,
  batchMode: true,
  timeoutMs: 60000
};
const transport = new SystemSshTransport();

const mkdir = await transport.ssh(target, remoteMkdirTransactionCommand(tx));
console.log("mkdir_tx", mkdir.code, (mkdir.stderr || mkdir.stdout).trim());

const remoteVerifierDir = `${incomingTransactionPath(tx)}/verifier-staging`;
const mkdir2 = await transport.ssh(target, `mkdir -p ${posixShellQuote(remoteVerifierDir)}`);
console.log("mkdir_verifier", mkdir2.code, (mkdir2.stderr || mkdir2.stdout).trim());

const scp = await transport.scpTo(target, path.join(root, "dist-origin"), remoteVerifierDir, true);
console.log("scp_verifier", scp.code, (scp.stderr || scp.stdout).trim());
