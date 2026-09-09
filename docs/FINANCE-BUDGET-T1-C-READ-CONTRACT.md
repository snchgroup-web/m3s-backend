# BUDGET-T1-C-001 V0.1 - cadrage candidat lecture V2 et liste versionnee

Date de preparation : 09-09-2026.

Statut : candidat documentaire a confirmer ou amender. Ce document n'implemente rien et n'autorise ni fusion, route, stockage reel, IAM, DDL, migration, donnee reelle, recette preview ou activation Budget.

## Decision et perimetre

T1-C cadre uniquement la future lecture des brouillons Budget V2 d'organisation :

- une liste paginee des brouillons V2 actuellement lisibles par leur auteur ;
- une lecture directe d'un brouillon V2 actuellement lisible par son auteur ;
- la restitution de la version courante stockee et validee ;
- un nouveau controle de la visibilite courante des references a chaque requete.

Le contrat V1, ses routes, ses charges, ses reponses, ses droits et ses tables restent inchanges. T1-C n'ajoute ni conversion, promotion, creation, modification, suppression, partage, approbation, export ou historique de versions.

Dans ce paquet, `liste versionnee` signifie que chaque resume restitue le numero `version` courant du brouillon. Cette expression ne designe pas un historique de versions : le stockage actuel remplace le document courant et ne conserve pas les contenus successifs.

## Preconditions constatees

- T1-A fournit les contrats et validateurs purs V2.
- T1-B fournit les interfaces pures de resolution et leurs doubles fictifs.
- Le contrat technique confirme separe les familles `/api/finance/budget-drafts` et `/api/finance/budget-drafts-v2`.
- Aucun endpoint V2 n'est actuellement ouvert par le present cadrage.

L'operation T1-B confirmee valide actuellement toute l'enveloppe V2 avant d'appeler un resolveur. Elle ne peut donc pas, a elle seule, prouver la precedence confirmee `disponibilite des referentiels avant integrite stockee` lorsqu'un document corrompu conserve des identifiants extractibles. T1-C reste cadrable, mais son implementation est `NO-GO` tant que le micro-amendement pur `T1-B.1` ci-dessous n'est pas autorise, implemente, teste et confirme separement.

Apres ce prerequis, une future implementation T1-C dependra uniquement des interfaces injectees confirmees. Elle ne devra pas inventer un referentiel, lire directement une table metier externe ou contourner un resolveur.

## Prerequis pur T1-B.1 candidat

Le futur micro-amendement T1-B.1 ajouterait une operation de resolution stockee, sans restitution externe et sans effet :

```text
resolveStoredBudgetReferences({ rawBudget, tenantId, actorId, operation, resolvedAt })
```

Cette operation candidate :

1. recoit le document Budget brut deja borne par le stockage, sans le declarer valide ;
2. utilise dans T1-B un extracteur ferme et borne pour enumerer les references et les seules relations necessaires lorsqu'elles sont structurellement accessibles ;
3. resout une seule fois chaque couple unique `type + id` avec les interfaces confirmees et le meme `resolvedAt` fige ;
4. applique dans l'ordre confirme disponibilite, unicite structurelle, tenant, visibilite et confidentialite, cycle de vie, periode d'effet, exercice, responsabilites et relations ;
5. traite un tableau vide comme `BUDGET_REFERENCE_NOT_FOUND`, plusieurs enregistrements comme `BUDGET_REFERENCE_UNAVAILABLE`, et limite ce meme code aux echecs d'un enregistrement unique dans `validateBaseRecord` ou `validateSourceRecord` ; les champs fiscaux et de responsabilite sont controles ensuite par `validateFiscalYear` et `validateTypeRecord` avec leurs codes specialises `BUDGET_FISCAL_YEAR_INVALID` et `BUDGET_RESPONSIBILITY_INVALID` ;
6. applique seulement apres ces controles le validateur complet T1-A a l'enveloppe Budget ;
7. ne produit ses instantanes internes qu'apres le succes T1-A, a partir du meme cache resolu, sans rappeler une source ni changer d'instant ;
8. ne retourne aucun enregistrement brut et ne rend jamais un budget invalide recevable ;
9. traite un identifiant ou un chemin necessaire impossible a enumerer comme corruption stockee, sans inventer de reference ni appeler une source avec une valeur douteuse.

