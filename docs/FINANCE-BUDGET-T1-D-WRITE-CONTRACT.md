# BUDGET-T1-D-001 V0.1 - cadrage candidat creation et mise a jour V2

Date de preparation : 09-09-2026.

Statut : candidat documentaire a confirmer ou amender. Ce document n'implemente rien et n'autorise ni fusion, route HTTP, stockage reel, IAM, DDL, migration, donnee reelle, recette preview ou activation Budget.

## Decision et perimetre

T1-D cadre la future creation et mise a jour des brouillons Budget V2 d'organisation, derriere une capacite fermee :

- creation d'un brouillon V2 direct, sans promotion V1 ;
- mise a jour de sa version courante par comparaison optimiste ;
- resolution de toutes les references en `WRITE` ;
- persistance atomique du budget et de ses instantanes au meme `writeAt` ;
- resultat certain, conflit certain ou resultat techniquement incertain explicitement distingue.

T1-D n'ajoute ni lecture HTTP, suppression, partage, approbation, export, historique de versions, promotion V1, Budget personnel ou activation. Les contrats, routes, tables et comportements V1 restent inchanges.

## Separation technique retenue

Le lot est separe en deux decisions :

1. `T1-D-A`, service de commande pur avec interfaces et doubles fictifs atomiques ;
2. `T1-D-B`, futur adaptateur de persistance reelle, soumis a un cadrage, un DDL, une migration et une autorisation distincts.

T1-D-A est le seul micro-lot d'implementation qui pourra etre propose apres confirmation du present document. Il ne connait ni Express, BigQuery, table, dataset, compte, secret ou variable d'environnement.

Les tables V1 actuelles ne sont pas reutilisees implicitement. Elles ne portent aucun discriminateur de contrat dans leurs colonnes de liste : y stocker un document V2 permettrait a la liste V1 de l'exposer avant validation. Toute persistance V2 reelle exige donc une separation prouvee par T1-D-B ; aucun schema n'est deduit de T1-D-A.

## Contrat pur T1-D-A candidat

Le futur module expose uniquement :

```text
createDraft({ tenantId, actorId, v2Enabled, financeRead, financeWrite, body })
updateDraft({ id, tenantId, actorId, v2Enabled, financeRead, financeWrite, body })
```

Les entrees sont fermees. `tenantId` et `actorId` representent le contexte serveur deja authentifie ; ils ne sont jamais lus dans `body`. La frontiere HTTP future restera hors de T1-D-A.

Le service recoit par injection :

- une horloge `clock` ;
- un generateur d'UUID V4 pour la creation ;
- une fabrique T1-B de service referentiel ;
- un stockage abstrait T1-D-A ;
- aucune dependance de production implicite.

Chaque appel construit ses dependances de requete sans cache inter-requetes. Le service ne modifie jamais `body`, les instantanes resolus ou les valeurs retournees par le stockage.

### Validateur partage avec T1-C-A

T1-D-A ne duplique pas les controles de l'enveloppe stockee. Le micro-lot pourra extraire de `financeBudgetV2Reads.js` un validateur pur partage, sans modifier le comportement public de T1-C-A. Ce validateur recoit un enregistrement candidat et l'instant contractuel, puis controle la forme fermee, les instantanes, les periodes, les parents, le resume, la version et la chronologie.

L'extraction est strictement mecanique et conserve tous les tests T1-C-A. Les regles propres a la lecture courante, au filtrage de liste et a T1-B.1 restent dans le service de lecture ; les regles propres a la commande, a T1-B en `WRITE` et a l'issue atomique restent dans T1-D-A. Aucun second schema d'instantane n'est autorise.

## Ordre ferme des controles

### Creation

1. forme fermee de la commande et charge T1-A de creation ;
2. authentification `tenantId + actorId` ;
3. capacite V2 ouverte ;
4. permissions courantes `finance:read` et `finance:write` ;
5. disponibilite du stockage abstrait ;
6. capture d'un unique `writeAt` UTC ;
7. generation d'un UUID V4 valide ;
8. construction d'un seul service T1-B avec `clock: () => new Date(writeAt.getTime())` ;
9. resolution complete en `operation: WRITE` ;
10. construction serveur du resume et de l'enveloppe stockee ;
11. creation atomique et classification certaine du resultat.

