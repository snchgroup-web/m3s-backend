# BUDGET-T1-TECH-001 V0.1 - contrat technique candidat

Date de preparation : 07-09-2026.

Ce document traduit `BUDGET-T1-001 V0.1` en contrat technique candidat. Il ne modifie aucun endpoint, validateur, schema, droit, dataset, table ou brouillon. Il n'autorise ni DDL, migration, recette preview, activation Budget, donnee reelle, approbation, partage ou Budget personnel.

## Objectif borne

Le futur lot T1 doit pouvoir rattacher un budget d'organisation a une identite metier, un exercice, des responsabilites et des dimensions analytiques controlees, tout en conservant les brouillons V1 lisibles et modifiables par leur proprietaire.

Le contrat courant reste la reference executable tant qu'un lot d'implementation distinct n'est pas confirme :

- routes actuelles et portee `organization` ;
- acces `owner-only` ;
- droits `finance:read` et `finance:write` derives du compte courant ;
- statut serveur `draft` ;
- format exact V1 de `budget_json` ;
- tables `finance_budget_drafts_v1` et `finance_budget_draft_events_v1` inchangees.

## Strategie d'API

La compatibilite doit etre explicite. Le candidat retient une nouvelle famille de routes seulement lors d'une future implementation :

```text
/api/finance/budget-drafts     contrat V1 courant, URL inchangee
/api/finance/budget-drafts-v2  contrat T1, ferme tant que ses preconditions ne sont pas satisfaites
```

Le suffixe V2 distinct evite qu'un segment `v2` soit interprete comme l'actuel parametre `/:id`. Une charge V2 ne doit jamais etre acceptee par la route V1 ni reduite silencieusement au format V1. Une charge V1 ne doit jamais recevoir de rattachement invente. Les reponses V2 doivent annoncer `contractVersion: 2`; les reponses V1 conservent leur forme actuelle.

## Enveloppe V2 candidate

Le serveur continue de deriver `tenantId`, `authorUserId`, la portee et les permissions. Le client ne peut pas les remplacer.

```json
{
  "contractVersion": 2,
  "budget": {
    "title": "Budget de fonctionnement 2SG",
    "identity": {
      "entityId": "ORG-2SG",
      "fiscalYearId": "FY-2SG-2027"
    },
    "responsibilities": {
      "budgetOwnerAgentId": "agent-id",
      "controllerAgentId": null
    },
    "rate": "710",
    "rateSource": "Source documentee",
    "rateDate": "2026-09-07",
    "rows": [
      {
        "id": "row-1",
        "label": "Frais administratifs",
        "kind": "operating",
        "direction": "out",
        "currency": "CHF",
        "periodValues": [
          { "periodId": "FY-2SG-2027-P01", "value": "0" },
          { "periodId": "FY-2SG-2027-P02", "value": "" }
        ],
        "dimensions": {
          "functionId": "administration",
          "teamId": null,
          "agentId": null,
          "countryId": null,
          "portfolioId": "PORT-2SG-GLOBAL",
          "dossierId": "GD-001",
          "projectId": null,
          "phaseId": null
        }
      }
    ]
  }
}
```

Cet exemple abrege illustre la forme et seulement les deux premieres periodes ; il n'est pas une charge valide tant que tous les `periodId` de l'exercice ne sont pas fournis. `ORG-2SG`, `FY-2SG-2027` et les autres identifiants ne deviennent recevables qu'apres resolution dans leurs referentiels actifs du tenant courant. Le client ne fournit pas `entityLabelSnapshot` : le serveur le copie exclusivement depuis le `labelSnapshot` de l'organisation resolue.

Le futur `budgetCode` reste absent de la charge cliente tant que son format, son autorite d'emission et son unicite ne sont pas confirmes. Il devra etre produit par le serveur, jamais derive du titre.

## Contrat des references

Chaque reference soumise est resolue par un composant serveur injecte. Un resultat de resolution possede au minimum :

```text
id, tenantId, status, labelSnapshot, sourceRevision
```