Une absence ou une invisibilite est donc classee par T1-B.1 avant une corruption independante du titre, d'un montant ou d'un autre champ non referentiel : `404` en lecture directe et omission non revelatrice dans une liste. Si la structure des references elle-meme est inexploitable, `BUDGET_STORAGE_UNAVAILABLE` reste immediat. Cette operation remplace, pour les brouillons stockes seulement, le double parcours `preflight puis READ` ; elle garantit une resolution unique et une precedence stable. Sa specification executable, ses erreurs exactes et ses tests relevent d'une autorisation d'implementation distincte ; le present document ne l'implemente pas.

## Contrat temporel partage T1-C / T1-D candidat

Le futur stockage T1-D devra capturer un unique `writeAt` UTC a la frontiere applicative de chaque creation ou mise a jour. Ce meme instant est passe a T1-B comme `resolvedAt` et persiste par T1-D comme horodatage de la version ; les champs compares ne sont jamais produits par un `CURRENT_TIMESTAMP()` independant de la base.

- A la creation, `resolvedAt`, `createdAt` et `updatedAt` sont strictement egaux a `writeAt`.
- A la mise a jour, `createdAt` reste immuable et anterieur ou egal a `writeAt`, tandis que `resolvedAt` et `updatedAt` sont strictement egaux a `writeAt`.
- Une date technique de base distincte peut exister pour son exploitation interne, mais elle n'entre ni dans le contrat restitue ni dans les controles chronologiques T1-C.

L'ordre confirme reste `T1-C` puis `T1-D`. T1-C peut donc etre implemente et teste d'abord avec une interface de stockage pure et des doubles fictifs qui fournissent ces horodatages coherents. T1-D implemente ensuite la capture et la persistance reelles du meme `writeAt`. Aucun cablage de route T1-C vers un stockage reel, aucune recette integree et aucune activation ne sont permis tant que T1-D n'a pas prouve ce contrat temporel. Chaque micro-lot garde son autorisation et sa revue separees ; le present paquet ne les implemente pas.

## Contrat de restitution candidat

Les deux operations futures restent celles de `BUDGET-T1-TECH-001 V0.1` :

| Methode / chemin futur | Entree | Succes candidat |
| --- | --- | --- |
| `GET /api/finance/budget-drafts-v2` | `limit` entier `1..50`, defaut `20`; `offset` entier `0..10000`, defaut `0`; aucun autre parametre | `200`, `{ success: true, contractVersion: 2, data: summary[], hasMore }` |
| `GET /api/finance/budget-drafts-v2/:id` | UUID conforme a `ID_PATTERN`; aucun parametre de requete | `200`, `{ success: true, contractVersion: 2, data: { ...summary, budget, referenceSnapshots } }` |

Chaque succes porte `Cache-Control: no-store`. `summary` contient exactement :

```text
id, version, title, entity, year, createdAt, updatedAt, scope, status, access
```

La liste ne restitue jamais `budget`, montant, `referenceSnapshots`, metadonnees de promotion, empreinte, cle idempotente ou detail d'une reference. La lecture directe ne restitue `budget` et `referenceSnapshots` qu'apres tous les controles.

Le serveur ne complete, ne corrige et ne normalise aucun contenu pendant une lecture. Il restitue la version courante validee telle qu'elle est stockee. Toute actualisation de reference ou d'instantane exige une future commande d'ecriture distincte et explicitement autorisee.

## Separation stricte V1 et V2

