# BUDGET-T1-D-B-2-B-001 V0.1 - cadrage candidat du planificateur de migration V2

Date de preparation : 09-09-2026.

Statut : candidat documentaire a confirmer ou amender. Ce document ne cree aucun planificateur, pilote, schema, table, compte, role ou secret. Il n'autorise ni connexion, execution SQL, acces cloud, IAM, migration, donnee reelle, route HTTP, recette preview ou activation Budget.

## Finalite

T1-D-B.2-B doit transformer le DDL hors ligne valide dans T1-D-B.2-A en un plan de migration ferme, deterministe, cible et verifiable, sans jamais se connecter ni executer une instruction.

Le planificateur devra repondre uniquement a trois questions :

1. la cible declaree est-elle admissible pour une future preuve isolee ?
2. le catalogue atteste est-il vide, deja conforme ou divergent ?
3. quelle decision explicite serait necessaire avant de transmettre un plan inchange a un futur executeur ?

Il ne repare rien, ne decouvre aucune cible, ne lit aucun secret et ne decide jamais seul d'appliquer le DDL.

## Position dans la trajectoire

| Porte | Objet | Etat apres ce cadrage |
| --- | --- | --- |
| `T1-D-B.2-A` | DDL PostgreSQL V2 hors ligne et contrat de catalogue | livre dans `main` |
| `T1-D-B.2-B` | planificateur pur, cible et ferme | cadrage candidat uniquement |
| `T1-D-B.2-C` | execution sur moteur local ephemere et donnees fictives | ferme |
| `T1-D-B.3` | concurrence, atomicite, restauration et moindre privilege | ferme |
| route V2 | exposition backend controlee | fermee |
| frontend Budget | interface en deploy preview | ferme |
| production | stockage et interface publics | fermes |

Le travail actuel n'est donc pas encore visible sur `seneswiss-group.com`. Le premier rendu utilisateur sera une deploy preview distincte, seulement apres les preuves de stockage et l'autorisation des routes et du frontend. Le site public restera inchange jusqu'a une recette fonctionnelle explicite.

## Perimetre fonctionnel candidat

Le futur module pur pourra exposer exactement :

```text
buildBudgetV2PostgresMigrationPlan({ schemaPlan, target, inventory, generatedAt })
validateBudgetV2PostgresMigrationAuthorization({ plan, authorization, now })
```

Ces fonctions ne recevront ni client SQL, ni chaine de connexion, ni mot de passe, ni variable d'environnement. Elles ne pourront appeler aucun reseau, systeme de fichiers, processus ou SDK.

La premiere fonction produit un plan ou un refus ferme. La seconde verifie une autorisation candidate deja recue ; elle ne declenche aucune execution.

## Entrees fermees

### Plan de schema

`schemaPlan` doit etre exactement le resultat intact de `buildBudgetV2PostgresOfflinePlan` :

- contrat `BUDGET-T1-D-B-2-A-001` ;
- moteur `postgresql` ;
- schema fixe `finance_budget_v2` ;
- mode `offline-only` ;
- empreinte SHA-256 exacte ;
- trois instructions attendues, sans ajout ni retrait ;
- catalogue ferme attendu.

Toute derive de contenu ou d'empreinte est un arret.

### Cible logique

`target` doit rester non sensible et contenir exactement :

| Champ | Regle candidate |
| --- | --- |
| `targetRef` | identifiant opaque visible ASCII, borne a 96 caracteres |
| `environment` | exactement `local-ephemeral` avant T1-D-B.3 |
| `engine` | exactement `postgresql` |
| `postgresMajor` | entier de `16` a `18` |
| `databaseName` | exactement `m3s_budget_v2_ephemeral` |
| `schemaName` | exactement `finance_budget_v2` |
| `databaseEncoding` | exactement `UTF8` |
| `dataClassification` | exactement `synthetic-only` |

La cible ne contient aucun hote, port, utilisateur, mot de passe, chemin de certificat, URL, projet cloud ou adresse IP. Ces elements appartiendront au futur executeur et resteront hors du plan partage.

### Inventaire atteste

`inventory` est fourni au planificateur par un futur collecteur separe. T1-D-B.2-B ne le collecte pas.

Il doit contenir exactement :

| Champ | Regle candidate |
| --- | --- |
| `targetRef` | egal a la cible logique |
| `observedAt` | instant UTC canonique |
| `collectorContract` | exactement `BUDGET-T1-D-B-2-COL-001` |
| `databaseEncoding` | `UTF8` |
| `postgresMajor` | identique a la cible |
| `schemaState` | `missing`, `empty`, `conformant` ou `divergent` |
| `catalog` | `null` ou catalogue ferme T1-D-B.2-A |
| `catalogFingerprint` | SHA-256 du catalogue ou `null` |
| `unexpectedObjects` | liste vide exigee hors etat divergent |