### Mise a jour

1. forme fermee de la commande, UUID et charge T1-A de mise a jour ;
2. authentification ;
3. capacite V2 ouverte ;
4. permissions courantes `finance:read` et `finance:write` ;
5. disponibilite du stockage abstrait ;
6. capture d'un unique `writeAt` UTC a la frontiere applicative ;
7. lecture bornee d'un unique enregistrement courant dans la portee tenant-auteur ;
8. absence, V1 ou hors portee classee `BUDGET_DRAFT_NOT_FOUND` ; doublon ou corruption structurelle inexploitable classe `BUDGET_STORAGE_UNAVAILABLE` ;
9. construction d'un seul service T1-B avec l'horloge figee ;
10. resolution complete de la nouvelle charge en `operation: WRITE` ;
11. controle de la version courante : version `1000000` terminale, puis egalite avec `expectedVersion` ;
12. construction de la nouvelle enveloppe avec remplacement complet des instantanes ;
13. comparaison-et-remplacement atomique par le stockage ;
14. classification certaine du resultat.

Cette precedence suit `BUDGET-T1-TECH-001 V0.1` : une reference absente, invisible, invalide ou indisponible est qualifiee avant un conflit de version. Le service ne court-circuite donc pas T1-B parce que `expectedVersion` parait obsolete.

## Instant unique et chronologie

`clock` est appelee exactement une fois par commande, apres les controles qui n'ont pas besoin du temps. Sa valeur doit etre une date UTC valide. T1-D-A en conserve une copie interne `writeAt` et injecte dans T1-B :

```text
clock: () => new Date(writeAt.getTime())
```

T1-B est appele avec `operation: WRITE`. Tous les `referenceSnapshots.*.resolvedAt` doivent etre exactement egaux a `writeAt.toISOString()`.

- creation : `version = 1` et `createdAt === updatedAt === resolvedAt` ;
- mise a jour : `version = current.version + 1`, `createdAt` reste strictement inchange et `updatedAt === resolvedAt` ;
- aucun `CURRENT_TIMESTAMP()` ou second appel d'horloge ne produit un horodatage contractuel concurrent ;
- une date technique distincte du stockage ne peut ni remplacer ni modifier ces champs.

Toute divergence entre l'instant T1-B, l'enveloppe et le resume bloque l'ecriture avant succes.

## Enveloppe stockee

Une creation directe produit exactement :

```text
document
├── contractVersion: 2
├── budget: charge T1-A valide, conservee sans normalisation
└── referenceSnapshots: resultat ferme T1-B au writeAt
```

Le resume serveur contient exactement :

```text
id, version, title, entity, year, createdAt, updatedAt,
scope: "organization", status: "draft", access: "owner-only"
```

`title` vient de `budget.title`. `entity` vient de `referenceSnapshots.identity.entityId.labelSnapshot`. `year` vient de `referenceSnapshots.identity.fiscalYearId.summaryYear`. Le client ne fournit aucun de ces champs serveur separement.

Avant T1-E, un bloc `promotion` ou une liaison de promotion est interdit. T1-D-A refuse toute presence avec `BUDGET_STORAGE_UNAVAILABLE`. La preservation immuable d'une promotion pendant une mise a jour sera integree seulement apres T1-E et sa propre preuve bidirectionnelle.

Le service valide le document construit avec les memes invariants purs que T1-C-A avant de le remettre au stockage. T1-D-A ne s'appuie jamais sur une future lecture HTTP pour reparer une ecriture invalide.

## Interface de stockage fictive

L'interface candidate ne prescrit aucun produit de base de donnees. Elle fournit au minimum :

```text
probe() -> { available: true }
getCurrentDraft({ id, tenantId, authorUserId })
createCurrentDraft({ record })
replaceCurrentDraft({ id, tenantId, authorUserId, expectedVersion, nextRecord })
findPromotionLinks({ tenantId, authorUserId, draftId })
```

Chaque resultat est ferme, borne et sans exception privee. Le double fictif prouve les comportements suivants :

