# SweetCraft Launcher Update Contract

Normative install/update algorithm for the future SweetCraft Launcher. Implement without heuristics.

## High-level flow

1. Fetch channel descriptor (`channels/<channel>.json`).
2. Verify channel signature (recommended) with trusted public keys.
3. Fetch `releasePath` → `release.json`.
4. Verify `releaseSha256` matches channel pointer (if channel signed/verified).
5. Verify release Ed25519 signature (`SWEETCRAFT-RELEASE-SIGNATURE-V1`) — production **must** require `status=signed`.
6. Enforce anti-rollback: `releaseSequence` ≥ last accepted for channel (else refuse).
7. Fetch `checksums.json`; verify SHA-256 equals `release.artefacts.checksums.sha256`.
8. Fetch every checksum entry (manifests + `files/**`); verify size + SHA-256.
9. Apply mods and configs per rules below.
10. Persist new highest `releaseSequence` only after successful apply.

## Provider download security

`provider.url` is **never** sufficient, even over HTTPS.

After downloading a mod to a temp path:

1. Verify `size` if present in the manifest.
2. Verify **SHA-256** (mandatory).
3. Verify **SHA-512** if present.
4. Only then atomically move into `mods/`.

On mismatch: delete temp, ERROR, **never** launch Minecraft with that file.

## Atomic download contract

For every protected artefact (release JSON, checksums, manifests, configs FORCE, mod jars):

```
download → temp file
verify size + hashes
atomic rename into final location
```

Never leave a partially written final path as the live file.

## Resource packs (manifest schema 6)

Client manifests may include `resourcePacks[]` (`id`, `displayName`, `version`, `targetPath`, `sha256`, `size`, `autoEnable`).

- Install ZIP from release storage `files/` + `targetPath` into the Minecraft instance at `targetPath`.
- Server manifests always expose `resourcePacks: []`.
- If `autoEnable=true`, ensure the pack is listed in the player's active resource packs **without** wiping personal packs. Track managed packs by stable `id` when replacing versions. Do not delete user files based on filename heuristics.
- Schema 5 releases (historical): treat resource packs as empty.

See `docs/RESOURCE_PACKS.md`.

## Config apply rules

Derived from manifest `apply` + `target` (manifest schema 5+):

| Apply | Behavior |
|-------|----------|
| `force` | Always install: download/copy → temp → hash → atomic replace destination |
| `if_missing` (`CLIENT_DEFAULT`) | Copy only if destination is absent |
| `never_overwrite` (`CLIENT_PRESERVE`) | Never overwrite an existing destination |
| `excluded` / never client | Must not be present in staged `files/` |

`target` controls which side receives the file (`CLIENT` / `SERVER` / `BOTH`). It is independent of apply policy.

`configBase` is `files/`; on-disk staged path is `files/` + manifest `path` (e.g. `files/config/...`).

## Unsigned vs signed

| Environment | `unsigned-dev` | `signed` |
|-------------|----------------|----------|
| Production launcher | REFUSE | accept if key trusted |
| Dev launcher | optional explicit flag | accept if key trusted |

## Strict fileset expectation

After sync, the release tree (CDN or cache) must contain exactly:

- `release.json`, `checksums.json`, `client-manifest.json`, `server-manifest.json`
- `files/**` entries listed in checksums

Extra or missing files → ERROR.

## Failure policy

Any integrity or signature failure aborts the update. Do not partially apply FORCE configs or mods after a failed hash. Prefer leaving the previous successful install intact.