L'inventaire ne contient ni donnees de brouillon, contenu de table, identite reelle, secret ou journal fournisseur.

## Decisions du planificateur

Le resultat contient toujours une issue fermee :

### `blocked`

Le plan est bloque si :

- le schema cible est absent ;
- la version, l'encodage ou la cible divergent ;
- le catalogue est partiel ou divergent ;
- un objet, droit, fonction, vue, declencheur ou extension inattendu est signale ;
- le plan T1-D-B.2-A ou son empreinte ont change ;
- l'inventaire est ouvert, mal forme, trop ancien ou rattache a une autre cible.

Un blocage ne fournit aucune instruction executable et ne propose aucune reparation.

### `planned-create`

Cette issue est possible seulement si :

- le schema dedie existe deja ;
- il est strictement vide ;
- aucun droit ou objet inattendu n'est atteste ;
- la cible est locale, ephemere et reservee aux donnees fictives ;
- le plan de schema est intact.

Le resultat reprend les trois instructions exactes de T1-D-B.2-A, dans leur ordre, sans les executer.

### `planned-noop`

Cette issue est possible seulement si le catalogue atteste est strictement conforme au contrat T1-D-B.2-A. Aucune instruction n'est alors retournee. Le plan prouve l'idempotence logique sans rejouer le DDL.

Il n'existe aucune issue `repair`, `alter`, `drop`, `force`, `continue` ou `best-effort`.

## Structure du plan candidat

Le plan produit doit contenir exactement :

| Champ | Regle candidate |
| --- | --- |
| `contractId` | `BUDGET-T1-D-B-2-B-001` |
| `planVersion` | `1` |
| `outcome` | une des trois issues fermees |
| `target` | copie gelee de la cible logique |
| `schemaPlanFingerprint` | empreinte T1-D-B.2-A |
| `inventoryFingerprint` | empreinte de l'inventaire exact |
| `statements` | trois instructions exactes ou liste vide |
| `destructiveStatements` | toujours liste vide |
| `requiresAuthorization` | vrai seulement pour `planned-create` |
| `rollbackMode` | exactement `disable-only` |
| `generatedAt` | instant fourni par l'appelant et valide |
| `expiresAt` | au plus 30 minutes apres `generatedAt` |
| `fingerprint` | SHA-256 canonique de tous les champs precedents |

Le temps n'est jamais lu directement dans le module. `generatedAt` est fourni une seule fois a la frontiere appelante. Un plan expire ne peut pas etre revalide ou prolonge ; il doit etre reconstruit depuis un nouvel inventaire.

## Autorisation candidate

Une autorisation ne peut viser qu'un plan `planned-create` non expire. Elle contient exactement :

| Champ | Regle candidate |
| --- | --- |
| `decisionRef` | reference gouvernee visible ASCII, bornee a 96 caracteres |
| `planFingerprint` | egal a l'empreinte du plan |
| `targetRef` | egal a la cible du plan |
| `confirmation` | phrase exacte derivee de la cible et de l'empreinte |
| `authorizedAt` | instant UTC, compris entre generation et expiration |
| `scope` | exactement `apply-three-budget-v2-ddl-statements` |

La phrase candidate est :

```text
APPLY BUDGET V2 DDL TO <targetRef> AT <fingerprint>
```

La validation retourne uniquement une attestation gelee et non sensible. Elle ne retourne aucun client, secret, jeton reutilisable ou fonction d'execution.

Une autorisation T1-D-B.2-B ne vaut pas autorisation de T1-D-B.2-C. Elle prouve seulement que le couple plan-cible a ete approuve selon le contrat ; l'execution locale restera soumise a une decision distincte.

## Fraicheur et anti-rejeu

- L'inventaire doit dater de moins de 10 minutes au moment de la generation du plan.
- Le plan expire au plus 30 minutes apres sa generation.
- `authorizedAt` doit etre posterieur ou egal a `generatedAt` et inferieur ou egal a `expiresAt`.
- La moindre modification de cible, inventaire, DDL, ordre des instructions ou temps change l'empreinte.
- Une empreinte deja marquee consommee par un futur executeur ne pourra pas etre rejouee ; le registre de consommation appartient a T1-D-B.2-C et reste ferme.

## Retour arriere

T1-D-B.2-B ne produit aucun `DROP`, `TRUNCATE`, `DELETE`, `ALTER` ou migration descendante.

Le seul retour arriere candidat est `disable-only` :

1. ne pas connecter le runtime aux tables V2 ;
2. conserver les objets et preuves pour diagnostic ;
3. produire un nouvel inventaire ;
4. soumettre toute suppression a une decision separee.