Le serveur persiste ensuite dans l'enveloppe V2 courante un `referenceSnapshots` pour chaque chemin resolu. Chaque instantane conserve `id`, `labelSnapshot`, `sourceRevision` et `resolvedAt` produits par le serveur. Il couvre l'organisation, l'exercice, les responsabilites et chaque dimension de ligne, indexee par son `row.id` unique.

Avec les tables V1 inchangees, une mise a jour remplace `budget_json` et ne conserve donc pas les instantanes des versions precedentes. T1 ne revendique aucun historique probatoire des revisions. Un historique immuable exige un stockage versionne distinct, relevant d'un futur lot DDL et d'audit explicitement autorise. Le journal d'evenements courant conserve uniquement l'action et le numero de version.

Le resultat est recevable seulement si :

1. l'identifiant est exact et unique ;
2. le tenant correspond a l'identite authentifiee ;
3. le statut autorise l'usage budgetaire a la date de la requete ;
4. la politique de confidentialite et de visibilite propre a l'objet autorise cet utilisateur a le referencer et a revoir son libelle ;
5. la revision source est disponible pour l'audit ;
6. les relations parent-enfant sont coherentes.

Une permission Finance et l'appartenance au tenant ne suffisent pas a ouvrir un objet `restricted`. Le resolveur applique aussi la confidentialite de chaque portefeuille, dossier ou future reference ; il renvoie le meme refus generique pour un objet absent et un objet non visible afin de ne pas reveler son existence.

Une indisponibilite de source, une ambiguite ou une reference inconnue produit un refus ferme. Aucun libelle, alias, devise, texte `Autre` ou valeur historique ne remplace un identifiant.

## Matrice d'ouverture technique

| Reference | Source candidate | Etat T1 | Effet sur une future ecriture V2 |
| --- | --- | --- | --- |
| Organisation | registre a confirmer | `BLOQUANT` | Refus tant que le registre actif n'existe pas |
| Exercice | registre a creer ou confirmer | `BLOQUANT` | Refus tant que bornes, periodicite et fuseau ne sont pas resolus |
| Fonction | menus canoniques / portefeuille | `TRANSITION` | Lecture candidate seulement apres contrat unique |
| Equipe et agent | RH-001 / `teamAgentContract` | `TRANSITION` | Controle candidat, jamais source d'un droit |
| Portefeuille et dossier | registres Management | `ACTIF` | Resolution tenant-scoped et chaine parentale obligatoire |
| Projet et phase | modele documente, registre backend absent | `BLOQUANT SI FOURNI` | Valeur nulle admise ; valeur fournie refusee |
| Pays | registre actif non confirme | `BLOQUANT SI FOURNI` | Valeur nulle admise ; valeur fournie refusee |
| DAS | mapping derive | `DERIVE` | Jamais accepte comme saisie cliente faisant autorite |
| Centre de cout, financeur | aucun referentiel confirme | `FERME` | Champs absents du contrat V2 initial |

Organisation et exercice sont obligatoires pour tout nouveau budget V2. Par consequent, aucune creation V2 n'est possible avant leurs deux contrats de referentiel actifs. Cette fermeture est intentionnelle.

Le resolveur d'exercice retourne aussi la liste ordonnee de ses periodes : `periodId`, `ordinal`, `startDate` et `endDate`. Le contrat V2 initial accepte uniquement un calendrier `monthly` contenant exactement douze periodes mensuelles valides, continues, non chevauchantes et couvrant integralement l'exercice. Tout calendrier trimestriel, hebdomadaire, a treize periodes ou autrement non mensuel est `incompatible` et bloque l'ecriture. Chaque ligne V2 utilise `periodValues` avec exactement une valeur par `periodId` attendu, sans doublon ni periode etrangere. L'ordre du tableau n'a aucun effet metier. Pour un exercice juillet-juin, `P01` designe la periode definie par le referentiel et jamais janvier par position.

## Responsabilites

