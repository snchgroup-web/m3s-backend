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

Le futur micro-amendement T1-B.1 ajouterait une operation de preflight sans restitution, sans instantane et sans effet :

```text
preflightBudgetReferenceAvailability({ rawBudget, tenantId, actorId, operation, resolvedAt })
```

Cette operation candidate :

1. recoit le document Budget brut deja borne par le stockage, sans le declarer valide ;
2. utilise dans T1-B un extracteur ferme et borne pour enumerer les couples uniques `type + id` lorsqu'ils sont structurellement accessibles ;
3. appelle les memes interfaces de resolveur injectees avec le meme `resolvedAt` fige pour verifier qu'elles existent et rendent une reponse disponible, bien formee et non ambigue ; un tableau vide reussit ce preflight, plusieurs enregistrements produisent `BUDGET_REFERENCE_UNAVAILABLE`, et un enregistrement unique ne reussit qu'apres les memes validations structurelles `validateBaseRecord` et `validateSourceRecord` que T1-B ;
4. ne prononce ni visibilite, cycle de vie, exercice, responsabilite ou relation et ne retourne aucun enregistrement ; la validation des champs structurels comme `visible`, `status`, dates, revision source et parents canoniques ne vaut jamais decision sur leur contenu metier ;
5. retourne seulement un succes interne vide, ou les echecs fermes `BUDGET_REFERENCE_UNAVAILABLE` et `BUDGET_STORAGE_UNAVAILABLE` ;
6. traite un identifiant ou un chemin impossible a enumerer comme corruption stockee, sans inventer de reference ni appeler une source avec une valeur douteuse.

Apres un preflight reussi, T1-C applique T1-A a l'enveloppe complete, puis l'operation T1-B `READ` confirmee pour la resolution, la visibilite, les statuts et les relations. Le preflight ne remplace donc aucun controle et ne peut jamais rendre un budget recevable. Sa specification executable, ses erreurs exactes et ses tests relevent d'une autorisation d'implementation distincte ; le present document ne l'implemente pas.

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
7. capturer un seul instant UTC pour la requete ;
8. re-resoudre toutes les references avec l'operation T1-B `READ` ;
9. restituer seulement un brouillon dont le document, les instantanes, les relations et les references sont recevables.

Le responsable budgetaire, le controleur, un agent mentionne ou une permission Finance d'un autre utilisateur ne remplacent jamais l'auteur technique courant. T1-C reste `owner-only`.

La resolution courante sert de garde d'acces, pas de reecriture. Les libelles et instantanes nouvellement resolus ne remplacent jamais ceux de la version stockee pendant un `GET`. Aucun cache de visibilite ne peut survivre a la requete.

Pour une liste, la frontiere HTTP capture `requestAt` avant la premiere resolution et construit un seul service T1-B propre a la requete avec l'horloge injectee `clock: () => new Date(requestAt.getTime())`. Toutes les resolutions de tous les brouillons de cette page utilisent cette meme instance. L'horloge par defaut et la construction d'un service par brouillon sont interdites dans ce parcours. Cette regle reutilise le point d'injection confirme de T1-B sans modifier son interface et garantit un instant UTC identique pendant tout le filtrage.

Une reference absente, hors tenant, non visible ou `restricted` sans autorisation Management produit `BUDGET_REFERENCE_NOT_FOUND`. Une reference visible mais dont le cycle de vie ou la periode d'effet est irrecevable produit le code specialise T1-B applicable. Une source absente, ambigue, mal formee ou indisponible produit `BUDGET_REFERENCE_UNAVAILABLE`.

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
- `createdAt` et `updatedAt` valides ; pour `version === 1`, `resolvedAt <= createdAt` et `createdAt === updatedAt` ; pour `version > 1`, `createdAt <= resolvedAt <= updatedAt` ;
- aucune contradiction entre les parents soumis, resolus et instantanes ;
- une correspondance bidirectionnelle, dans la portee tenant-auteur, entre la presence du bloc `promotion` et une unique liaison T1-E persistante vers ce brouillon V2 : ni bloc sans liaison, ni liaison sans bloc, ni liaison multiple ;
- lorsqu'un bloc `promotion` existe avec sa liaison unique, sa forme fermee, ses types, ses bornes, son rapport, ses empreintes, sa provenance, l'identifiant V2 lie et ses invariants sont valides par le futur validateur pur confirme de T1-E, sans jamais exposer ce bloc ;
- des dates et champs de resume valides sans les recalculer depuis un libelle client.

Un doublon, un document mal forme, un instantane incomplet ou une incoherence interne produit un refus ferme. La lecture ne repare rien et ne retourne pas une version partielle.

