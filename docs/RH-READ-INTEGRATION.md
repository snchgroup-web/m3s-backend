# Branchement RH en lecture seule

Statut : branchement fermé par défaut, publication du code autorisée le 06.10.2026, sans activation des sources réelles. Branche `codex/rh-read-integration-20261006`, base publiée `60d72ac1fe8b197a3e43057e356a6c2b2e66cfea`.

## Périmètre

`server.js` monte `/api/rh/private` avec `rhReadRuntime.js`, fermé par défaut : 503 `RH_NOT_ENABLED`. Aucun lecteur de droits, registre, identifiant salarié ou secret n'est configuré par ce montage. Aucune variable d'environnement ne suffit à l'activer. Le runtime ne crée pas de connexion SQL et ne déclenche pas de migration.

Le futur branchement doit fournir explicitement `enabled: true`, `qualified: true`, le runtime d'identité Google existant, un lecteur courant `readBindings` et `getRegister`. Ces fonctions doivent avoir été qualifiées avant activation. Le runtime utilise `createCurrentRhPolicy` ; il ne choisit pas la politique fixe disponible seulement pour les fixtures. `rhReadPolicy.js` reprend la politique déjà testée dans la qualification locale, sans déduire un droit RH du rôle ou de Finance.

Seul `GET /employees` est disponible. POST, PUT, PATCH, DELETE et HEAD sont refusés (405), sans analyser leur corps ni consulter le registre. Les deux parseurs globaux contournent la branche RH, y compris en casse différente comme Express ; les journaux généraux réduisent ses chemins au préfixe. Cela ne change pas les chemins de la GED ou les parseurs des autres routes.

Pour une lecture qualifiée : origine autorisée si présente, authentification existante et TOTP vérifié, habilitation RH courante, pagination bornée, registre injecté, projection minimale. La portée provient uniquement du compte/organisation authentifiés. Un retrait est contrôlé à la requête suivante ; aucune garantie de révocation atomique pendant une requête ni d'effacement immédiat d'une vue ouverte n'est revendiquée.

La réponse conserve `candidate: true`, les dossiers en brouillon C3 et les dates inconnues. Elle exclut contacts, montants, pièces d'identité, liaisons canoniques et propriétés privées du registre. Le nombre chargé n'est pas un total global. Cache interdit ; erreurs bornées sans contenu privé.

## Vérification

Huit nouveaux tests dans `tests/rhReadRuntime.test.js`, dont des parcours HTTP avec le vrai code du pont d'identité mais un fournisseur entièrement synthétique. Les exclusions de parseurs sont extraites du `server.js` de cette branche et exécutées sans démarrer l'application, charger `.env` ou appeler BigQuery/Google.

Qualification précédente : **82/82 réussis**. Contrôle prépublication du 06.10 : **69/69 réussis** sur six fichiers RH, identité, GED privée, cycle de vie et rattachement des pièces financières, aucun échec ou test ignoré. Ces périmètres ne sont pas additionnés. Bases PostgreSQL/PGlite et serveurs HTTP temporaires locaux uniquement, fermés après essais. Dépendances existantes réutilisées par une jonction locale `node_modules`, sans installation. Syntaxe de `server.js` contrôlée ; pas de démarrage complet local du serveur de production. Aucun écran n'est modifié par cette branche backend.

## Avant activation

- Qualifier les références des deux préparations existantes sans déduire une identité technique d'un nom ; contrôler les doublons avant tout import.
- Qualifier la source courante de lecture RH du responsable. Pas de compte salarié, nouvel accès IAM ou élargissement des permissions GED implicite.
- Brancher le registre restreint et contrôler réellement sa portée, son rôle SQL et son RLS. Ne pas injecter une connexion administrateur ni le rôle GED par commodité.
- Monter la vue de lecture dans le frontend isolé en préservant tous les champs du formulaire existant ; tester bureau/mobile et langues.
- Obtenir l'autorisation spécifique de sauvegarde, migration/droits SQL minimaux, import restreint et activation réelle. La publication du code fermé est autorisée séparément ; elle ne réalise pas ces opérations.

Les dossiers, droits, abonnements et contrats existants restent inchangés. Aucun compte réel ou document métier n'est embarqué dans cette branche. La vérification du déploiement effectif est consignée séparément après fusion.
