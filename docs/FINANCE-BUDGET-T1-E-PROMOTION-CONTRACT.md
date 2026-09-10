# BUDGET-T1-E-001 V0.1 - cadrage de la promotion explicite V1 vers V2

Date de preparation : 10-09-2026.

Statut : contrat candidat a confirmer ou amender apres le verdict E4. Il ne convertit aucun brouillon, n'ajoute aucun code, route, table, index, droit, secret ou acces et ne modifie pas V1. T1-E reste ferme tant que la recette E4 n'a pas produit un verdict technique recevable.

## Finalite

Permettre au proprietaire d'un brouillon Budget V1 de demander explicitement sa promotion vers un nouveau brouillon V2, avec :

- source V1 intacte et toujours lisible par V1 ;
- cible V2 au statut `draft`, privee au tenant et a l'auteur ;
- correspondances organisation, exercice et responsable verifiees ;
- rapport ferme et nettoye avant toute ecriture ;
- identifiant V2 deterministe et reprise idempotente ;
- liaison atomique entre cle, intention, demande et resultat ;
- resultat incertain jamais transforme en succes ni relance automatiquement.

Une lecture V1 ou V2 ne declenche jamais une promotion.

## Conditions d'ouverture

T1-E ne peut commencer que si toutes les conditions suivantes sont prouvees :

1. verdict E4 `GO technique candidat`, ou `GO sous reserves` dont chaque reserve bloquante est levee ;
2. contrats et implementations T1-A, T1-B, T1-C et T1-D fusionnes et leurs suites vertes ;
3. stockage V2 capable de garantir transaction, unicite, compare-and-swap, audit et reconciliation ;
4. V1 inchange et physiquement distingue de V2 ;
5. sources organisation, exercice et RH disponibles par les interfaces T1-B ;
6. autorisation humaine separee pour chaque micro-lot T1-E.

Un verdict E4 `NO-GO` ou `INDETERMINE` maintient tous les micro-lots T1-E fermes.

## Commande candidate

La future commande reste distincte des lectures et ecritures directes V2 :

```text
POST /api/finance/budget-drafts-v2/promotions/:sourceDraftId
Idempotency-Key: valeur opaque de 16 a 128 caracteres ASCII
```

```json
{
  "expectedSourceVersion": 3,
  "target": {
    "entityId": "ORG-2SG",
    "fiscalYearId": "FY-2SG-2027",
    "budgetOwnerAgentId": "agent-id"
  }
}
```

Le corps est ferme. Tenant, auteur, droits, date, identifiant V2, empreintes, rapport, instantanes et metadonnees de promotion viennent uniquement du serveur.

## Derivations pures obligatoires

T1-E doit specifier et tester avant toute persistance :

1. `idempotencyKeyHash`, derive de la cle brute, du tenant et de l'auteur avec le domaine normatif deja confirme ;
2. `intentFingerprint`, couvrant source, version attendue et trois references cibles ;
3. `requestFingerprint`, couvrant la demande canonique complete et les valeurs resolues ;
4. `sourceContentDigest`, empreinte SHA-256 du JSON V1 canonique lu a la version attendue ;
5. identifiant V2 deterministe, encode dans une forme UUID acceptee par le validateur partage sans pretendre etre aleatoire.

Chaque derivation possede une serialisation canonique, des separateurs non ambigus, des vecteurs de test publics et des tests de collision. La cle brute, le document V1 et les valeurs privees ne sont jamais journalises.

## Parcours de premiere utilisation

1. valider la syntaxe, l'authentification, la capacite V2 et les permissions courantes ;
2. verifier la disponibilite du stockage et rechercher la liaison par empreinte de cle ;
3. charger le brouillon V1 dans la portee tenant-auteur sans reveler une autre portee ;
4. comparer exactement `expectedSourceVersion` a la version V1 courante ;
5. resoudre les trois references cibles et produire le rapport nettoye ;
6. refuser sans ecriture si un controle n'est pas `apparie` ;
7. transformer les douze positions uniquement vers un exercice civil janvier-decembre confirme ;
8. construire et valider l'enveloppe V2 complete avec dimensions de lignes initialisees a `null` ;
9. persister dans une seule transaction le brouillon V2, l'audit minimal et la liaison de promotion ;
10. retourner le resume V2 et le rapport seulement si le commit est prouve.