1. La lecture V1 continue de reconnaitre uniquement un document sans `contractVersion`.
2. La lecture V2 reconnait uniquement un document portant exactement `contractVersion: 2`.
3. Un identifiant V1 presente a la lecture V2 produit le meme `404 BUDGET_DRAFT_NOT_FOUND` qu'un identifiant absent, hors tenant, hors auteur ou non visible.
4. Une lecture V2 ne parse, ne transforme et ne promeut jamais une charge V1.
5. Une lecture V1 ne parse jamais une charge V2 et n'en revele pas l'existence.
6. Les listes V1 et V2 restent distinctes. Une vue commune releve d'un lot ulterieur.

## Autorisation et visibilite courantes

Pour chaque requete future, le serveur devra :

1. valider la syntaxe ;
2. authentifier l'identite courante ;
3. verifier que la capacite V2 est ouverte ;
4. relire `finance:read` depuis le compte actif ;
5. verifier la disponibilite du stockage indispensable ;
6. borner les candidats au `tenantId` et a l'`authorUserId` derives du serveur ;
7. capturer un seul instant UTC `requestAt` pour la requete ;
8. re-resoudre toutes les references avec T1-B.1 en lui passant explicitement `operation: READ` et `resolvedAt: requestAt` a chaque appel ;
9. restituer seulement un brouillon dont le document, les instantanes, les relations et les references sont recevables.

Le responsable budgetaire, le controleur, un agent mentionne ou une permission Finance d'un autre utilisateur ne remplacent jamais l'auteur technique courant. T1-C reste `owner-only`.

La resolution courante sert de garde d'acces, pas de reecriture. Les libelles et instantanes nouvellement resolus ne remplacent jamais ceux de la version stockee pendant un `GET`. Aucun cache de visibilite ne peut survivre a la requete.

Pour une lecture directe comme pour une liste, la frontiere HTTP capture `requestAt` avant la premiere resolution. Chaque appel a `resolveStoredBudgetReferences` recoit explicitement `operation: READ` et une copie du meme instant avec `resolvedAt: new Date(requestAt.getTime())`. Il est interdit d'omettre l'operation, de la remplacer par `WRITE`, de recalculer cet instant par brouillon, d'utiliser l'horloge par defaut ou de substituer un autre `resolvedAt` pendant le parcours. La liste partage ainsi les memes regles de lecture et une seule frontiere temporelle pour tous ses candidats, meme si l'horloge reelle avance pendant le filtrage.

Une reference absente, hors tenant, non visible ou `restricted` sans autorisation Management produit `BUDGET_REFERENCE_NOT_FOUND`. Une reference visible mais dont le cycle de vie ou la periode d'effet est irrecevable produit le code specialise T1-B applicable. Une source absente, ambigue, indisponible ou dont l'enregistrement unique echoue a `validateBaseRecord` ou `validateSourceRecord` produit `BUDGET_REFERENCE_UNAVAILABLE`. Un defaut fiscal, de responsabilite ou de relation detecte apres ces controles conserve son code specialise.

## Integrite du brouillon lu

Avant restitution, une future implementation devra verifier :

