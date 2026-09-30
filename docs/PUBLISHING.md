# SweetCraft Local Publishing

Local publication produces the exact CDN tree that will later be uploaded. **No remote upload in this phase.**

## Pipeline

```
STAGE
  ↓
VERIFY (pack:verify-release)
  ↓
ASSIGN SEQUENCE
  ↓
SIGN RELEASE (after sequence — never reuse pre-sequence signature)
  ↓
VERIFY RELEASE
  ↓
SIGN CHANNEL
  ↓
VERIFY CHANNEL
  ↓
ATOMIC PUBLISH LOCAL (data/publish/)
  ↓
REMOTE UPLOAD (future phase)
```

## Layout

```
data/publish/
  releases/
    0.1.0/
      release.json      # sequence assigned + signed
      checksums.json    # identical to staging
      client-manifest.json
      server-manifest.json
      files/...
  channels/
    dev.json
    beta.json
    stable.json
```

Staging `data/releases/<version>/` is **never** mutated.

## CLI

```powershell
pnpm pack:publish -- `
  --release data/releases/0.1.0 `
  --channel dev `
  --sequence 1 `
  --out-dir data/publish
```

Required: `--release`, `--channel`, `--sequence`, `--out-dir`.

### Signature rules

| Channel | Unsigned | Signed |
|---------|----------|--------|
| `dev` | only with `--allow-unsigned-dev` | default (keys required) |
| `beta` / `stable` | **never** | always |

Env for real signatures (test keys only in this phase):

- `SWEETCRAFT_RELEASE_ED25519_PRIVATE_KEY_PEM`
- `SWEETCRAFT_RELEASE_PUBLIC_KEY_ID`

Never log or write the private key.

### Sequence

Must be a positive integer **strictly greater** than `channels/<channel>.json` if it exists. Not derived from packVersion.

Checked twice:

1. Early fast-fail at publish start
2. **Authoritative recheck** immediately before replacing `channels/<channel>.json`

If a concurrent publisher advanced the channel in between → `CHANNEL_SEQUENCE_RACE`, and this transaction rolls back **only** its own newly moved `releases/<packVersion>/` (never another publisher’s tree). The existing channel pointer is left untouched.

### Channel pointer replace (cross-platform)

`replaceFileAtomically(source, dest)`:

1. Copy into a unique temp file next to `dest` (same directory / volume)
2. **POSIX:** `rename(temp, dest)` — atomic overwrite
3. **Windows/NTFS:** `rename` cannot overwrite an existing file → move `dest` aside to a unique `.bak`, `rename(temp, dest)`, then delete `.bak`. If the final rename fails, restore `.bak` → `dest` so the channel pointer is not lost.

Readers may briefly observe a missing channel file on Windows during the swap; they never observe a partially written JSON body.

### Immutability

`releases/<packVersion>/` once published cannot be overwritten (any channel). Prefer a new packVersion for changes. Updating a channel pointer to a **new** packVersion with a higher sequence is the supported upgrade path.

### Trusted public keys (verify tools)

```powershell
pnpm pack:verify-channel -- `
  --channel data/publish/channels/dev.json `
  --root data/publish `
  --trusted-keys path/to/trusted-keys.json
```

Or `SWEETCRAFT_TRUSTED_PUBLIC_KEYS_FILE`:

```json
{
  "sweetcraft-release-2026-01": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n"
}
```

## Invariants

- `releaseSequence` is part of the release signing payload → assign **then** sign.
- `checksums.json` does not include `release.json` → checksums bytes unchanged staging → published.
- Channel `releasePath` = `releases/<packVersion>/release.json` (relative, no `..`).
- `REMOTE_UPLOAD: NOT_PERFORMED` until a future CDN phase.
