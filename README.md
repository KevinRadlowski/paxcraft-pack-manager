# SweetCraft Pack Manager v0.9.1

Catalogue SweetCraft 26.1.2 / Fabric 0.19.3 + staging + resource packs client + publish local + origin verifier + remote upload.

## Workflow

```powershell
# Copier data/resourcepacks.example.json → data/resourcepacks.json (local)
pnpm pack:validate-resourcepacks
pnpm pack:stage -- --version 0.1.1 --source <modpack> --force
pnpm pack:verify-release -- --release data/releases/0.1.1
pnpm pack:publish -- --release data/releases/0.1.1 --channel dev --sequence 2 --out-dir data/publish-prod
pnpm pack:upload -- `
  --root data/publish-prod `
  --channel dev `
  --host 87.106.2.194 `
  --user sweetcraft-deploy `
  --identity <ssh-key> `
  --trusted-keys <trusted-keys.json> `
  --origin https://cdn.xnosweet.fr/sweetcraft
```

`--origin` = **base URL publique du produit** (pas la racine CDN seule).  
Exemple : `https://cdn.xnosweet.fr/sweetcraft` → `.../sweetcraft/channels/dev.json`.

- `pack:publish` = construire et signer localement  
- `pack:upload` = transporter une release déjà signée vers l’origin (gate serveur)  
- `pack:stage` utilise par défaut `data/catalog.configs.json` (pas le baseline schema 1)

Docs : `docs/RESOURCE_PACKS.md`, `docs/PUBLISHING.md`, `docs/ORIGIN_VERIFIER.md`, `docs/REMOTE_PUBLISHING.md`.

## Schémas

| Artefact | Version |
|---|---|
| Catalogue | 2 (gelé) |
| Manifest | **6** (courant) ; **5** legacy encore vérifiable |
| Release | 2 (gelé) |
| Channel | 1 (gelé) |