## Erreurs et observabilite

Les erreurs publiques doivent utiliser un message unique et un code ferme, sans recopier l'inventaire, le SQL, la cible ou une exception technique.

Les preuves de test peuvent contenir : identifiant du contrat, issue, empreintes, version majeure fictive, duree et nombre d'instructions. Elles excluent tout secret, contenu Budget, chaine de connexion, hote, utilisateur et trace brute.

## Recette candidate du futur micro-lot pur

1. plan et inventaire intacts donnent une sortie deterministe et profondement gelee ;
2. schema absent donne `blocked` sans instructions ;
3. schema vide donne `planned-create` avec exactement trois instructions ;
4. catalogue conforme donne `planned-noop` sans instruction ;
5. schema divergent, partiel ou inattendu donne `blocked` sans reparation ;
6. cible et inventaire doivent correspondre exactement ;
7. inventaire perime refuse avant toute construction ;
8. empreinte change au moindre changement autorise et refuse toute alteration ulterieure ;
9. autorisation exacte acceptee uniquement dans la fenetre temporelle ;
10. autorisation incorrecte, expiree ou rattachee a une autre cible refusee ;
11. aucun DDL destructif ou objet V1 n'apparait ;
12. aucune route, connexion, execution SQL, variable d'environnement, fichier ou SDK ;
13. regression complete du backend et controles statiques propres.

## Criteres d'arret

Le lot s'arrete si :

- le planificateur doit se connecter pour decider ;
- une cible autre que locale et ephemere devient admissible ;
- le schema manquant est cree implicitement ;
- un catalogue divergent peut etre repare automatiquement ;
- une autorisation peut survivre a une modification du plan ou de la cible ;
- une commande destructive est necessaire ;
- le module lit une horloge, un secret ou une variable d'environnement ;
- T1-D-B.2-C, une route ou une activation devient necessaire pour tester le lot pur.

## Trajectoire de visibilite sur seneswiss-group.com

La visibilite utilisateur exige encore les decisions ordonnees suivantes :

1. confirmer et fusionner le futur planificateur pur T1-D-B.2-B ;
2. autoriser et reussir T1-D-B.2-C sur moteur local ephemere et donnees fictives ;
3. autoriser et reussir T1-D-B.3, notamment concurrence, atomicite et restauration ;
4. choisir et preparer une cible preview isolee avec IAM et secrets gouvernes ;
5. brancher l'adaptateur PostgreSQL reel derriere une capacite fermee ;
6. ouvrir les routes V2 dans une deploy preview authentifiee ;
7. connecter l'interface Budget et realiser la recette desktop/mobile ;
8. autoriser seulement ensuite la mise en production publique.

Cette trajectoire permet de rendre Budget visible en preview avant production, sans exposer prematurement un stockage incomplet. Aucune date calendaire n'est promise tant que les portes techniques et les choix d'hebergement ne sont pas valides.

## Arbitrage groupe candidat

Confirmer ou amender `BUDGET-T1-D-B-2-B-001 V0.1` en une decision unique :

1. limiter T1-D-B.2-B a un planificateur pur sans connexion ni execution ;
2. fixer la cible a un PostgreSQL local ephemere, UTF-8 et donnees fictives ;
3. accepter seulement `blocked`, `planned-create` et `planned-noop` ;
4. refuser toute reparation ou commande destructive ;
5. lier cible, inventaire, DDL, temps et autorisation par empreintes exactes ;
6. limiter la fraicheur de l'inventaire a 10 minutes et le plan a 30 minutes ;
7. conserver le retour arriere `disable-only` ;
8. rendre la preview, puis la production, dependantes des portes ulterieures explicites ;
9. autoriser apres confirmation uniquement le micro-lot pur T1-D-B.2-B sur branche isolee, avec tests et PR jusqu'au verdict propre, sans fusion automatique ;
10. maintenir fermes T1-D-B.2-C, T1-D-B.3, pilote, connexion, execution SQL, stockage reel, acces cloud, IAM, migration, donnee reelle, route HTTP, recette preview, frontend et activation Budget ;
11. maintenir T1-E et le Budget personnel hors perimetre.

La confirmation de ce paquet valide uniquement le cadrage. Elle n'autorise ni implementation, fusion, execution locale, acces cloud, route ou mise en production.

## Sources internes

- `docs/FINANCE-BUDGET-T1-D-B-2-ENGINE-MIGRATION-CONTRACT.md`
- `docs/FINANCE-BUDGET-T1-D-B-STORAGE-CONTRACT.md`
- `financeBudgetV2PostgresSchema.js`
- `financeBudgetV2StorageAdapter.js`
- `financeBudgetV2Writes.js`
- `tests/financeBudgetV2PostgresSchema.test.js`