- un seul enregistrement V2 correspondant au tenant, a l'auteur et a l'identifiant ;
- `contractVersion: 2` exact ;
- `version` entiere de `1` a `1000000`, la valeur terminale restant lisible ;
- une enveloppe racine fermee contenant exactement `contractVersion`, `budget`, `referenceSnapshots` et, seulement pour un brouillon issu d'une promotion, `promotion` ;
- une enveloppe `budget` valide selon T1-A ;
- un bloc `referenceSnapshots` ferme, complet et sans entree orpheline ;
- une correspondance exacte entre chaque `row.id` et chaque `rowId` d'instantane ;
- pour chaque chemin d'identite, de responsabilite ou de dimension, un `snapshot.id` non nul strictement egal a l'identifiant porte par `budget` au meme chemin, et `null` des deux cotes lorsqu'une dimension est absente ;
- pour chaque ligne, un ensemble de `periodValues[].periodId` strictement egal a celui des `periods[].periodId` de l'exercice instantane, sans manque, doublon ou periode etrangere ;
- un tableau `referenceSnapshots.identity.fiscalYearId.periods` stocke dans l'ordre canonique strictement croissant de `ordinal`, de `1` a `12`, tel que produit par T1-B ;
- pour chaque couple `type de reference + id` repete dans le budget, des instantanes stockes strictement identiques sur tous leurs champs canoniques ;
- un unique `resolvedAt` commun a tous les instantanes non nuls de la version stockee ;
- chaque `resolvedAt` inclus dans la periode d'effet semi-ouverte `[effectiveFrom, effectiveTo)` de son instantane, avec `effectiveTo: null` pour une reference non expirante ;
- chaque `statusSnapshot` et chaque calendrier d'exercice mecaniquement recevables pour une operation T1-B `WRITE` a ce `resolvedAt` d'apres les champs effectivement persistes ; pour un agent de responsabilite, ce controle historique couvre le cycle de vie et la periode d'effet, mais ne pretend pas reconstituer ses anciens roles autorises ;
- `title` strictement egal a `budget.title` ;
- `entity` et `year` egaux aux valeurs serveur de l'instantane d'identite stocke ;
- `scope: "organization"`, `status: "draft"` et `access: "owner-only"` exacts ;
- `createdAt` et `updatedAt` valides et issus du meme instant applicatif que les instantanes de leur version ; pour `version === 1`, `resolvedAt === createdAt === updatedAt` ; pour `version > 1`, `createdAt <= resolvedAt` et `resolvedAt === updatedAt` ;
- aucune contradiction entre les parents soumis, resolus et instantanes ;
- une correspondance bidirectionnelle, dans la portee tenant-auteur, entre la presence du bloc `promotion` et une unique liaison T1-E persistante vers ce brouillon V2 : ni bloc sans liaison, ni liaison sans bloc, ni liaison multiple ;
- lorsqu'un bloc `promotion` existe avec sa liaison unique, sa forme fermee, ses types, ses bornes, son rapport, ses empreintes, sa provenance, l'identifiant V2 lie et ses invariants sont valides par le futur validateur pur confirme de T1-E, sans jamais exposer ce bloc ;
- des dates et champs de resume valides sans les recalculer depuis un libelle client.

Un doublon, un document mal forme, un instantane incomplet ou une incoherence interne produit un refus ferme. La lecture ne repare rien et ne retourne pas une version partielle.

Le schema T1-B ne persiste pas `allowedResponsibilities`. T1-C ne peut donc ni prouver ni nier retrospectivement qu'un agent possedait un role donne au `resolvedAt` stocke. Il recontrole seulement l'eligibilite actuelle du responsable et du controleur avec T1-B.1 au `requestAt` courant. Une preuve historique immuable des roles exigerait un schema d'instantane et un lot separes.

Avant T1-E, aucun bloc ni liaison de promotion ne peut exister ; toute presence signalee echoue fermee avec `BUDGET_STORAGE_UNAVAILABLE`. T1-E devra injecter sa lecture de liaison et son validateur dans le parcours T1-C avant d'autoriser la premiere promotion. Apres cette integration, l'absence du bloc n'etablit une creation directe que si la recherche tenant-auteur par identifiant V2 confirme aussi l'absence de liaison. Une source de liaison indisponible, un resultat ambigu ou toute divergence bloc-liaison produit `BUDGET_STORAGE_UNAVAILABLE` ; aucun controle partiel n'est admis.

## Liste, ordre et pagination

Les brouillons actuellement lisibles sont ordonnes par `updatedAt DESC`, puis `id ASC`. `offset` et `limit` s'appliquent apres les controles de portee, de contrat et de visibilite courante.

