# SweetCraft Remote Publishing

Pack Manager **v0.9.1** — upload a locally signed publish tree to the production origin.

## Difference: publish vs upload

| Command | Role |
|---------|------|
| `pack:publish` | Build + assign sequence + **sign** locally → `data/publish*` |
| `pack:upload` | Transport an **already signed** tree → incoming → verify-origin → commit gate → HTTPS check |

`pack:upload` never signs releases. The Ed25519 **private** key stays on the publishing PC.

## `--origin` = public product base URL

`--origin` is the **CDN product base**, not the bare CDN host.

| Value | Channel URL resolved |
|-------|----------------------|
| `https://cdn.xnosweet.fr/sweetcraft` | `https://cdn.xnosweet.fr/sweetcraft/channels/dev.json` |
| `https://cdn.xnosweet.fr/sweetcraft/` | same (trailing slash normalized) |

Do **not** pass `https://cdn.xnosweet.fr` alone — that would look for `/channels/dev.json` at the CDN root (404).

Rules: HTTPS required by default; absolute URL; no credentials; no fragment; no query string; product path preserved; no hardcoded `/sweetcraft` in join logic.

## Pipeline

```
LOCAL VERIFY (verifyRelease + verifyChannel, SIGNED_OK required)
  ↓
SSH mkdir incoming/<tx>/{releases,channels}
  ↓
SCP release dir + channel json
  ↓
Remote verify-origin (Node 22 + dist-origin verifier)
  ↓
sudo -n sweetcraft-release-commit <tx> <channel> <sequence>
  ↓
HTTPS byte-compare channel + release.json vs local
  ↓
REMOTE_PUBLISH_OK
```

Never writes to `/srv/sweetcraft/public` from the client.

## Prerequisites

- Local tree from `pack:publish` (signed)
- Trusted public keys file (`--trusted-keys` or `SWEETCRAFT_TRUSTED_PUBLIC_KEYS_FILE`)
- OpenSSH client (`ssh`, `scp`)
- `known_hosts` entry for the origin host (normal StrictHostKeyChecking)
- SSH key for `sweetcraft-deploy` — **ssh-agent recommended** (BatchMode=yes)
- Deploy user can write only `incoming/` and run the commit gate via `sudo -n`

## Example

```powershell
pnpm pack:upload -- `
  --root data/publish-prod `
  --channel dev `
  --host 87.106.2.194 `
  --user sweetcraft-deploy `
  --identity $env:USERPROFILE\.ssh\deploy_ed25519 `
  --trusted-keys C:\path\to\trusted-keys.json `
  --origin https://cdn.xnosweet.fr/sweetcraft
```

Defaults: `--port 22`, `--origin https://cdn.xnosweet.fr/sweetcraft`, `--timeout 60` (seconds).

`--timeout <seconds>`: finite number **strictly > 0**. Applied per SSH/SCP operation and per HTTPS attempt (`AbortController`). Does **not** disable SSH host-key verification. Default **60**.

Forbidden: `--password`, `--root-password`, `--disable-host-key-check`, `--insecure`.

## Security model

- Argument-array `spawn` for ssh/scp (no local shell concatenation)
- Transaction IDs whitelist-only; cleanup only `incoming/<generated-tx>`
- POSIX quoting for remote commands
- No `StrictHostKeyChecking=no` / no `UserKnownHostsFile=/dev/null`
- Release signing private key never uploaded
- Remote unsigned-dev refused (same as origin verifier)

## Failure modes

| Step | Behavior |
|------|----------|
| LOCAL_VERIFY | No SSH — `REMOTE_PUBLISH_FAIL` |
| UPLOAD / REMOTE_VERIFY / SSH_PREPARE | No commit; cleanup `incoming/<tx>` — `REMOTE_PUBLISH_FAIL` |
| COMMIT | Gate errors (e.g. `CHANNEL_SEQUENCE_RACE`); cleanup tx if present — `REMOTE_PUBLISH_FAIL` |
| HTTPS_VERIFY **after successful commit** | **`REMOTE_PUBLISH_COMMITTED_BUT_UNVERIFIED`** — remote already live; `DO_NOT_RETRY_UPLOAD=YES`; exit ≠ 0; no cleanup of public release |
| timeout before commit | Explicit fail + cleanup if tx may exist |
| timeout after commit | Same committed-but-unverified semantics |

`--keep-failed-transaction` skips cleanup (debug only).