- `authorUserId` reste derive de la session et protege par les droits Finance courants.
- `budgetOwnerAgentId` designe le responsable metier du brouillon ; il ne recoit aucun droit par ce rattachement.
- `controllerAgentId` est nullable et purement descriptif dans T1 ; il n'ouvre ni lecture ni ecriture.
- l'approbateur et le lecteur partage restent absents du contrat T1 ; ils appartiennent a T2.
- la coherence equipe-agent utilise RH-001 et autorise le collectif de la meme equipe, sans transformer le collectif en compte utilisateur.

Aucun utilisateur ne peut s'auto-attribuer une permission par une responsabilite metier. Les permissions sont relues depuis le compte actif a chaque requete, selon le comportement courant.

## Controles de cardinalite

1. Un budget V2 possede exactement une organisation et un exercice.
2. Chaque `row.id` est non vide et unique dans le budget.
3. Une ligne possede au plus une valeur par dimension T1 et exactement le jeu de periodes de l'exercice resolu.
4. Un dossier exige son portefeuille parent.
5. Un projet exige son dossier parent ; une phase exige son projet parent.
6. Une equipe et un agent fournis ensemble doivent etre coherents.
7. Toutes les references appartiennent au tenant courant.
8. Une reference inactive ou indisponible est refusee.
9. Une valeur absente reste `null` ou absente ; elle ne devient pas zero ni une reference par defaut.

## Persistance candidate sans DDL implicite

Le premier lot executable T1 devrait conserver les tables V1 et stocker l'enveloppe V2 versionnee dans `budget_json`, sans ajouter de colonne par anticipation. Les colonnes de resume actuelles resteraient des instantanes compatibles :

- `title` depuis `budget.title` ;
- `entity` depuis le `labelSnapshot` canonique retourne par le resolveur d'organisation, jamais depuis la charge cliente ;
- `year` depuis le `summaryYear` canonique retourne par le resolveur d'exercice, jamais depuis la charge cliente ;
- `tenant_id` et `owner_user_id` derives du serveur.

Le referentiel d'exercice fournit un `summaryYear` de quatre chiffres distinct de son libelle. Pour un exercice decale, ce champ est une convention explicite du referentiel, pas une deduction du client ou des dates. Une divergence entre le `year` V1 promu et le `summaryYear` resolu est signalee dans le rapport et bloque la promotion jusqu'a arbitrage.

Le discriminateur reste interne a `budget_json` : un document V1 ne possede pas `contractVersion`; un document V2 porte exactement `contractVersion: 2`. Les requetes V1 devront filtrer `JSON_VALUE(budget_json, '$.contractVersion') IS NULL`, et les requetes V2 `JSON_VALUE(budget_json, '$.contractVersion') = '2'`, pour les listes, lectures et mises a jour. Un identifiant de l'autre contrat est traite comme introuvable dans la portee demandee et n'est jamais parse par le mauvais validateur.

Cette strategie n'est acceptable que si les limites de taille, le cout des filtres JSON et les usages de liste restent suffisants. Toute normalisation, nouvel index, table ou colonne constitue un lot DDL separe, reversible et explicitement autorise.

## Lecture et compatibilite

- Les routes V1 continuent de lire et ecrire les brouillons V1 sans modification.
- Les routes V2 lisent seulement les brouillons marques `contractVersion: 2`.
- Les listes V1 et V2 restent distinctes ; une vue commune eventuelle appartient a un lot ulterieur.
- Chaque liste, lecture, export et mise a jour V2 re-resout la visibilite courante de toutes les references avant de restituer un identifiant ou un instantane. Un brouillon contenant une reference devenue invisible est exclu d'une liste et renvoie le meme `BUDGET_REFERENCE_NOT_FOUND` generique en lecture directe ; aucune reponse partielle ne revele la reference retiree.
- Les `referenceSnapshots` restent conserves pour l'audit de la version mais ne sont jamais restitues par les routes metier lorsque la visibilite courante est perdue. Un futur acces d'audit restreint appartient a un lot separe.
- Une promotion V1 vers V2 est une commande distincte et idempotente, jamais un effet d'une simple lecture.
- La promotion exige les references organisation et exercice resolues et produit un rapport `apparie`, `ambigu`, `introuvable` ou `incompatible`.
- En cas d'echec, le brouillon V1 reste intact et demeure l'unique version faisant autorite.

