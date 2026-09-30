# PHASE 0.6 / 0.6.1 / 0.6.2 — Décisions de classification

## Schémas (ne pas confondre)

| Schéma | Constante | Rôle |
|---|---|---|
| Catalogue Pack Manager | `CATALOG_SCHEMA_VERSION` (=2) | Inventaire mods/configs (`data/catalog.*.json`) |
| Manifest launcher | `MANIFEST_SCHEMA_VERSION` (=4) | Artefacts `client-manifest.json` / `server-manifest.json` |

## Sémantique `SERVER_FORCE`

Impose le contenu (`apply=force`). Distribution = `target` indépendant.

## PHASE 0.6.2 — Sensitive résolus

| Famille | Classe audit | Décision | Motif (sans secrets) |
|---|---|---|---|
| `luckperms.conf` | C — slots credentials DB/Redis/messaging | **EXCLUDED / NONE** | Config instance-locale ; champs password/address même si vides |
| `luckperms/translations/repository/**` | D — cache généré | **EXCLUDED / NONE** | Traductions auto-téléchargées (`auto-install-translations`) |
| `resourceful-config-web.json` | C — auth web admin | **EXCLUDED / NONE** | Port admin + validateur mot de passe présent |

`NEVER_CLIENT_SECRET_REVIEW` doit rester à **0** avant release.
Toute entrée NEVER restante → `RELEASE_READY=NO`.

## Trinkets → CLIENT_PRESERVE / CLIENT

UI dominante ; gameplay visuel uniquement.

## Mixte FORCE → BOTH

DistantHorizons, compasses, waystones, refinedstorage, creativecore, etc.