V1 n'est jamais modifie, verrouille, renomme, supprime ou marque comme migre.

## Reprise et conflits

- Meme cle et meme intention : retrouver la liaison, relire la version V2 courante et appliquer la validation complete T1-C avant restitution.
- Meme cle et autre intention : `BUDGET_PROMOTION_CONFLICT`, sans lecture du contenu V1 ni ecriture.
- Autre cle pour une intention ou une demande deja liee : `BUDGET_PROMOTION_CONFLICT`.
- Premiere cle avec version V1 devenue obsolete : `BUDGET_SOURCE_VERSION_CONFLICT`.
- Resultat de commit incertain : `BUDGET_WRITE_UNCERTAIN`, puis reconciliation par liaison et identifiant deterministe, sans nouvelle tentative automatique.
- Liaison absente, multiple, divergente ou indisponible : echec ferme, sans resultat partiel.

Une reprise reussie retourne la version V2 courante, pas une copie historique reconstruite depuis V1.

## Rapport de correspondance

Le rapport ferme contient seulement `{ outcome, checks }`. Les resultats admis sont `apparie`, `ambigu`, `introuvable` et `incompatible`, avec la precedence deja definie par le contrat T1.

Les chemins restent limites a :

- `identity.entityId` ;
- `identity.fiscalYearId` ;
- `responsibilities.budgetOwnerAgentId` ;
- `budget.year` ;
- `budget.rate` ;
- `rows[<ordinal>].periodValues` dans l'ordre V1.

Le rapport ne contient aucune valeur source, candidat, identifiant cache, libelle prive ou contenu financier. Un resultat autre que `apparie` retourne `BUDGET_PROMOTION_REVIEW_REQUIRED` et ne cree ni cible V2 ni liaison.

## Invariants de la cible V2

- `contractVersion: 2`, version serveur `1`, statut `draft`, acces `owner-only` et portee organisation ;
- identite et responsabilite issues des references resolues, jamais du libelle V1 ou de l'auteur technique ;
- `controllerAgentId: null` a la promotion ;
- titre, lignes, sens, devises et valeurs compatibles recopies sans trim ni normalisation silencieuse ;
- douze valeurs mensuelles reliees aux douze `periodId` canoniques ;
- huit dimensions de chaque ligne initialisees exactement a `null` ;
- instantanes de references complets et horodates au meme instant serveur ;
- bloc `promotion` serveur immuable, interdit dans toute charge cliente ;
- mise a jour V2 ulterieure preservant ce bloc sans modification ;
- lien bidirectionnel unique entre bloc de promotion et liaison persistante.

## Persistance candidate, sans DDL implicite

La liaison devra garantir atomiquement, dans la portee tenant-auteur :

- une seule intention par `idempotencyKeyHash` ;
- une seule cle par `intentFingerprint` ;
- une seule cle par `requestFingerprint` ;
- une seule cible V2 par liaison ;
- brouillon V2, audit et liaison commits ensemble ou pas du tout ;
- lecture fermee par cle, intention, demande et identifiant V2 ;
- aucune suppression automatique de la provenance.

Le schema exact, les contraintes et la migration appartiennent a un micro-lot separe. Aucun DDL ne peut etre deduit de ce cadrage.

## Decoupage Fast Track candidat

| Lot | Contenu | Effets interdits |
| --- | --- | --- |
| `T1-E-A` | validateurs purs, rapport, canonicalisation, empreintes, UUID deterministe et conversion en memoire | stockage, route, environnement, secret |
| `T1-E-B` | service de promotion sur interfaces et doubles fictifs, idempotence, concurrence, reconciliation et rollback | SQL reel, DDL, route, acces cloud |
| `T1-E-C` | contrat de liaison persistante, plan DDL hors ligne, adaptateur et recette ephemere separee | migration implicite, production, donnee reelle |
| `T1-E-D` | integration finale aux lectures/ecritures V2 puis route HTTP fermee par capacite | activation, preview, frontend, Budget personnel |

