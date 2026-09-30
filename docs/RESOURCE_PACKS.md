# Resource packs SweetCraft (Pack Manager v0.9)

Distribution native des resource packs client dans le pipeline STAGE → VERIFY → PUBLISH → UPLOAD.

## Identité stable vs version logique

| Champ | Rôle |
|-------|------|
| `id` | Identité stable (`sweetcraft-fr`). Le launcher utilisera cet id pour remplacer une version par une autre. |
| `version` | Version **logique** SweetCraft (`1.0`, `1.1`, …). **Jamais** inférée depuis le filename, `pack.mcmeta`, README ou audit JSON. |
| `displayName` | Libellé UI (`SweetCraft FR`). |

Le filename peut contenir `v1.0` alors que la description éditoriale parle de `v2.7` : seul `version` dans la config Pack Manager fait foi.

## Configuration source (locale)

Fichier : `data/resourcepacks.json` (gitignored — chemins machine-local).

Exemple portable : `data/resourcepacks.example.json`.

```json
{
  "resourcePacks": [
    {
      "id": "sweetcraft-fr",
      "displayName": "SweetCraft FR",
      "version": "1.0",
      "sourcePath": "../../RESOURCE PACK/SweetCraft-FR-v1.0.zip",
      "target": "CLIENT",
      "targetPath": "resourcepacks/SweetCraft-FR-v1.0.zip",
      "autoEnable": true
    }
  ]
}
```

- `sourcePath` : relatif à `data/` **ou** absolu. **Ne fuit jamais** dans les manifests publics.
- Override CLI : `pnpm pack:stage -- ... --resourcepacks <fichier>`
- Validation seule : `pnpm pack:validate-resourcepacks`
- Le ZIP n’a pas besoin d’être versionné Git.

## Chemins : trois notions

| Notion | Exemple | Usage |
|--------|---------|--------|
| `sourcePath` | chemin local Windows/Unix | Build uniquement |
| `targetPath` | `resourcepacks/SweetCraft-FR-v1.0.zip` | Destination **instance Minecraft** (POSIX `/`, sous `resourcepacks/`) |
| Release storage | `files/resourcepacks/SweetCraft-FR-v1.0.zip` | Artefact dans la release (`configBase` + targetPath) |

`configBase` reste `"files/"` (release signature payload V1 inchangé).

## Validation ZIP (build/staging)

Avant staging : existence, fichier régulier, `.zip`, archive lisible, anti-traversal / chemins absolus / drive letters, `pack.mcmeta` **à la racine** (JSON + objet `pack`), formats :

- moderne : `min_format` / `max_format`
- legacy : `pack_format` numérique

+ `assets/` présent avec au moins un fichier.

**Pas de re-ZIP** : SHA-256 et size sur les octets exacts fournis.

README.txt / `sweetcraft-fr-audit.json` à la racine sont autorisés.

## Manifest schema 6

```json
"resourcePacks": [
  {
    "id": "sweetcraft-fr",
    "displayName": "SweetCraft FR",
    "version": "1.0",
    "targetPath": "resourcepacks/SweetCraft-FR-v1.0.zip",
    "sha256": "<calculé>",
    "size": 400806,
    "autoEnable": true
  }
]
```

- **Client** : packs CLIENT uniquement.
- **Serveur** : toujours `resourcePacks: []` (même forme parser).
- IDs uniques dans un même manifest.
- Pas de `sourcePath`.

### Compatibilité historique

| Schema | Resource packs |
|--------|----------------|
| **5** (prod 0.1.0) | Implicitement `[]` — encore vérifiable |
| **6** (courant) | `resourcePacks` **explicite** obligatoire |

## autoEnable (contrat futur launcher)

`autoEnable: true` = intention pour le launcher futur. Le Pack Manager stocke / valide / signe via le manifest, **sans** toucher `options.txt` ni le profil joueur.

Exemple d’activation (hors scope v0.9) :

```
Avant : ["vanilla", "file/MyPrettyPack.zip"]
Après : ["vanilla", "file/MyPrettyPack.zip", "file/SweetCraft-FR-v1.0.zip"]
```

Update 1.0 → 1.1 : retirer la référence gérée par **id**, installer v1.1, conserver les packs personnels. Ne jamais supprimer un fichier utilisateur sur simple ressemblance de nom.

## Workflow update SweetCraft-FR

1. Produire `SweetCraft-FR-v1.1.zip` (octets finaux).
2. Mettre à jour `data/resourcepacks.json` : `version=1.1`, `sourcePath`, `targetPath=resourcepacks/SweetCraft-FR-v1.1.zip`.
3. `pnpm pack:validate-resourcepacks`
4. `pnpm pack:stage -- --version <pack> --source <modpack> --force`
5. `pnpm pack:verify-release -- --release data/releases/<pack>`
6. `pnpm pack:publish` puis `pack:upload` (hors lot de test)

## Origin verifier

`dist-origin` vérifie manifest / SHA / size / checksums / signatures. **Pas** d’ouverture ZIP, pas d’adm-zip, pas de `sourcePath`, pas d’upload/SSH/clés privées.

## Sécurité

- Path traversal ZIP et `targetPath` refusés.
- Strict fileset : ZIP orphelin sous `files/resourcepacks/` → FAIL.
- Alteration post-staging détectée par `verifyRelease`.
- Client-only : présence côté serveur → FAIL.
