# DATA_PRESERVATION — Pack Manager (PACK-PAX-02)

Les données sous `data/` ne doivent **pas** être effacées. Ce document clarifie Git vs conservation disque.

## À préserver sur disque (hors Git recommandé / déjà ignoré)

| Chemin | Motif |
|--------|--------|
| `data/cache/` | Cache régénérable, volumineux |
| `data/candidates/` | Staging local |
| `data/releases/`, `data/release/` | Artefacts release locaux |
| `data/publish/`, `data/publish-*/`, `data/publish-prod/`, `data/publish-test/` | Arbres publish / essais |
| `.releases/` | État local |
| `data/current.json`, `data/manifest.generated.json` | Générés |
| `data/resourcepacks.json`, `data/serverDatapacks.json` | Générés/locaux (examples trackés à part) |
| `data/*.generated.*` | Générés |

Ajout PACK-PAX-02 : `data/publish/` (sans suffixe) était manquant dans `.gitignore` alors que `data/publish-*/` était déjà ignoré.

## Utiles et typiquement suivis (inventaire source)

- `data/catalog*.json`
- Audits / matrices (`*.csv`, `*.md`, `SYNC-*.json`, etc.)
- `data/fixtures/`, `data/resourcepacks.example.json`
- Fichiers d’inventaire hash locaux (ex. `.10a-*`) s’ils restent hors secrets

## Keyrings

- Fichiers de clés **publiques** éventuels sous `data/` : nature publique ; ne pas y placer de PEM privé.
- Matériel privé : chemins hors repo (`*.pem` déjà ignorés) — ne jamais committer.

## Hors inventaire source

Les arbres publish/cache/releases sont exclus de `inventory-source.json` ; un échantillon JSON/MD apparaît dans `inventory-artefacts.json` sans suppression.
