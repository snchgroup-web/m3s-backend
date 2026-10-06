# Registre RH et source courante de lecture

Lot du 06.10.2026, branche locale `codex/rh-storage-qualification-20261006`,
base publiée `fb95cd1ef601321bd1f2fb8fa209226307fbcbd0`.

## Frontières

`sql/rh-private-v1.sql` est une initialisation opérateur transactionnelle,
pas une migration au démarrage. Elle refuse un schéma déjà présent ; pas de
`IF NOT EXISTS` masquant un conflit. Elle crée cinq tables : version, racines
des dossiers, demandes idempotentes, révisions C3 et décisions de lecture.
Les quatre registres métier commencent vides. Aucune identité canonique,
date d'embauche, fonction, paie, compte salarié ou habilitation n'est inventée.

RLS activée et forcée, portée technique organisation/responsable hachée,
droits PUBLIC retirés ; les grants par défaut inattendus font annuler la
transaction. Le seul enregistrement initial est `rh-read-v1`, métadonnée
technique. Le rôle GED n'obtient aucun accès au schéma RH.

`rhPostgresSource.js` prépare `readBindings` et `getRegister` pour le runtime
de lecture déjà publié. Source qualifiée injectée explicitement, pas de
switch d'environnement suffisant. Connexion candidate sur la base existante,
TLS vérifié, rôle distinct `m3s_rh_reader`, pool borné à deux connexions.
Ce fichier ne crée ni rôle, pool, secret, table ou grant à lui seul.

Chaque transaction est en lecture seule et contrôle le rôle sans privilège
administratif, sans héritage/appartenance, sans propriété de table, sans
écriture/DDL, les tables/RLS et la version. La source ne renvoie que `read`,
jamais `create` ou `revise`. La décision la plus récente est relue avant la
sélection des dossiers, même après un premier contrôle de politique. Aucune
garantie de révocation atomique d'une requête déjà en vol ou d'effacement
temps réel d'un écran ouvert n'est revendiquée.

Les erreurs SQL restent bornées, rollback et libération du client contrôlés.
Les projections excluent références d'identité, contacts, pièces et salaires.
Dates inconnues conservées à null, page chargée distincte d'un total global.

## Qualification locale

Tests PGlite/HTTP avec profils entièrement synthétiques : initialisation vide,
refus sans décision, lecture scoped, révocation, séparation compte/organisation,
refus de mutations et d'auto-habilitation, droits SQL excessifs/RLS/version
invalides, reprise transactionnelle et confidentialité des erreurs. Le test
HTTP consomme le vrai runtime publié avec une authentification synthétique ;
les tests séparés du pont d'identité vérifient Google/TOTP avec fournisseur simulé.
Ce n'est pas une authentification Google réelle de ce nouveau lecteur.

Le montage local de `server.js` utilise maintenant `rhReadBootstrap.js` :
profil explicite `rh-read-v1`, identité Google complète, mot de passe RH dédié
et certificat obligatoire. Sans ces préconditions, aucune allocation de pool.
Chaque lecture contrôle aussi l'absence de droit sur des tables hors RH ;
un grant PUBLIC inattendu ferme la source. Aucune DDL au démarrage.
Le GET `/access`, protégé par le même Google/TOTP et la décision courante,
renvoie uniquement un marqueur borné pour le compte/organisation authentifiés.
Le marqueur frontend ne dispense jamais du contrôle serveur de chaque lecture.

Qualification locale du raccordement : 50 tests backend ciblés réussis,
34 tests frontend ciblés réussis et compilation de production réussie.
QA entièrement synthétique bureau/mobile 390 x 844, FR/EN/DE, détails,
refus et source fermée, changement de compte : pas d'erreur applicative observée.
Pas encore de publication GitHub, fusion, déploiement ou recette SQL réelle
avec la nouvelle credential. Tests et preuves détaillés dans le journal.

## Passage restant

1. Rôle dédié NOLOGIN et décision RH du responsable créés après confirmation,
   avec GED comparée inchangée. Zéro dossier/révision salarié importé.
2. Credential définie par Cheikh ; seule sa présence a été contrôlée. Variables
   `M3S_RH_DB_PASSWORD` et `M3S_RH_DB_CA_PEM` présentes, masquées et en attente
   de déploiement. CA référencée depuis le certificat de la même base existante,
   sans lecture/export de valeur ni réutilisation du mot de passe GED.
3. Avant l'action, confirmer LOGIN/publication/redéploiement en lecture seule ;
   contrôler la connexion privée/TLS réelle, puis l'accès authentifié et les refus.
   Aucune qualification de la longueur ou correspondance du secret sur sa seule
   présence masquée. Le profil de production n'est pas encore ajouté.
4. L'import reste séparé : valider les correspondances individuelles des
   préparations existantes. Aucun compte salarié, contrat ou paie n'est activé
   par la lecture du registre technique actuellement vide.

Sauvegarde et initialisation réelles sont des opérations séparées, consignées
dans `../../../M3S_JOURNAL_DE_BORD_2026-10-06.md`, pas acquises par ces tests.
La sauvegarde ponctuelle du registre PostgreSQL ne sauvegarde pas les pièces
du bucket GED, BigQuery ou les identités Google ; ce n'est pas un PITR.
