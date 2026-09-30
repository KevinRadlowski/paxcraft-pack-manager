# SweetCraft Phase 0 — Audit canonique v0.1

Base: Minecraft 26.1.2 / Fabric Loader 0.19.3 / serveur sweetcraft.datho.st.

## Résumé
- 126 JAR top-level audités; 259 JAR embarqués (Jar-in-Jar) détectés.
- 298 fichiers de configuration inventoriés.
- Dépendances requises non satisfaites détectées: 0.
- Répartition side: BOTH_INDEPENDENT=2, BOTH_REQUIRED=70, CLIENT_ONLY=23, CLIENT_REQUIRED_SERVER_OPTIONAL=5, SERVER_ONLY=23, SERVER_REQUIRED_CLIENT_OPTIONAL=3
- Politique distribution: UPSTREAM_PREFERRED=107, UPSTREAM_REQUIRED=19
- Politique configs: CLIENT_DEFAULT_PRESERVE=36, COMMON_FORCE_REVIEW=167, NEVER_CLIENT_SECRET_REVIEW=37, SERVER_FORCE=58

## Règles SweetCraft
- Tout JAR tiers est téléchargé upstream (Modrinth prioritaire, CurseForge ensuite) lorsqu’une source exploitable existe.
- Aucun JAR ARR/custom/restrictif n’est rehosté sur le CDN SweetCraft sans permission explicite archivée.
- Les fichiers SERVER_ONLY ne sont jamais placés dans le manifest client.
- Les configs serveur et fichiers potentiellement sensibles ne sont jamais publiés dans le manifest client.
- Les paramètres purement utilisateur/client sont installés comme defaults puis préservés lors des updates.

## Points de sécurité détectés dans config.zip
- `config/luckperms/**` est classé serveur uniquement / jamais client.
- `config/resourceful-config-web.json` est classé revue sensible / jamais publié automatiquement.
- Des configs manifestement purement client (Sodium/Iris/JEI/Jade/etc.) sont classées DEFAULT/PRESERVE plutôt que FORCE.
- `config/zoomify.json` existe sans JAR Zoomify top-level correspondant: à considérer comme config orpheline/stale jusqu’à validation.

## Remarques de compatibilité
- `beautify-fabric-2.0.0+26.2.jar` porte `+26.2` dans son nom/version mais son metadata déclare `minecraft >=26.1`; il n’est donc pas rejeté automatiquement, mais il reste marqué à surveiller.
- `Structory_26.2_v1.3.7.jar` porte `26.2` dans son nom tandis que son metadata accepte `minecraft >=1.21`; le fichier est toléré par metadata mais mérite une validation runtime ciblée.
- Aucune dépendance obligatoire externe manquante n’a été trouvée après prise en compte des 157 Jar-in-Jar détectés.