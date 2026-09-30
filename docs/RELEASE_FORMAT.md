# SweetCraft Release Format

Official layout and signing contract for staged / published SweetCraft pack releases.

## Layout

```
releases/<packVersion>/
  release.json
  checksums.json
  client-manifest.json
  server-manifest.json
  files/
    config/...
```

Allowed root files only: the four JSON files above.  
Under `files/`, only paths listed in `checksums.json` are allowed.

Mods are **not** packaged in the release. Manifests reference provider URLs + expected hashes.

## Schemas

| Artefact | Current version |
|----------|-----------------|
| catalogue (Pack Manager) | 2 |
| client/server manifest | **6** (courant) ; **5** legacy supporté en verify |
| release.json | 2 (schema 1 still integrity-verifiable for local staging) |
| checksums.json | 1 |
| channel descriptor | 1 |

## `release.json`

Critical fields (covered by the signing payload when `status=signed`):

- `product`, `packVersion`, `minecraft`, `fabricLoader`, `server`
- `packManagerVersion`
- `catalogSchemaVersion`, `manifestSchemaVersion`, `schemaVersion` (release)
- `configBase` (must be `files/`)
- `antiRollback.releaseSequence` (`null` at local staging; positive integer at publish)
- `artefacts.*.sha256` for client manifest, server manifest, checksums

`signature` block:

```json
{
  "status": "signed" | "unsigned-dev",
  "algorithm": "ed25519",
  "publicKeyId": "sweetcraft-release-2026-01" | null,
  "payload": "SWEETCRAFT-RELEASE-SIGNATURE-V1",
  "value": "<base64>" | null,
  "signer": "..."
}
```

The signature value is **not** included in the signed payload (no circular self-sign).

## Why `checksums.json` does not list `release.json`

Avoids a circular dependency:

1. Signature authenticates release metadata + `checksumsSha256`
2. `checksums.json` authenticates manifests + config file bytes
3. Manifests authenticate mod providers/hashes and config policy/target/apply

## Canonical signing payload (`SWEETCRAFT-RELEASE-SIGNATURE-V1`)

Built only via `buildReleaseSigningPayload(...)`.

Rules:

- UTF-8
- LF (`\n`) only
- Fixed field order
- No JSON indentation
- No locale / local date formatting
- Hashes lower-case hex
- `releaseSequence=` empty string when unset; otherwise decimal positive integer

Exact format (trailing LF required):

```
SWEETCRAFT-RELEASE-SIGNATURE-V1
product=SweetCraft
packVersion=0.1.0
minecraft=26.1.2
fabricLoader=0.19.3
server=sweetcraft.datho.st
packManagerVersion=0.5.0
catalogSchemaVersion=2
manifestSchemaVersion=6
releaseSchemaVersion=2
configBase=files/
releaseSequence=
clientManifestSha256=<64 hex>
serverManifestSha256=<64 hex>
checksumsSha256=<64 hex>
```

## Channel descriptor

Path concept: `channels/<channel>.json` (`stable` | `beta` | `dev`).

```json
{
  "schemaVersion": 1,
  "channel": "stable",
  "packVersion": "0.1.0",
  "releaseSequence": 1,
  "releasePath": "releases/0.1.0/release.json",
  "releaseSha256": "<sha256 of release.json bytes>",
  "signature": {
    "status": "signed",
    "algorithm": "ed25519",
    "publicKeyId": "sweetcraft-release-2026-01",
    "payload": "SWEETCRAFT-CHANNEL-SIGNATURE-V1",
    "value": "<base64>"
  }
}
```

Channel payload (`SWEETCRAFT-CHANNEL-SIGNATURE-V1`):

```
SWEETCRAFT-CHANNEL-SIGNATURE-V1
channel=stable
packVersion=0.1.0
releaseSequence=1
releasePath=releases/0.1.0/release.json
releaseSha256=<64 hex>
```

Launcher must always verify the **target release** signature. Channel signature alone is not enough; it only authenticates the pointer.

## Signature modes

| Mode | When | Production launcher |
|------|------|---------------------|
| `unsigned-dev` | local staging / CI without key | **REFUSE** |
| `signed` | required for beta/stable publish | accept if trusted `publicKeyId` |

## Env (signing)

- `SWEETCRAFT_RELEASE_ED25519_PRIVATE_KEY_PEM` — never log, never write to disk/staging
- `SWEETCRAFT_RELEASE_PUBLIC_KEY_ID` — required when signing for real (e.g. `sweetcraft-release-2026-01`)

## Local publish tree

See `docs/PUBLISHING.md`. Staging stays under `data/releases/`; published CDN mirror under `data/publish/{releases,channels}/`.

`releaseSequence` is assigned at publish time, then the release is signed. Checksums are unchanged (release.json is not in checksums.json).

Trusted keys for local verify: `--trusted-keys` or `SWEETCRAFT_TRUSTED_PUBLIC_KEYS_FILE`.