Chaque lot exige sa propre confirmation, sa PR, sa revue et son verdict. La fusion d'un lot n'autorise pas le suivant.

## Recette candidate groupee

Les futurs tests devront couvrir au minimum :

1. V1 strictement inchange avant, pendant et apres tout resultat ;
2. grammaire fermee de la commande et de `Idempotency-Key` ;
3. vecteurs deterministes des quatre empreintes et de l'identifiant V2 ;
4. rapport ferme, ordre normatif, precedence et absence de valeur privee ;
5. calendrier non civil, annee divergente, espaces et valeurs incompatibles refuses sans normalisation ;
6. references absentes, ambigues, invisibles, invalides ou indisponibles classees sans fuite ;
7. premiere promotion reussie avec une cible, un audit et une liaison atomiques ;
8. reprise meme cle et meme intention sans relecture du contenu V1 mutable ;
9. conflits reciproques cle-intention-demande sans ecriture ;
10. version V1 obsolete sans cible ni liaison ;
11. deux promotions concurrentes produisant une seule cible ;
12. echec certain et commit incertain sans ecriture partielle ni nouvelle tentative ;
13. bloc `promotion` preserve par une mise a jour V2 et jamais accepte du client ;
14. lecture et liste V2 controlant la coherence bidirectionnelle bloc-liaison ;
15. portee tenant-auteur et permissions courantes recontrolees ;
16. recherche statique prouvant l'absence de route, cloud, environnement et SQL dans les lots purs ;
17. regression complete des suites V1 et T1-A a T1-D ;
18. `git diff --check`, ASCII, worktree et PR propres.

## Arbitrage groupe candidat

Confirmer ou amender `BUDGET-T1-E-001 V0.1` en une decision unique :

1. conserver la promotion explicite, jamais declenchee par une lecture ;
2. maintenir V1 intact et faisant autorite si la promotion echoue ;
3. exiger les trois references cibles et une version V1 attendue ;
4. valider le rapport complet avant toute ecriture ;
5. fixer les derivations canoniques et leurs vecteurs avant la persistance ;
6. imposer l'unicite reciproque cle, intention, demande et cible ;
7. creer cible, audit et liaison dans une transaction unique ;
8. reconciler l'incertain sans nouvelle tentative automatique ;
9. preserver le bloc de promotion dans toute mise a jour V2 ;
10. ordonner `T1-E-A`, `T1-E-B`, `T1-E-C`, puis `T1-E-D` ;
11. maintenir chaque lot ferme jusqu'a sa decision separee ;
12. maintenir fermes production, donnee reelle, route, IAM M3S, preview, frontend, Budget personnel et activation Budget.

La confirmation de ce contrat n'autorisera aucune implementation. Le premier micro-lot `T1-E-A` ne pourra etre ouvert qu'apres un verdict E4 recevable et une autorisation distincte.

## Sources internes

- `docs/FINANCE-BUDGET-T1-TECHNICAL-CONTRACT.md`
- `docs/FINANCE-BUDGET-T1-C-READ-CONTRACT.md`
- `docs/FINANCE-BUDGET-T1-D-WRITE-CONTRACT.md`
- `docs/FINANCE-BUDGET-T1-D-B-STORAGE-CONTRACT.md`
- `docs/FINANCE-BUDGET-T1-D-B-3-B-E4-EXECUTION-FRAMING.md`
- `docs/FINANCE-BUDGET-T1-D-B-3-B-E4-OPERATOR-KIT.md`
- `financeBudgetV2Contracts.js`
- `financeBudgetV2References.js`
- `financeBudgetV2Reads.js`
- `financeBudgetV2Writes.js`
- `financeBudgetV2StorageAdapter.js`