Le schema T1-B ne persiste pas `allowedResponsibilities`. T1-C ne peut donc ni prouver ni nier retrospectivement qu'un agent possedait un role donne au `resolvedAt` stocke. Il recontrole seulement l'eligibilite actuelle du responsable et du controleur avec T1-B `READ`. Une preuve historique immuable des roles exigerait un schema d'instantane et un lot separes.

Avant T1-E, aucun bloc ni liaison de promotion ne peut exister ; toute presence signalee echoue fermee avec `BUDGET_STORAGE_UNAVAILABLE`. T1-E devra injecter sa lecture de liaison et son validateur dans le parcours T1-C avant d'autoriser la premiere promotion. Apres cette integration, l'absence du bloc n'etablit une creation directe que si la recherche tenant-auteur par identifiant V2 confirme aussi l'absence de liaison. Une source de liaison indisponible, un resultat ambigu ou toute divergence bloc-liaison produit `BUDGET_STORAGE_UNAVAILABLE` ; aucun controle partiel n'est admis.

## Liste, ordre et pagination

Les brouillons actuellement lisibles sont ordonnes par `updatedAt DESC`, puis `id ASC`. `offset` et `limit` s'appliquent apres les controles de portee, de contrat et de visibilite courante.

Une future interface de liste devra donc parcourir des candidats V2 bornes au tenant et a l'auteur, puis verifier leur lisibilite avant de constituer la page. Elle collecte au plus `offset + limit + 1` brouillons lisibles afin de calculer `hasMore`.

- Un candidat absent, V1, hors portee ou rendu invisible est omis sans signaler son existence.
- Un candidat dont le statut courant interdit la restitution est omis.
- L'indisponibilite ou l'ambiguite d'une source necessaire bloque toute la liste ; aucune page partielle n'est retournee.
- Une corruption du stockage ou un doublon bloque toute la liste ; aucun resume douteux n'est omis silencieusement.
- Le parcours technique devra posseder une borne explicite et testee. Si cette borne ne permet pas de determiner la page et `hasMore`, l'operation echoue fermee au lieu de presenter une liste incomplete comme exhaustive.

Cette pagination est deterministe pour un jeu stable. Un instantane coherent sous ecritures concurrentes necessiterait un futur contrat par curseur, hors T1-C.

## Erreurs et precedence

Les echecs conservent l'enveloppe fermee `{ success: false, contractVersion: 2, code }`, sans charge, montant, libelle, reference cachee ou detail de securite.

| Code | HTTP | Condition T1-C |
| --- | --- | --- |
| `BUDGET_REQUEST_INVALID` | `400` | identifiant ou parametre mal forme, inconnu ou hors borne |
| `BUDGET_AUTH_REQUIRED` | `401` | identite absente ou invalide |
| `BUDGET_V2_DISABLED` | `503` | capacite V2 fermee |
| `BUDGET_ACCESS_DENIED` | `403` | `finance:read` absent |
| `BUDGET_STORAGE_UNAVAILABLE` | `503` | stockage indispensable indisponible, ambigu ou corrompu |
| `BUDGET_DRAFT_NOT_FOUND` | `404` | brouillon absent, V1, hors tenant, hors auteur ou non visible |
| `BUDGET_REFERENCE_UNAVAILABLE` | `503` | source necessaire absente, ambigue ou mal formee |
| `BUDGET_REFERENCE_NOT_FOUND` | `404` | reference absente, hors tenant ou non visible en lecture directe |
| `BUDGET_REFERENCE_STATE_INVALID` | `422` | cycle de vie ou periode d'effet irrecevable |
| `BUDGET_FISCAL_YEAR_INVALID` | `422` | exercice visible mais structure ou calendrier invalide |
| `BUDGET_RESPONSIBILITY_INVALID` | `422` | responsabilite visible mais non recevable |
| `BUDGET_REFERENCE_RELATION_INVALID` | `422` | relation parent-enfant contradictoire apres validation individuelle |