Une future interface de liste devra donc parcourir des candidats V2 bornes au tenant et a l'auteur, puis verifier leur lisibilite avant de constituer la page. Elle collecte au plus `offset + limit + 1` brouillons lisibles afin de calculer `hasMore`. La borne normative `MAX_LIST_CANDIDATES` vaut exactement `10051`, soit `offset maximal 10000 + limit maximal 50 + 1`.

- Un candidat absent, V1, hors portee ou rendu invisible est omis sans signaler son existence.
- Un candidat qui produit `BUDGET_REFERENCE_NOT_FOUND`, `BUDGET_REFERENCE_STATE_INVALID`, `BUDGET_FISCAL_YEAR_INVALID`, `BUDGET_RESPONSIBILITY_INVALID` ou `BUDGET_REFERENCE_RELATION_INVALID` est omis : ces codes decrivent un brouillon individuellement non restituable, sans rendre les autres brouillons illisibles.
- L'indisponibilite ou l'ambiguite d'une source necessaire bloque toute la liste ; aucune page partielle n'est retournee.
- Une corruption du stockage ou un doublon qui demeure le premier resultat observable apres la precedence normative bloque toute la liste ; aucun resume douteux n'est restitue. Une corruption independante masquee par un refus referentiel anterieur propre au brouillon ne remplace pas son omission et n'est pas exposee pendant cette requete.
- Le stockage retourne au plus `MAX_LIST_CANDIDATES + 1`, donc `10052`, candidats ordonnes : les `10051` premiers peuvent etre resolus et le dernier sert uniquement de sentinelle d'existence, sans resolution. Le parcours s'arrete avec succes des que `offset + limit + 1` brouillons lisibles sont collectes ou lorsque la source est exhaustivement terminee dans cette borne. Si la sentinelle existe et que les `10051` candidats inspectables ne suffisent pas a determiner la page et `hasMore`, toute la liste echoue en `503 BUDGET_STORAGE_UNAVAILABLE`, sans page partielle. Cette borne et ce code sont identiques pour toute implementation.

Cette pagination est deterministe pour un jeu stable. Un instantane coherent sous ecritures concurrentes necessiterait un futur contrat par curseur, hors T1-C.

## Erreurs et precedence

Les echecs conservent l'enveloppe fermee `{ success: false, contractVersion: 2, code }`, sans charge, montant, libelle, reference cachee ou detail de securite.

| Code | HTTP | Condition T1-C |
| --- | --- | --- |
| `BUDGET_REQUEST_INVALID` | `400` | identifiant ou parametre mal forme, inconnu ou hors borne |
| `BUDGET_AUTH_REQUIRED` | `401` | identite absente ou invalide |
| `BUDGET_V2_DISABLED` | `503` | capacite V2 fermee |
| `BUDGET_ACCESS_DENIED` | `403` | `finance:read` absent |
| `BUDGET_STORAGE_UNAVAILABLE` | `503` | stockage indispensable indisponible, ambigu ou corrompu, ou sentinelle presente apres `10051` candidats sans page et `hasMore` determinables |
| `BUDGET_DRAFT_NOT_FOUND` | `404` | brouillon absent, V1, hors tenant, hors auteur ou non visible |
| `BUDGET_REFERENCE_UNAVAILABLE` | `503` | source necessaire absente, ambigue, indisponible ou enregistrement unique refusant `validateBaseRecord` ou `validateSourceRecord` |
| `BUDGET_REFERENCE_NOT_FOUND` | `404` | reference absente, hors tenant ou non visible en lecture directe |
| `BUDGET_REFERENCE_STATE_INVALID` | `422` | cycle de vie ou periode d'effet irrecevable |
| `BUDGET_FISCAL_YEAR_INVALID` | `422` | exercice visible mais structure ou calendrier invalide |
| `BUDGET_RESPONSIBILITY_INVALID` | `422` | responsabilite visible mais non recevable |
| `BUDGET_REFERENCE_RELATION_INVALID` | `422` | relation parent-enfant contradictoire apres validation individuelle |

