import { spawn, type ChildProcess } from "node:child_process";
import {
  assertNoForbiddenSshOpts,
  assertTransactionId,
  INCOMING_ROOT,
  posixShellQuote,
  resolveRemoteVerifierPath
} from "./remotePaths.js";

export interface SshTarget {
  host: string;
  user: string;
  port: number;
  identity?: string;
  /** Prefer BatchMode for CI (requires ssh-agent for passphrase keys). Default true. */
  batchMode?: boolean;
  /** Per-operation timeout in milliseconds (required for SystemSshTransport). */
  timeoutMs: number;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  argv: string[];
  timedOut?: boolean;
}

export interface RemoteTransport {
  /** Run remote command via ssh; command is a single remote argv string (already quoted pieces joined). */
  ssh(target: SshTarget, remoteCommand: string): Promise<ExecResult>;
  /** scp local file/dir to remote path (recursive if local is directory). */
  scpTo(target: SshTarget, localPath: string, remotePath: string, recursive: boolean): Promise<ExecResult>;
}

function buildSshBaseArgs(target: SshTarget): string[] {
  const args = ["-p", String(target.port), "-o", "BatchMode=yes"];
  if (target.batchMode === false) {
    const i = args.indexOf("BatchMode=yes");
    if (i >= 0) {
      args.splice(i - 1, 2);
    }
  }
  if (target.identity) {
    args.push("-i", target.identity);
  }
  assertNoForbiddenSshOpts(args);
  return args;
}

/**
 * Build scp argv (without the `scp` binary) for SystemSshTransport.
 *
 * SweetCraft confinement requires OpenSSH legacy SCP protocol (`-O`) so the
 * remote forced-command sees `scp -t <path>` rather than the SFTP subsystem.
 * `-O` is mandatory architecture, not a fallback.
 */
export function buildScpArgv(
  target: SshTarget,
  localPath: string,
  remotePath: string,
  recursive: boolean
): string[] {
  const args = [...buildSshBaseArgs(target)];
  // OpenSSH scp uses -P for port; ssh uses -p.
  const pIdx = args.indexOf("-p");
  if (pIdx >= 0) {
    args[pIdx] = "-P";
  }
  // Force legacy SCP (exec) protocol — required for SweetCraft deploy confinement.
  args.push("-O");
  if (recursive) args.push("-r");
  args.push(localPath, `${target.user}@${target.host}:${remotePath}`);
  assertNoForbiddenSshOpts(args);
  return args;
}

function killChild(child: ChildProcess) {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore"
      });
    } else {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        try {
          if (!child.killed) child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, 500).unref?.();
    }
  } catch {
    /* ignore */
  }
}

/** Spawn with hard timeout — never leaves a hanging Promise. */
export function runWithTimeout(cmd: string, args: string[], timeoutMs: number): Promise<ExecResult> {
  assertNoForbiddenSshOpts(args);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new Error(`timeoutMs invalide: ${timeoutMs}`));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const settle = (result: ExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      killChild(child);
      settle({
        code: 124,
        stdout,
        stderr: `timeout after ${timeoutMs}ms`,
        argv: [cmd, ...args],
        timedOut: true
      });
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", code => {
      settle({
        code: code ?? 1,
        stdout,
        stderr,
        argv: [cmd, ...args],
        timedOut: false
      });
    });
  });
}

export class SystemSshTransport implements RemoteTransport {
  async ssh(target: SshTarget, remoteCommand: string): Promise<ExecResult> {
    const args = [...buildSshBaseArgs(target), `${target.user}@${target.host}`, remoteCommand];
    return runWithTimeout("ssh", args, target.timeoutMs);
  }

  async scpTo(target: SshTarget, localPath: string, remotePath: string, recursive: boolean): Promise<ExecResult> {
    const args = buildScpArgv(target, localPath, remotePath, recursive);
    return runWithTimeout("scp", args, target.timeoutMs);
  }
}

/** Build a remote mkdir -p for the transaction tree (paths validated). */
export function remoteMkdirTransactionCommand(tx: string): string {
  assertTransactionId(tx);
  const base = `${INCOMING_ROOT}/${tx}`;
  return `mkdir -p ${posixShellQuote(`${base}/releases`)} ${posixShellQuote(`${base}/channels`)}`;
}

export function remoteRmTransactionCommand(tx: string): string {
  assertTransactionId(tx);
  const base = `${INCOMING_ROOT}/${tx}`;
  return `rm -rf ${posixShellQuote(base)}`;
}

export function remoteVerifyOriginCommand(tx: string, channel: string): string {
  assertTransactionId(tx);
  if (channel !== "dev" && channel !== "beta" && channel !== "stable") {
    throw new Error(`channel invalide: ${channel}`);
  }
  const parts = [
    "/opt/sweetcraft/node/current/bin/node",
    resolveRemoteVerifierPath(),
    "verify-origin",
    "--transaction",
    `${INCOMING_ROOT}/${tx}`,
    "--channel",
    channel,
    "--trusted-keys",
    "/etc/sweetcraft/trusted-keys.json"
  ];
  return parts.map(posixShellQuote).join(" ");
}

export function remoteCommitCommand(tx: string, channel: string, sequence: number): string {
  assertTransactionId(tx);
  if (channel !== "dev" && channel !== "beta" && channel !== "stable") {
    throw new Error(`channel invalide: ${channel}`);
  }
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new Error(`sequence invalide: ${sequence}`);
  }
  const parts = [
    "sudo",
    "-n",
    "/usr/local/sbin/sweetcraft-release-commit",
    tx,
    channel,
    String(sequence)
  ];
  return parts.map(posixShellQuote).join(" ");
}