La precedence conserve exactement celle de `BUDGET-T1-TECH-001 V0.1` : syntaxe, authentification, capacite, permission, disponibilite du stockage, existence et portee du brouillon, preflight T1-B.1 de disponibilite des referentiels, validation complete T1-A, resolution et visibilite T1-B, cycle de vie et periode d'effet, exercice, responsabilites, relations, puis version et autres controles d'integrite stockee applicables a la lecture. Une corruption detectee ne remplace donc pas un `BUDGET_REFERENCE_UNAVAILABLE` deja etabli. Si le document est trop mal forme pour identifier le jeu de references a interroger, `BUDGET_STORAGE_UNAVAILABLE` s'applique immediatement, puisqu'aucune disponibilite referentielle propre a ce document ne peut etre determinee. Pour une liste, les cas volontairement omis ci-dessus ne sont pas des reponses d'erreur individuelles ; toute indisponibilite systemique reste bloquante. Tant que T1-B.1 n'existe pas, les lectures T1-C restent desactivees.

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
7. ordre canonique, pagination apres filtrage et calcul de `hasMore` ;
8. recontrole T1-B `READ` a chaque requete avec un seul instant UTC ;
9. liste de plusieurs brouillons proches d'une borne d'effet resolue avec un unique `requestAt` injecte, meme si l'horloge reelle avance pendant le parcours ;
10. reference archivee ou cloturee seulement lorsque la visibilite historique l'autorise ;
11. omission non revelatrice d'un brouillon devenu invisible dans la liste ;
12. codes fermes en lecture directe pour absence, statut, exercice, responsabilite et relation ;
13. indisponibilite, ambiguite, doublon ou corruption sans succes partiel ;
14. version `1000000` lisible et versions hors borne refusees ;
15. refus d'une ligne dont les periodes divergent du calendrier de l'exercice instantane et refus d'un tableau d'exercice hors ordre canonique des ordinaux ;
16. refus de deux instantanes divergents pour un meme couple `type + id` repete ;
17. refus d'instantanes portant plusieurs `resolvedAt`, un instant hors periode d'effet ou un statut historiquement incompatible avec les champs persistes, sans inventer un historique des roles ;
18. refus d'un resume dont `title` diverge de `budget.title`, comme de `entity` ou `year` divergents ;
19. refus d'une portee, d'un statut, d'un acces ou d'une chronologie serveur incoherents, avec les relations temporelles propres a la version initiale et aux versions mises a jour ;
20. refus d'une enveloppe racine ouverte ou d'un bloc `promotion` incomplet, inconnu ou non validable ;
21. refus de tout bloc sans liaison T1-E unique, de toute liaison sans bloc et de toute divergence entre les deux, avec preuve du cas direct `zero bloc + zero liaison` ;
22. preflight T1-B.1 prouvant la precedence referentielle sur un document corrompu mais extractible, sans retourner de donnee ni contourner T1-A/T1-B ;
23. preflight reussi lorsqu'une source disponible retourne zero enregistrement, puis traitement de l'absence uniquement par T1-B `READ` en `404` direct ou omission de liste ;
24. preflight refuse en `BUDGET_REFERENCE_UNAVAILABLE` un enregistrement unique qui echoue aux validations structurelles de source, avant toute integrite Budget, tout en deferant visibilite, cycle de vie et relations ;
25. `NO-GO` de T1-C lorsque T1-B.1 est absent, incomplet ou non confirme ;
26. preuve qu'aucune lecture ne modifie document, instantanes, compteur ou journal.

Ces tests utiliseront seulement des interfaces pures et des doubles fictifs tant qu'aucun stockage reel n'est autorise.

## Arbitrage groupe candidat

Confirmer ou amender `BUDGET-T1-C-001 V0.1` en une decision groupee :

1. limiter T1-C a `GET liste` et `GET detail` V2, sans autre operation ;
2. definir `liste versionnee` comme restitution de la version courante, sans historique ;
3. maintenir V1 strictement inchange et invisible depuis V2 ;
4. interdire toute conversion, promotion, correction ou reecriture implicite en lecture ;
5. maintenir l'acces `owner-only`, tenant-scoped et derive du compte courant ;
6. recontroler toutes les references avec T1-B `READ` a chaque restitution ;
7. appliquer ordre et pagination apres filtrage de la visibilite courante, sans succes partiel ;
8. retourner uniquement les dix champs de resume dans la liste et le document stocke valide en lecture directe ;
9. echouer ferme sur indisponibilite systemique, ambiguite, doublon ou corruption ;
10. exiger une autorisation distincte pour le prerequis pur T1-B.1, puis une autre avant toute implementation T1-C, fusion, recette preview ou activation.

La confirmation de ce paquet validera uniquement le cadrage candidat. Elle ne vaudra ni autorisation d'implementation ni autorisation de fusion.

## Sources internes

- `docs/FINANCE-BUDGET-T1-TECHNICAL-CONTRACT.md`
- `docs/FINANCE-BUDGET-T1-REFERENTIALS-ROLES.md`
- `financeBudgetV2Contracts.js`
- `financeBudgetV2References.js`
- `tests/financeBudgetV2Contracts.test.js`
- `tests/financeBudgetV2References.test.js`
