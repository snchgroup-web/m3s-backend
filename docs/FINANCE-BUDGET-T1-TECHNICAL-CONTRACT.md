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
    "entityLabelSnapshot": "2SG",
    "legacyYear": "2027",
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
        "months": ["0", "", "", "", "", "", "", "", "", "", "", ""],
        "dimensions": {
          "functionId": "administration",
          "teamId": null,
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

Cet exemple illustre la forme, pas des valeurs autorisees. `ORG-2SG`, `FY-2SG-2027` et les autres identifiants ne deviennent recevables qu'apres resolution dans leurs referentiels actifs du tenant courant.

Le futur `budgetCode` reste absent de la charge cliente tant que son format, son autorite d'emission et son unicite ne sont pas confirmes. Il devra etre produit par le serveur, jamais derive du titre.

## Contrat des references

Chaque reference soumise est resolue par un composant serveur injecte. Un resultat de resolution possede au minimum :

```text
id, tenantId, status, labelSnapshot, sourceRevision
```

Le resultat est recevable seulement si :

1. l'identifiant est exact et unique ;
2. le tenant correspond a l'identite authentifiee ;
3. le statut autorise l'usage budgetaire a la date de la requete ;
4. la revision source est disponible pour l'audit ;
5. les relations parent-enfant sont coherentes.

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

## Responsabilites

- `authorUserId` reste derive de la session et protege par les droits Finance courants.
- `budgetOwnerAgentId` designe le responsable metier du brouillon ; il ne recoit aucun droit par ce rattachement.
- `controllerAgentId` est nullable et purement descriptif dans T1 ; il n'ouvre ni lecture ni ecriture.
- l'approbateur et le lecteur partage restent absents du contrat T1 ; ils appartiennent a T2.
- la coherence equipe-agent utilise RH-001 et autorise le collectif de la meme equipe, sans transformer le collectif en compte utilisateur.

Aucun utilisateur ne peut s'auto-attribuer une permission par une responsabilite metier. Les permissions sont relues depuis le compte actif a chaque requete, selon le comportement courant.

## Controles de cardinalite

1. Un budget V2 possede exactement une organisation et un exercice.
2. Une ligne possede au plus une valeur par dimension T1.
3. Un dossier exige son portefeuille parent.
4. Un projet exige son dossier parent ; une phase exige son projet parent.
5. Une equipe et un agent fournis ensemble doivent etre coherents.
6. Toutes les references appartiennent au tenant courant.
7. Une reference inactive ou indisponible est refusee.
8. Une valeur absente reste `null` ou absente ; elle ne devient pas zero ni une reference par defaut.

## Persistance candidate sans DDL implicite

Le premier lot executable T1 devrait conserver les tables V1 et stocker l'enveloppe V2 versionnee dans `budget_json`, sans ajouter de colonne par anticipation. Les colonnes de resume actuelles resteraient des instantanes compatibles :

- `title` depuis `budget.title` ;
- `entity` depuis `budget.entityLabelSnapshot` ;
- `year` depuis `budget.legacyYear` ;
- `tenant_id` et `owner_user_id` derives du serveur.

Le discriminateur reste interne a `budget_json` : un document V1 ne possede pas `contractVersion`; un document V2 porte exactement `contractVersion: 2`. Les requetes V1 devront filtrer `JSON_VALUE(budget_json, '$.contractVersion') IS NULL`, et les requetes V2 `JSON_VALUE(budget_json, '$.contractVersion') = '2'`, pour les listes, lectures et mises a jour. Un identifiant de l'autre contrat est traite comme introuvable dans la portee demandee et n'est jamais parse par le mauvais validateur.

Cette strategie n'est acceptable que si les limites de taille, le cout des filtres JSON et les usages de liste restent suffisants. Toute normalisation, nouvel index, table ou colonne constitue un lot DDL separe, reversible et explicitement autorise.

## Lecture et compatibilite

- Les routes V1 continuent de lire et ecrire les brouillons V1 sans modification.
- Les routes V2 lisent seulement les brouillons marques `contractVersion: 2`.
- Les listes V1 et V2 restent distinctes ; une vue commune eventuelle appartient a un lot ulterieur.
- Une promotion V1 vers V2 est une commande distincte et idempotente, jamais un effet d'une simple lecture.
- La promotion exige les references organisation et exercice resolues et produit un rapport `apparie`, `ambigu`, `introuvable` ou `incompatible`.
- En cas d'echec, le brouillon V1 reste intact et demeure l'unique version faisant autorite.

## Codes d'erreur candidats

| Code | Sens |
| --- | --- |
| `BUDGET_V2_DISABLED` | Contrat T1 non ouvert dans l'environnement |
| `BUDGET_REFERENCE_UNAVAILABLE` | Source de referentiel indisponible |
| `BUDGET_REFERENCE_NOT_FOUND` | Identifiant absent ou non recevable |
| `BUDGET_REFERENCE_TENANT_MISMATCH` | Reference hors tenant |
| `BUDGET_REFERENCE_RELATION_INVALID` | Chaine parentale incoherente |
| `BUDGET_FISCAL_YEAR_INVALID` | Exercice absent, ferme, chevauchant ou incompatible |
| `BUDGET_RESPONSIBILITY_INVALID` | Agent ou equipe non coherent |
| `BUDGET_V1_PROMOTION_REQUIRED` | Operation V2 demandee sur un brouillon V1 |

Les messages publics restent generiques et sans identifiant sensible. Les journaux techniques ne contiennent ni montant, charge JSON, libelle prive ou jeton.

## Ordre d'implementation futur

| Lot | Contenu | Preuve de sortie |
| --- | --- | --- |
| `T1-A` | Contrats purs des objets V2 et validateurs sans route | Tests unitaires de forme, absence/zero et refus des champs inconnus |
| `T1-B` | Interfaces de resolution et doubles fictifs | Tests tenant, statut, indisponibilite et relations |
| `T1-C` | Lecture V2 et liste versionnee | V1 inchange, V2 sans conversion implicite |
| `T1-D` | Creation/mise a jour V2 derriere capacite fermee | Concurrence, droits relus et refus des references invalides |
| `T1-E` | Promotion explicite V1 vers V2 | Idempotence, rapport de rapprochement et rollback |

Chaque lot possede sa revue, ses tests et sa decision separee. La capacite V2 reste fermee jusqu'a un GO distinct des controles d'infrastructure et de production.

## Criteres de recette candidate

1. Les tests V1 actuels restent inchanges et reussissent.
2. Une charge V2 sur V1 et une charge V1 sur V2 sont refusees sans perte.
3. Tenant, auteur et droits fournis par le client sont ignores ou refuses.
4. Une organisation ou un exercice non resolu bloque la creation V2.
5. Les relations portefeuille, dossier, projet et phase incoherentes sont refusees.
6. Une equipe et un agent incompatibles sont refuses ; le collectif reste limite a son equipe.
7. Une source indisponible produit un refus ferme, sans secours par libelle.
8. Vide, zero reel et invalide restent trois etats distincts.
9. Un conflit de version reste `409` sans ecrasement.
10. Aucun montant ni contenu de brouillon n'apparait dans les journaux techniques.

## Arbitrage groupe candidat

Confirmer ou amender `BUDGET-T1-TECH-001 V0.1` en une seule decision :

1. retenir des routes V1 et V2 distinctes, sans conversion implicite ;
2. maintenir le contrat V1 executable inchange ;
3. imposer organisation et exercice resolus avant toute creation V2 ;
4. utiliser des resoluteurs serveur tenant-scoped pour toutes les references ;
5. stocker d'abord l'enveloppe V2 dans le JSON existant, sans DDL implicite ;
6. maintenir responsabilites metier et permissions applicatives strictement separees ;
7. promouvoir V1 vers V2 uniquement par commande explicite, idempotente et reversible ;
8. executer T1 par cinq micro-lots `A` a `E`, chacun revu et autorise separement ;
9. garder approbation, partage, allocations multiples, centre de cout, financeur et Budget personnel fermes ;
10. maintenir toute recette preview et activation de production sous decisions distinctes.

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
