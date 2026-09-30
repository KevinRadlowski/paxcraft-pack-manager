# CURRENT_STATE — PaxCraft-PackManager-v0.1 (PACK-PAX-02)

**Date UTC :** 2026-09-30 (lot PACK-PAX-02)  
**Rôle :** producteur / signataire / publish du protocole de distribution (Pack Manager).  
**Séparation :** distinct du launcher (`../PaxCraft-Launcher`) — dépôts Git indépendants. Ne pas confondre avec le moteur `src/` du launcher.

## Baseline locale

- Inventaire source : `docs/pax-baseline/inventory-source.json` (140 fichiers utiles, SHA256).
- Couverture : `docs/pax-baseline/inventory-coverage.json`.
- Artefacts historiques (publish/cache/releases échantillonnés) : `docs/pax-baseline/inventory-artefacts.json`.
- Politique data : `docs/pax-baseline/DATA_PRESERVATION.md`.

## Références RC18 / launcher

- Les EXE RC18 canoniques sont sous le **launcher** (`release/_pack12*`), pas ici.
- Version déclarée PM : **0.9.1** (npm `sweetcraft-pack-manager`) — distincte du launcher 0.6.0-rc.18.
- Provenance Git SweetCraft historique : **non restaurée** ; dépôt Pax **sans commit**.

## Dépôt Git Pax (ce lot)

- `git init -b main` dans cette racine uniquement.
- **Aucun commit**, **aucun remote**, **aucun staging**.
- `.gitignore` préservé + ajout minimal `data/publish/` (auparavant non couvert ; `data/publish-*/` existait déjà).
- `.github` non restauré ; workflows exacts **UNKNOWN**.

## Identité / infra

- Runtime/product encore **SweetCraft** (`product: "SweetCraft"`, keyId `sweetcraft-release-2026-01`, CDN/VPS chemins SweetCraft dans scripts).
- Dossier `PaxCraft-PackManager-v0.1` ≠ identité/infra Pax migrée.
- **Aucun** usage VPS/CDN SweetCraft pour Pax dans ce lot.
- **Aucune** migration de données joueur SweetCraft.
- Modpack : bytes de contenu à préserver ; nouvelle enveloppe de signature Pax ultérieure.
- Trust Pax indépendante : **ultérieure**.

## Générés / data

- Arbres lourds `data/cache`, `candidates`, `releases`, `release`, `publish*` : **préservés sur disque**, hors inventaire source, majoritairement hors Git (voir DATA_PRESERVATION).
- Catalogues `data/catalog*.json` et audits : inventoriés comme utiles.
- `schemas/` : dossier vide constaté.

## Outillage observé (hôte)

| Outil | Observé | Déclaré |
|-------|---------|---------|
| PowerShell | 5.1.26100.9444 | — |
| Git | 2.52.0.windows.1 | — |
| Node | v24.19.0 | `engines.node >= 22` |
| pnpm | 9.15.9 | `packageManager: pnpm@9.15.9` |

## Non exécuté

Install, build, tests, upload, verify-origin live, SSH, package.

## Blocages liés au PM avant publish Pax

- Chemins VPS/SSH/CDN SweetCraft encore câblés.
- Coordination producteur/consommateur sur `product`, payloads, keyId.
- Scripts pointant d’anciens chemins `SweetCraft-Launcher`.

## Prochaines étapes

Après premier commit Pax (lot ultérieur) : validation `pnpm install` + `pnpm test` + verifies **locaux** uniquement ; pas d’upload.

## UNKNOWN

- Contenu exact CI historique.
- Complétude de `schemas/`.
- Secrets signing/SSH hors workspace (chemins seulement, non présents dans l’inventaire source).