La precedence conserve exactement celle de `BUDGET-T1-TECH-001 V0.1` : syntaxe, authentification, capacite, permission, disponibilite du stockage, existence et portee du brouillon, puis T1-B.1 pour disponibilite des referentiels, resolution et visibilite, cycle de vie et periode d'effet, exercice, responsabilites et relations, avant la validation complete T1-A, la version et les autres controles d'integrite stockee applicables a la lecture. Une corruption non referentielle detectee ne remplace donc pas un refus referentiel deja etabli. Si le document est trop mal forme pour identifier le jeu de references a interroger, `BUDGET_STORAGE_UNAVAILABLE` s'applique immediatement, puisqu'aucune decision referentielle propre a ce document ne peut etre determinee. Pour une liste, les cas volontairement omis ci-dessus ne sont pas des reponses d'erreur individuelles ; toute indisponibilite systemique reste bloquante. Tant que T1-B.1 n'existe pas, les lectures T1-C restent desactivees.

## Non-effets obligatoires

Une future lecture T1-C ne doit produire aucun des effets suivants :

- `INSERT`, `UPDATE`, `DELETE`, evenement d'audit d'ecriture ou increment de version ;
- promotion V1 vers V2, rapprochement implicite ou invention d'identifiant ;
- remplacement de `referenceSnapshots`, de `entity`, de `year` ou d'un libelle ;
- creation de table, colonne, index, compte, secret, permission ou dataset ;
- ouverture du Budget personnel, partage, approbation ou export ;
- activation de la capacite Budget dans un environnement.

## Recette candidate du futur micro-lot

La future implementation ne pourra etre proposee qu'avec des tests isoles couvrant au minimum :

1. regression complete des routes et charges V1 ;
2. authentification, permission courante, capacite fermee et `no-store` ;
3. isolement tenant et auteur sans fuite d'existence ;
4. exclusion croisee V1/V2 et absence de conversion implicite ;
5. validation stricte de l'enveloppe, de la version et des instantanes, y compris l'egalite de chaque identifiant entre `budget` et son chemin d'instantane ;
6. liste limitee aux dix champs de resume, sans contenu financier ;
7. ordre canonique, pagination apres filtrage et calcul de `hasMore`, avec `MAX_LIST_CANDIDATES = 10051` et echec `BUDGET_STORAGE_UNAVAILABLE` si la sentinelle prouve que la page reste indeterminable ;
8. recontrole T1-B.1 a chaque requete avec `operation: READ` et `resolvedAt` explicitement egal au seul `requestAt` capture, y compris le refus d'un appel omettant l'operation ou utilisant `WRITE` ;
9. liste de plusieurs brouillons proches d'une borne d'effet dont chaque appel T1-B.1 recoit `operation: READ` et ce meme `requestAt`, meme si l'horloge reelle avance pendant le parcours ;
10. reference archivee ou cloturee seulement lorsque la visibilite historique l'autorise ;
11. omission non revelatrice d'un brouillon devenu invisible dans la liste ;
12. codes fermes en lecture directe pour absence, statut, exercice, responsabilite et relation ;
13. indisponibilite, ambiguite, doublon ou corruption sans succes partiel ;
14. version `1000000` lisible et versions hors borne refusees ;
15. refus d'une ligne dont les periodes divergent du calendrier de l'exercice instantane et refus d'un tableau d'exercice hors ordre canonique des ordinaux ;
16. refus de deux instantanes divergents pour un meme couple `type + id` repete ;
17. refus d'instantanes portant plusieurs `resolvedAt`, un instant hors periode d'effet ou un statut historiquement incompatible avec les champs persistes, sans inventer un historique des roles ;
18. refus d'un resume dont `title` diverge de `budget.title`, comme de `entity` ou `year` divergents ;
19. refus d'une portee, d'un statut, d'un acces ou d'une chronologie serveur incoherents, avec egalite stricte `resolvedAt === createdAt === updatedAt` a la creation, puis `resolvedAt === updatedAt` et `createdAt` immuable a la mise a jour ;
20. refus d'une enveloppe racine ouverte ou d'un bloc `promotion` incomplet, inconnu ou non validable ;
21. refus de tout bloc sans liaison T1-E unique, de toute liaison sans bloc et de toute divergence entre les deux, avec preuve du cas direct `zero bloc + zero liaison` ;
22. T1-B.1 prouvant la precedence complete des refus referentiels sur un document dont un champ non referentiel est corrompu mais dont les references restent extractibles ;
23. T1-B.1 classant zero enregistrement en `BUDGET_REFERENCE_NOT_FOUND`, donc `404` direct ou omission de liste, avant la corruption non referentielle ;
24. T1-B.1 limitant `BUDGET_REFERENCE_UNAVAILABLE` aux echecs de `validateBaseRecord` et `validateSourceRecord`, puis conservant les codes specialises des champs fiscaux, responsabilites et relations ;
25. liste omettant un brouillon sur son refus referentiel prioritaire meme si une corruption independante existe, mais bloquant lorsque la corruption reste le premier resultat observable ;
26. liste omettant de facon deterministe les cinq familles de refus propres a un brouillon et bloquant seulement sur indisponibilite systemique ou corruption stockee encore observable ;
27. `NO-GO` de T1-C lorsque T1-B.1 est absent, incomplet ou non confirme ;
28. preuve qu'aucune lecture ne modifie document, instantanes, compteur ou journal ;
29. pagination inspectant au plus `10051` candidats, ne resolvant jamais la sentinelle `10052`, reussissant si la page est determinable ou la source epuisee et retournant exactement `503 BUDGET_STORAGE_UNAVAILABLE` sinon ;
30. T1-D reutilisant un seul `writeAt` pour les instantanes et les horodatages compares, sans `CURRENT_TIMESTAMP()` independant, et refus T1-C de toute divergence.