- `getCurrentDraft` retourne zero, un ou plusieurs enregistrements explicitement ;
- `createCurrentDraft` est atomique sur l'identifiant dans la portee tenant-auteur ;
- `replaceCurrentDraft` compare et remplace dans une seule operation, jamais par lecture suivie d'une ecriture inconditionnelle ;
- budget, instantanes, resume, version et evenement d'audit sont une seule unite de resultat ;
- aucun echec certain n'ecrit partiellement le document ou l'evenement ;
- une reponse perdue apres debut possible de l'ecriture n'est jamais transformee en succes ni automatiquement retentee.

T1-D-A ne definit pas encore le DDL de l'evenement V2. Son double peut conserver un journal en memoire uniquement pour prouver l'atomicite et l'absence de double evenement. La forme persistante reelle appartient a T1-D-B.

## Resultats d'ecriture

Le stockage abstrait restitue une issue fermee :

```text
created       creation certaine, version 1
updated       remplacement certain, nextVersion exact
missing       absent au point atomique
conflict      version differente au point atomique
duplicate     incoherence d'unicite
uncertain     ecriture potentiellement appliquee, resultat non prouvable
unavailable   aucune ecriture prouvee, stockage indisponible
```

Le service ne deduit jamais un succes d'une absence d'exception. Il verifie l'issue, l'identifiant et la version retournes.

- `created` et `updated` produisent le resume ferme correspondant ;
- `missing` produit `BUDGET_DRAFT_NOT_FOUND` ;
- `conflict` produit `BUDGET_VERSION_CONFLICT` ;
- `duplicate` et `unavailable` produisent `BUDGET_STORAGE_UNAVAILABLE` ;
- `uncertain` produit `BUDGET_WRITE_UNCERTAIN` avec seulement `draftId` et `reconcileRequired: true`.

Une issue inconnue, mal formee ou contradictoire echoue fermee. Aucune ecriture incertaine n'est relancee automatiquement par T1-D-A.

## Concurrence et versions

- La creation reserve atomiquement l'UUID V4 genere ; une collision certaine ne genere pas silencieusement un autre identifiant dans la meme commande.
- La mise a jour exige `expectedVersion` de `1` a `999999` dans la charge cliente.
- Le stockage compare `expectedVersion` a la version courante dans la meme operation que le remplacement et l'audit.
- Une seule de deux mises a jour concurrentes portant la meme version peut reussir.
- La perdante retourne `BUDGET_VERSION_CONFLICT` et n'ecrit ni document partiel ni evenement.
- La version stockee `1000000` reste lisible mais retourne `BUDGET_VERSION_LIMIT` pour toute mise a jour.
- Aucune version `1000001` n'est calculee, transmise ou persistee.

## Erreurs fermees

T1-D-A emet uniquement :

| Code | Condition |
| --- | --- |
| `BUDGET_REQUEST_INVALID` | commande, UUID ou charge T1-A invalide |
| `BUDGET_AUTH_REQUIRED` | tenant ou acteur absent/invalide |
| `BUDGET_V2_DISABLED` | capacite V2 fermee |
| `BUDGET_ACCESS_DENIED` | `finance:read` ou `finance:write` absent |
| `BUDGET_STORAGE_UNAVAILABLE` | stockage, unicite, enveloppe ou resultat non verifiable |
| `BUDGET_DRAFT_NOT_FOUND` | mise a jour absente, V1, hors tenant ou hors auteur |
| codes T1-B documentes | resolution `WRITE` refusee selon sa cause exacte |
| `BUDGET_VERSION_LIMIT` | version courante terminale |
| `BUDGET_VERSION_CONFLICT` | comparaison atomique perdue ou version attendue differente |
| `BUDGET_WRITE_UNCERTAIN` | resultat potentiellement applique mais non prouvable |

Tout code inconnu d'une dependance est converti en erreur fermee. Les erreurs ne contiennent ni budget, montant, libelle, instantane, identite, exception privee ou resultat brut du stockage.

## Non-effets obligatoires

T1-D-A ne doit produire aucun des effets suivants :

