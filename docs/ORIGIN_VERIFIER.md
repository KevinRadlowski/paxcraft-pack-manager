# SweetCraft Origin Verifier

Server-side gate for incoming release transactions. **Public keys only — never private keys.**

Pack Manager version: **0.7.0** (PHASE 1.1).

## Threat model

An untrusted uploader may place files under `/srv/sweetcraft/incoming/<transaction>/`.

The origin verifier must detect before the root-owned commit gate publishes to
`/srv/sweetcraft/public/sweetcraft`:

| Threat | Mitigation |
|--------|------------|
| Unsigned or tampered release | Ed25519 verify via existing `verifyRelease` |
| Tampered channel pointer | Existing `verifyChannelDescriptor` |
| Unknown signing key | Trusted public keyring only |
| Path traversal / symlink escape | Reject symlinks + strict layout |
| Secret material in payload | Reject `.pem` `.key` `.env` `.bak` `.tmp` `.log` + hidden files |
| Multiple / wrong releases | Exactly one `releases/<packVersion>/` |
| Rollback via channel | Sequence + signatures (commit gate may add further checks) |

**Out of scope here:** network upload, CDN sync, private-key custody (stays on the signing workstation / CI).

## Frozen protocols (do not change)

- catalog schema 2  
- manifest schema 5 (legacy) and **6** (resourcePacks) 
- release schema 2  
- channel schema 1  
- `SWEETCRAFT-RELEASE-SIGNATURE-V1`  
- `SWEETCRAFT-CHANNEL-SIGNATURE-V1`  
- `configBase = "files/"`  
- Ed25519 trust model  

## Expected transaction layout

```
/srv/sweetcraft/incoming/<transaction>/
  releases/
    <packVersion>/
      release.json
      checksums.json
      client-manifest.json
      server-manifest.json
      files/...
  channels/
    <channel>.json          # exactly one of: dev | beta | stable
```

No other top-level entries. No symlinks. No hidden or secret-like files.

## Trusted public keys only

```json
{
  "sweetcraft-release-2026-01": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n"
}
```

Install e.g. `/etc/sweetcraft/trusted-keys.json` (mode `0644`, root-owned).

The server **must not** hold `SWEETCRAFT_RELEASE_ED25519_PRIVATE_KEY_PEM`.

## Installation (Ubuntu 24.04)

Build on a workstation:

```bash
pnpm pack:build-origin-verifier
# → dist-origin/
```

Deploy:

```bash
sudo mkdir -p /usr/local/lib/sweetcraft-verifier
sudo rsync -a dist-origin/ /usr/local/lib/sweetcraft-verifier/
# no npm install needed — zero runtime dependencies
```

## Example

```bash
node /usr/local/lib/sweetcraft-verifier/cli.js verify-origin \
  --transaction /srv/sweetcraft/incoming/tx-abc \
  --channel dev \
  --trusted-keys /etc/sweetcraft/trusted-keys.json
```

Success (exit 0):

```
ORIGIN_VERIFY_OK
Transaction: ...
Channel: dev
Pack version: 0.1.0
Release sequence: 1
Release signature: SIGNED_OK
Channel signature: SIGNED_OK
Files checked: 260
Configs: 258
```

Machine-readable:

```bash
node ... verify-origin ... --json
```

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | `ORIGIN_VERIFY_OK` |
| 2 | Verification / policy failure (`OriginVerifyError`) |
| 1 | Unexpected error |

## Origin policy vs local publish

| | Local `pack:publish` | Origin `verify-origin` |
|--|----------------------|-------------------------|
| `dev` unsigned | allowed with `--allow-unsigned-dev` | **REFUSED** |
| `beta`/`stable` unsigned | refused | refused |
| Private key | required to sign | **never** |

## Read-only guarantee

`verify-origin` does not modify, move, or publish any file. The root-owned commit gate (future) consumes a successful verification.