Ces tests utiliseront seulement des interfaces pures et des doubles fictifs tant qu'aucun stockage reel n'est autorise.

## Arbitrage groupe candidat

Confirmer ou amender `BUDGET-T1-C-001 V0.1` en une decision groupee :

1. limiter T1-C a `GET liste` et `GET detail` V2, sans autre operation ;
2. definir `liste versionnee` comme restitution de la version courante, sans historique ;
3. maintenir V1 strictement inchange et invisible depuis V2 ;
4. interdire toute conversion, promotion, correction ou reecriture implicite en lecture ;
5. maintenir l'acces `owner-only`, tenant-scoped et derive du compte courant ;
6. recontroler toutes les references avec T1-B.1 en `READ` au meme `requestAt` a chaque restitution ;
7. appliquer ordre et pagination apres filtrage de la visibilite courante, sans succes partiel ;
8. retourner uniquement les dix champs de resume dans la liste et le document stocke valide en lecture directe ;
9. echouer ferme sur indisponibilite systemique, ambiguite, doublon ou corruption ;
10. maintenir l'ordre `T1-C` puis `T1-D` : tester T1-C avec un stockage fictif coherent, puis exiger de T1-D le meme `writeAt` applicatif pour les instantanes et les horodatages persistes ;
11. exiger une autorisation distincte pour T1-B.1, puis T1-C et T1-D ; interdire tout cablage de route vers le stockage reel, fusion, recette preview ou activation avant confirmation des lots requis.

La confirmation de ce paquet validera uniquement le cadrage candidat. Elle ne vaudra ni autorisation d'implementation ni autorisation de fusion.

## Sources internes

- `docs/FINANCE-BUDGET-T1-TECHNICAL-CONTRACT.md`
- `docs/FINANCE-BUDGET-T1-REFERENTIALS-ROLES.md`
- `financeBudgetV2Contracts.js`
- `financeBudgetV2References.js`
- `tests/financeBudgetV2Contracts.test.js`
- `tests/financeBudgetV2References.test.js`