La commande candidate `POST /api/finance/budget-drafts-v2/promotions/:sourceDraftId` exige un en-tete `Idempotency-Key` borne. Le serveur derive un identifiant UUID stable du tenant, de l'auteur, du brouillon V1 source, de sa version et de son empreinte. Cet identifiant utilise une derivation cryptographique canonique dont les bits de version et de variante sont forces au format UUID V4 afin de rester accepte par le `ID_PATTERN` du routeur V1 partage ; il ne pretend pas etre un UUID V4 aleatoire. Le serveur persiste ensuite dans l'enveloppe V2 :

```json
{
  "promotion": {
    "sourceContractVersion": 1,
    "sourceDraftId": "uuid-v4-source",
    "sourceVersion": 3,
    "sourceContentDigest": "sha256-canonique",
    "sourceLegacyYear": "2027",
    "idempotencyKeyHash": "empreinte-bornee",
    "promotedAt": "horodatage-serveur"
  }
}
```

Le brouillon V1 source, son `version`, le tenant et l'auteur sont relus par le serveur. Le serveur calcule aussi une empreinte SHA-256 du JSON V1 canonique et persiste `sourceVersion` et `sourceContentDigest` dans `promotion`. L'identifiant V2 deterministe derive du tenant, de l'auteur, du brouillon source, de sa version et de cette empreinte, puis est encode dans la forme UUID V4 acceptee par le validateur partage. La specification de derivation, son vecteur de test et le controle de collision appartiennent au micro-lot `T1-E` avant toute implementation.

La creation V2 utilise un `MERGE` transactionnel sur cet identifiant. Une reprise avec la meme origine exacte et la meme empreinte de cle renvoie le resultat existant ; une autre cle pour la meme origine produit un conflit ; une reponse incertaine se reconcilie par lecture de cet identifiant. Une version V1 ulterieure constitue une nouvelle origine et peut produire un autre brouillon V2, toujours au statut `draft` et sans autorite implicite. La cle brute et le contenu source ne sont jamais journalises.

La promotion des douze positions V1 est autorisee automatiquement uniquement vers un exercice civil janvier-decembre confirme, en reliant chaque position a son `periodId` canonique. Pour tout autre calendrier, le rapport retourne `incompatible` et aucun montant n'est deplace ou reordonne sans arbitrage explicite.

## Codes d'erreur candidats

| Code | Sens |
| --- | --- |
| `BUDGET_V2_DISABLED` | Contrat T1 non ouvert dans l'environnement |
| `BUDGET_REFERENCE_UNAVAILABLE` | Source de referentiel indisponible |
| `BUDGET_REFERENCE_NOT_FOUND` | Identifiant absent, non recevable, non visible ou hors tenant ; aucun detail public |
| `BUDGET_REFERENCE_RELATION_INVALID` | Chaine parentale incoherente |
| `BUDGET_FISCAL_YEAR_INVALID` | Exercice absent, ferme, chevauchant ou incompatible |
| `BUDGET_RESPONSIBILITY_INVALID` | Agent ou equipe non coherent |
| `BUDGET_V1_PROMOTION_REQUIRED` | Operation V2 demandee sur un brouillon V1 |
| `BUDGET_PROMOTION_CONFLICT` | Origine deja promue sous une autre cle idempotente |

Les messages publics restent generiques et sans identifiant sensible. Les journaux techniques ne contiennent ni montant, charge JSON, libelle prive ou jeton.

## Ordre d'implementation futur

| Lot | Contenu | Preuve de sortie |
| --- | --- | --- |
| `T1-A` | Contrats purs des objets V2 et validateurs sans route | Tests de forme, identifiants de ligne uniques, periodes explicites, absence/zero et champs inconnus |
| `T1-B` | Interfaces de resolution et doubles fictifs | Tests tenant, statut, confidentialite, revisions, indisponibilite et relations |
| `T1-C` | Lecture V2 et liste versionnee | V1 inchange, V2 sans conversion implicite, visibilite courante recontrolee |
| `T1-D` | Creation/mise a jour V2 derriere capacite fermee | Concurrence, droits relus et refus des references invalides |
| `T1-E` | Promotion explicite V1 vers V2 | Version et empreinte source, UUID V2 deterministe compatible avec le validateur partage, idempotence, reconciliation et rollback |