- appel HTTP, enregistrement de route ou en-tete de reponse ;
- requete SQL, BigQuery, table, dataset, fichier de donnees ou secret ;
- IAM, DDL, migration, compte, permission ou activation ;
- ecriture V1, conversion ou promotion V1 vers V2 ;
- Budget personnel, partage, approbation, export ou suppression ;
- journalisation de charge, montant, libelle ou identite ;
- nouvelle tentative automatique apres une issue incertaine.

## Recette candidate T1-D-A

Les tests isoles devront couvrir au minimum :

1. regression complete V1 et T1-A/T1-B/T1-C-A ;
2. commandes fermees et precedence syntaxe, authentification, capacite, permissions et stockage ;
3. creation valide avec UUID V4 injecte, version `1` et resume serveur canonique ;
4. charge et valeurs decimales conservees sans normalisation ;
5. un seul appel d'horloge, un seul service T1-B et `WRITE` au meme `writeAt` ;
6. egalite stricte `createdAt === updatedAt === resolvedAt` a la creation ;
7. mise a jour conservant `createdAt`, remplacant tous les instantanes et incrementant une seule fois la version ;
8. portee tenant-auteur non revelatrice et V1 indistinguable de l'absence ;
9. absence, doublon et corruption stockee fermes sans mutation ;
10. chaque famille de refus T1-B avant la verification de version ;
11. version attendue obsolete et deux mises a jour concurrentes, avec un seul succes ;
12. version `1000000` refusant l'ecriture sans calcul de `1000001` ;
13. comparaison-et-remplacement et evenement fictif atomiques ;
14. issue certaine `created`, `updated`, `missing`, `conflict`, `duplicate` ou `unavailable` correctement classee ;
15. issue `uncertain` retournant seulement `draftId` et `reconcileRequired: true`, sans nouvelle tentative ;
16. resultat inconnu, identifiant divergent ou version divergente refuse ferme ;
17. bloc ou liaison de promotion refuse avant T1-E ;
18. mutation hostile de la charge, des instantanes ou du resultat du double sans contamination ;
19. extraction du validateur partage sans divergence et regression complete T1-C-A ;
20. preuve par recherche statique qu'aucune route, SQL, variable d'environnement ou dependance cloud n'est ajoutee ;
21. worktree, diff et suite backend propres avant toute PR.

## Arbitrage groupe candidat

Confirmer ou amender `BUDGET-T1-D-001 V0.1` en une decision groupee :

1. limiter T1-D aux commandes directes V2 `create` et `update` ;
2. separer `T1-D-A` pur de tout futur adaptateur reel `T1-D-B` ;
3. maintenir V1 strictement inchange et interdire le partage implicite de ses tables ;
4. extraire un validateur d'enveloppe pur partage avec T1-C-A, sans changer le comportement public de lecture ;
5. capturer un unique `writeAt` et l'imposer a T1-B, aux instantanes et aux horodatages ;
6. resoudre toutes les references en `WRITE` avant les controles de version ;
7. remplacer atomiquement document, instantanes, resume, version et audit ;
8. conserver `owner-only`, tenant-scoped et les permissions courantes `finance:read + finance:write` ;
9. distinguer conflits certains, indisponibilite certaine et ecriture incertaine sans nouvelle tentative ;
10. refuser toute promotion avant T1-E ;
11. autoriser seulement apres confirmation un micro-lot T1-D-A sur branche isolee, avec interfaces, doubles, tests et PR jusqu'au verdict propre, sans fusion automatique ;
12. maintenir fermes route HTTP, stockage reel, IAM, DDL, migration, donnee reelle, recette preview et activation Budget.

La confirmation de ce paquet validera uniquement le cadrage candidat. Elle ne vaudra ni autorisation d'implementation T1-D-A, ni fusion, ni ouverture operationnelle.

## Sources internes

- `docs/FINANCE-BUDGET-T1-TECHNICAL-CONTRACT.md`
- `docs/FINANCE-BUDGET-T1-C-READ-CONTRACT.md`
- `financeBudgetV2Contracts.js`
- `financeBudgetV2References.js`
- `financeBudgetV2Reads.js`
- `tests/financeBudgetV2Contracts.test.js`
- `tests/financeBudgetV2References.test.js`
- `tests/financeBudgetV2StoredReferences.test.js`
- `tests/financeBudgetV2Reads.test.js`
