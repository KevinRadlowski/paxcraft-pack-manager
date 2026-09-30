# Server datapacks — Pack Manager distribution

## Authoritative CLEAN content

`MODPACK FINAL CLEAN/server/world/datapacks/SweetCraft_Quest_Support/` is the only
pack-owned folder datapack on the production server baseline (`pack.mcmeta` +
`data/sweetcraft/...`). It is **not** client launcher scope.

## Pack Manager contract (schema 6 extension)

Server releases may carry an optional `serverDatapacks[]` array on **server-manifest
only** (client manifest must not include it). Each entry describes a deterministic
folder tree under the dedicated server root:

- `id`, `displayName`, `version`
- `targetPath` — e.g. `world/datapacks/SweetCraft_Quest_Support`
- `apply: "force"` — pack-owned content replaced on deploy/update
- `fileCount`, `totalBytes`, `treeSha256`
- `files[]` — `{ path, sha256, size }` relative to server root

Build config (`data/serverDatapacks.json`) holds `sourcePath` (never published).
Staging copies bytes to `files/world/datapacks/...` in the release tree with
checksum coverage.

## Client launcher pipeline

SweetCraft Launcher manifests (schema 6) distribute **client** mods, configs, and
resource packs. Server datapacks are **server provisioning** artefacts from Pack
Manager; the launcher does not apply them to player instances.

## DatHost deployment semantics (audit only — not implemented here)

1. **Pack Manager role today:** build staged server payload (mods URLs, configs,
   optional `serverDatapacks[]` files). No DatHost SSH/deploy in this repo path.
2. **Intended server update path:** operator or automation merges release-hosted
   `files/config/**`, provider mod jars, and `files/world/datapacks/**` onto the
   VPS server root. Existing world region/player data under `world/` **outside**
   managed datapack paths must be preserved.
3. **Datapack apply = force:** replacing `world/datapacks/SweetCraft_Quest_Support/**`
   updates pack-owned quest/advancement/tag definitions without touching
   `world/region/`, `world/playerdata/`, `world/advancements/` (player stats), etc.
4. **Rollback:** restore prior release tree or prior `serverDatapacks[].treeSha256`
   snapshot; world runtime data rollback is separate (world backup).
5. **Backup before deploy:** full `world/` backup recommended when datapack
   definitions change; mods/config deploy follows existing pack update practice.

## LuckPerms `mods/luckperms/libs`

22 jars under CLEAN are a **regenerable runtime cache**: LuckPerms downloads
Maven dependencies on first boot (checksum-verified) and writes `*-remapped.jar`.
They are **not** ModRecords and are **not** required in Pack Manager releases
(`LUCKPERMS_LIBS_REGENERABLE`).
