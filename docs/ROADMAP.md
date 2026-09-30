# Roadmap Pack Manager
1. v0.1 — catalogue, scan local, diff, validation, manifest client. ✅
2. v0.2 — résolution Modrinth par hash. ✅
3. v0.3 — side reconciliation + CurseForge + fallback auteur + config preclassification. ✅
4. v0.4 — politiques config finales, targets, sensitive résolus, manifests client/server. ✅
5. v0.5 — release staging, signature Ed25519 (pluggable), anti-rollback (structure). ✅ staging local / signature unsigned-dev par défaut
5b. v0.5.x — PHASE 0.8 trust contract: payload canonique V1, verify-release, channels model, docs. ✅
5c. v0.6.0 — PHASE 0.9 local publisher: pack:publish, verify-channel, sequence, atomic publish tree. ✅
5d. v0.6.x — PHASE 0.9.1 channel commit race hardening. ✅
5e. v0.7.0 — PHASE 1.1 remote origin verifier (verify-origin + dist-origin). ✅
5f. v0.8.0 — Remote Publisher (pack:upload via SSH + commit gate + HTTPS verify). ✅
5g. v0.8.1 — timeout réel SSH/SCP/HTTP + cleanup dès SSH_PREPARE. ✅
6. v0.9.0 — resource packs client (manifest schema 6, SweetCraft-FR). ✅
6a. v0.9.1 — remote publisher hardening (--origin product base, committed-but-unverified, CLI help, catalogue défaut). ✅
6b. v0.9.x — autoEnable launcher / shaderpacks / datapacks (pas encore).
7. v1.0 — CLI stabilisé, SBOM/THIRD_PARTY_NOTICES et intégration launcher.