Chaque lot possede sa revue, ses tests et sa decision separee. La capacite V2 reste fermee jusqu'a un GO distinct des controles d'infrastructure et de production.

## Criteres de recette candidate

1. Les tests V1 actuels restent inchanges et reussissent.
2. Une charge V2 sur V1 et une charge V1 sur V2 sont refusees sans perte.
3. Tenant, auteur et droits fournis par le client sont ignores ou refuses.
4. Une organisation ou un exercice non resolu bloque la creation V2.
5. Les relations portefeuille, dossier, projet et phase incoherentes sont refusees.
6. Une reference restreinte non visible est refusee sans reveler son existence.
7. Une equipe et l'agent de la meme ligne incompatibles sont refuses ; le collectif reste limite a son equipe.
8. Deux lignes ne peuvent jamais partager le meme `row.id`.
9. Chaque ligne contient exactement les `periodId` de l'exercice resolu ; l'ordre du tableau ne change pas leur sens.
10. Chaque reference resolue persiste sa revision et son libelle canonique dans l'instantane de la version courante, sans pretendre conserver l'historique anterieur.
11. Une revocation apres sauvegarde exclut le brouillon des listes et bloque lecture, export et mise a jour sans fuite.
12. L'annee de synthese vient du referentiel d'exercice ; une annee V1 divergente bloque la promotion.
13. Une source indisponible produit un refus ferme, sans secours par libelle.
14. Vide, zero reel et invalide restent trois etats distincts.
15. Un conflit de version reste `409` sans ecrasement.
16. Un calendrier accepte est mensuel et contient exactement douze periodes valides couvrant l'exercice ; toute autre periodicite est refusee comme incompatible.
17. Deux reprises de la meme version V1 retournent le meme UUID V2 au format accepte par le validateur partage ; une version V1 ulterieure produit un autre brouillon V2 non autoritaire.
18. Aucun montant, cle idempotente brute ni contenu de brouillon n'apparait dans les journaux techniques.

## Arbitrage groupe candidat

Confirmer ou amender `BUDGET-T1-TECH-001 V0.1` en une seule decision :

1. retenir des routes V1 et V2 distinctes, sans conversion implicite ;
2. maintenir le contrat V1 executable inchange ;
3. imposer organisation et exercice resolus avant toute creation V2 ;
4. utiliser des resoluteurs serveur tenant-scoped appliquant la confidentialite et persister leurs revisions dans la version courante, sans revendiquer d'historique avant stockage versionne ;
5. stocker d'abord l'enveloppe V2 dans le JSON existant, sans DDL implicite ;
6. maintenir responsabilites metier et permissions applicatives strictement separees ;
7. deriver l'entite et l'annee de synthese des referentiels resolus et recontroler leur visibilite a chaque restitution ;
8. promouvoir V1 vers V2 uniquement par commande explicite liee a la version et a l'empreinte source, avec identifiant V2 deterministe au format UUID V4 accepte par le validateur partage, cle idempotente hachee et reconciliation ;
9. executer T1 par cinq micro-lots `A` a `E`, chacun revu et autorise separement ;
10. garder approbation, partage, allocations multiples, centre de cout, financeur et Budget personnel fermes ;
11. maintenir toute recette preview et activation de production sous decisions distinctes.

## Sources

- `docs/FINANCE-BUDGET-T1-REFERENTIALS-ROLES.md`
- `docs/FINANCE-BUDGET-CURRENT-TARGET-MAPPING.md`
- `docs/FINANCE-BUDGET-DRAFTS.md`
- `financeBudgetDrafts.js`
- `financeAccess.js`
- `managementPortfolio.js`
- `teamAgentContract.js`
- `referentiels/managementPortfolioSeed.json`
- `referentiels/rh001MembersDirectory.json`
- `tests/financeBudgetDrafts.test.js`
