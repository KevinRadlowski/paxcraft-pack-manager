# SweetCraft Security Model

Trust chain between Pack Manager → release CDN → SweetCraft Launcher.

## Threat model — what the signature protects

With a production launcher that embeds **only trusted public keys**, an attacker who can alter CDN objects (or MITM without TLS pinning) must still fail cryptographic checks for:

| Attack | Detection |
|--------|-----------|
| Falsified `release.json` metadata | signature over canonical payload fails |
| Falsified `checksums.json` | `checksumsSha256` in signed payload mismatches |
| Falsified manifest | manifest hash in checksums / artefacts mismatches |
| Falsified config file | checksums entry size/sha256 fails |
| Incomplete / corrupted download | size + SHA-256 fail before install |
| Substitute older published release | `releaseSequence` anti-rollback |
| Modified mod provider URL | manifest hash changes → checksums/signature fail |
| Modified mod hash | same |
| Modified apply policies / targets | same (in manifests) |
| Point channel at unsigned arbitrary release | channel may be signed, but release must still verify as `signed` with trusted key |

**Not in scope of release signature alone:** compromise of the private key; malicious but correctly signed content from a compromised release pipeline; client-side code injection outside the pack files.

## Private vs public keys

- Private Ed25519 key: CI / release operator only. **Never** shipped with the launcher.
- Launcher embeds `trustedKeys: { publicKeyId → public PEM }`.
- Unknown `publicKeyId` → **REFUSE**.

### Key rotation

1. Publish new key id (e.g. `sweetcraft-release-2027-01`) in launcher update.
2. Overlap: launcher trusts both old and new ids during rotation window.
3. New releases use the new id; retire old id after all supported channels moved.

Do **not** use the raw key bytes as the id.

## Trust chain

```
PUBLIC KEY (launcher)
   ↓ verifies Ed25519
RELEASE SIGNATURE
   ↓ authenticates
RELEASE METADATA + checksumsSha256 (+ manifest artefact hashes in payload)
   ↓
checksums.json
   ↓
manifests + config files
   ↓
mod providers + expected mod hashes + config policy/apply/target
```

`release.json` is intentionally **absent** from `checksums.json` to avoid circular dependency. Its critical fields are bound by the signature payload; `checksumsSha256` binds the rest.

## `releaseSequence` (anti-rollback)

- Positive integer
- Strictly increasing per **channel** for published releases
- Included in the release signing payload (empty when unset at local staging)
- Launcher stores highest accepted sequence per channel
- Lower sequence → REFUSE unless explicit dev/debug override

`releaseSequence` is assigned at **publication**, not during local staging of `0.1.0`.

Channels `stable`, `beta`, `dev` each have independent sequence counters.

## Channel security

An attacker who can rewrite `channels/stable.json` still cannot force an unsigned or differently-keyed release: the launcher verifies the pointed `release.json` signature against trusted keys and checks `releaseSha256` if the channel descriptor is also verified.

Recommendation: **sign channel descriptors** (`SWEETCRAFT-CHANNEL-SIGNATURE-V1`).

## Modes

- `unsigned-dev`: staging/local only; integrity verifiable; **not** publishable to stable/beta; production launcher refuses.
- `signed`: mandatory for beta/stable publication; required for `dev` unless `--allow-unsigned-dev`.

## Local publisher (PHASE 0.9)

`pack:publish` copies staging → `data/publish/`, assigns sequence, signs release **after** sequence, signs channel, verifies both, commits atomically. No remote upload. See `docs/PUBLISHING.md`.
