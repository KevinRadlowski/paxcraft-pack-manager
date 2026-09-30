# PACK-10.1SYNC-09 — Release & publish readiness audit

Generated: 2026-09-17 (read-only). No git/sign/upload/pointer/deploy operations.

## Git baseline

| Repo | HEAD |
|------|------|
| SweetCraft-Launcher | `78bc1ddc8f26c6fd362b6c4ea3fe6cbbb669975c` |
| SweetCraft-PackManager-v0.4 | `41022a318c14680b575b6ea64810d2fc9af6d36a` |

## Frozen 0.1.4/seq5 candidate (local, unsigned-dev)

| Artefact | SHA-256 |
|----------|---------|
| release.json | `1339c59fcc4ca1d328c0029142982ec43c9931b4bf959c37fadac7f6dfc131a7` |
| checksums.json | `b3c425cb3997850986dd48b92dc2d8d4ff03f6fe0050c3af34cd07ed351782ed` |
| client-manifest.json | `3c2a01a1bbe2b7b4a3753e881deea06ca4dc0810287ad4bd66805ffce8576540` |
| server-manifest.json | `7102e0b924f6403dca4a88df6b801871bd13363e3512e76581527882cb371189` |

Local `data/releases/0.1.4/release.json`: `signature.status=unsigned-dev`, `antiRollback.releaseSequence=5`.

## Canonical release chain

```
STAGE (pack:stage / sync06 one-off)
  → data/releases/<version>/  [immutable staging tree; gitignored]

VERIFY (pack:verify-release)
  → verifyRelease() strict fileset + optional signature check

PUBLISH LOCAL (pack:publish)  ← canonical prod path
  → copy staging → tmp → sign release.json + channel.json
  → atomic write data/publish/releases/<ver>/ + channels/<ch>.json
  → staging tree NOT mutated (docs/PUBLISHING.md)

Optional in-place sign (signStagedRelease) — NOT exposed CLI; mutates staging release.json only

UPLOAD (pack:upload)
  → prevalidateLocalPublish (SIGNED_OK required for prod)
  → SSH mkdir /srv/sweetcraft/incoming/<tx>/
  → SCP releases/<ver>/ + channels/<ch>.json
  → remote verify-origin (dist-origin/cli.js, /etc/sweetcraft/trusted-keys.json)
  → sudo -n /usr/local/sbin/sweetcraft-release-commit <tx> <channel> <sequence>
  → HTTPS byte-compare channel + release.json vs local
```

## Signing contract

- Algorithm: Ed25519, signature Base64 in `signature.value`
- Payload IDs: `SWEETCRAFT-RELEASE-SIGNATURE-V1`, `SWEETCRAFT-CHANNEL-SIGNATURE-V1`
- Canonical serialization: UTF-8 LF, `key=value` lines, fixed order (`src/releasePayload.ts`)
- Signed object: **release.json bytes** (channel descriptor signed separately)
- `checksums.json` **excludes** release.json (no circular hash)
- Payload binds: releaseSequence + client/server manifest SHA + checksums SHA
- Launcher verifies: channel sig → anti-rollback → release SHA → release sig → manifest SHA
- `unsigned-dev` → Launcher `UNSIGNED_REFUSED` (fail-closed)

## Post-sign hash expectations

| Artefact | After sign/publish |
|----------|-------------------|
| checksums.json | **UNCHANGED** (`b3c425cb…`) |
| client-manifest.json | **UNCHANGED** (`3c2a01a1…`) |
| server-manifest.json | **UNCHANGED** (`7102e0b9…`) |
| files/** | **UNCHANGED** |
| release.json | **CHANGES** (new signature block + published metadata) |
| channels/dev.json | **NEW** (seq 5, releaseSha256 of signed release.json) |

## Remote/CDN topology

- Origin: `https://cdn.xnosweet.fr/sweetcraft`
- Channel: `{origin}/channels/{dev|beta|stable}.json`
- Release: `{origin}/releases/{packVersion}/release.json`
- Files: `{origin}/releases/{packVersion}/files/...`
- Incoming: `/srv/sweetcraft/incoming/<tx>/`
- Public: `/srv/sweetcraft/public/sweetcraft/`
- Commit gate: `/usr/local/sbin/sweetcraft-release-commit`
- Remote verifier: `/usr/local/lib/sweetcraft-verifier/cli.js`

## Remote state (read-only HTTPS, 2026-09-17)

| Resource | State |
|----------|-------|
| channels/dev.json | 0.1.3 / seq **4** / signed |
| releases/0.1.3/release.json | present, signed |
| releases/0.1.4/release.json | **404** (not published) |

## Credentials (names only — audit env)

| Name | Audit env |
|------|-----------|
| SWEETCRAFT_RELEASE_ED25519_PRIVATE_KEY_PEM | ABSENT |
| SWEETCRAFT_RELEASE_PUBLIC_KEY_ID | ABSENT |
| SWEETCRAFT_TRUSTED_PUBLIC_KEYS_FILE | ABSENT |
| SSH deploy key (--identity) | UNKNOWN (not probed) |
| /etc/sweetcraft/trusted-keys.json (remote) | UNKNOWN (not probed) |

Launcher public key `sweetcraft-release-2026-01`: **PRESENT** in `config/trusted-keys.json`.

## Tests executed (read-only)

- Launcher: channel/release/resolve/anti-rollback — **22/22 PASS**
- PM: signRelease, releaseCrypto, releaseHosted, publish — **49/49 PASS**

## Next lot executable plan (DO NOT RUN HERE)

See user report section « Publish transaction ».
