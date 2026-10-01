# PACK-PAX-03 — Commit de baseline et validation technique

**Date UTC :** 2026-09-30
**Dépôt :** PaxCraft-PackManager-v0.1
**HEAD baseline :** `f5742a611b5a073c51474a55162652febc2a3505`
**Message :** `chore: establish inherited technical baseline for Pax Horizon`
**Remotes / tags / push :** aucun

Base technique héritée SweetCraft — **pas** une release Pax. Inventaire PACK-PAX-02 conservé comme snapshot daté.

---

## 1. Premier commit — périmètre

| Métrique | Valeur |
|----------|--------|
| Fichiers suivis | 140 |
| Author effectif | Kevin Radlowski \<kevin.radlowski@gmail.com\> (existant) |
| Inclus | `src/`, `scripts/`, `docs/` (baseline incluse), `data/catalog*` + audits/fixtures/examples, lockfile, README |
| Keyring | `data/.trusted-keys-10a.flat.json` — **clés publiques** |
| Exclus | `node_modules/`, `dist*`, `data/cache|candidates|releases|release|publish*`, secrets |
| Non suivi (restant) | `tsconfig.origin.json` (oublié au staging intentionnel root files ; **pas** de 2ᵉ commit) |

---

## 2. Toolchain et dépendances

| Élément | Observé |
|---------|---------|
| Node | v24.19.0 |
| pnpm | 9.15.9 (= `packageManager` déclaré) |
| Install | `--offline --frozen-lockfile --ignore-scripts` **PASS** (cache) |
| Lockfile | inchangé |
| Lifecycle hooks package | aucun déclaré ; `--ignore-scripts` omits hooks deps |

---

## 3. Build

| Commande | Résultat | Durée | Log |
|----------|----------|-------|-----|
| `pnpm build` | **PASS** | ~8,4 s | `docs/pax-baseline/logs/pm-build.log` |

---

## 4. Tests

| Suite | Résultat | Pass/Fail | Durée | Log |
|-------|----------|-----------|-------|-----|
| `pnpm test` | **PASS** | 335 / 0 | ~8,4 s | `docs/pax-baseline/logs/test-pm.log` |

Les tests `verifyOrigin` / `remotePublish` sont des **unit/harness locaux** (transporteurs mock, signatures éphémères) — **≠** `pack:verify-origin` / upload live.

**NOT_RUN :** `pack:stage`, `pack:publish`, `pack:upload`, `pack:verify-origin` CLI, `pack:verify-release`/`verify-channel` sur arbres `data/` live (risque écriture / ambiguïté). Aucune modification de `data/` générés.

---

## 5. État Git final

- `main` @ `f5742a61…`
- Untracked : `tsconfig.origin.json`
- 0 remote / tag / push
- Données pack lourdes préservées hors Git

---

## 6. Suite

Coordonner avec launcher pour lot identité/isolation ; pas de publish Pax tant que CDN/clés/product ne sont pas redéfinis.
