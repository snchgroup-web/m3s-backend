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

Le schema V2 est ferme : tout champ inconnu est refuse a chaque niveau. `budget.title` est une chaine non vide apres trim, bornee a 120 caracteres ; `budget.rows` est un tableau de 100 lignes maximum ; `row.id` et `row.label` sont des chaines non vides bornees respectivement a 64 et 120 caracteres. Les enumerations V1 sont conservees dans T1 : `kind` vaut uniquement `operating`, `investment` ou `financing` ; `direction` vaut uniquement `in` ou `out` ; `currency` vaut uniquement `CHF` ou `CFA`. L'enveloppe JSON serialisee reste bornee a 512 Kio. Une creation porte seulement `contractVersion` et `budget` ; une mise a jour ajoute `expectedVersion`, entier de 1 a `999999`, pour la comparaison atomique, sans placer ce compteur dans le contenu metier. La version stockee `1000000` est terminale et reste lisible ; toute nouvelle mise a jour est refusee par `BUDGET_VERSION_LIMIT` avant calcul d'un compteur hors borne.

Chaque `periodValues[].value` est une chaine de 24 caracteres maximum. Elle vaut soit `""` pour une absence explicite, soit un decimal positif ou nul en notation simple, avec point ou virgule comme separateur decimal, sans signe, separateur de milliers ni exposant, avec au plus deux decimales et une valeur maximale de `1000000000`. La chaine valide est conservee telle quelle ; une normalisation point/virgule n'est admise que transitoirement pour le calcul et ne reecrit pas la valeur source. Les nombres JSON, valeurs negatives, espaces, `NaN`, infinis et precisions superieures sont refuses. Cette grammaire reprend les bornes V1 tant qu'un contrat monetaire ulterieur n'est pas confirme.

Le triplet `rate`, `rateSource`, `rateDate` conserve aussi le contrat V1. Les trois champs sont des chaines ; ils sont soit tous exactement `""`, soit tous renseignes sans espace exterieur. Un taux renseigne est borne a 24 caracteres, utilise une notation decimale simple positive, avec point ou virgule, au plus six decimales et une valeur maximale de `1000000` ; sa source non vide est bornee a 200 caracteres et sa date est une date civile ISO `YYYY-MM-DD` valide. Aucun taux nul, negatif, en notation exponentielle, sans source ou sans date n'est accepte.

Le futur `budgetCode` reste absent de la charge cliente tant que son format, son autorite d'emission et son unicite ne sont pas confirmes. Il devra etre produit par le serveur, jamais derive du titre.

## Contrat des references

Chaque reference soumise est resolue par un composant serveur injecte. Un resultat de resolution possede au minimum :

```text
id, tenantId, status, effectiveFrom, effectiveTo, labelSnapshot, sourceRevision
```

Le resultat du resolveur d'exercice fournit en plus son `entityId` parent. Il n'est recevable que si cet identifiant est strictement egal a l'`entityId` d'organisation resolu pour le budget ; deux references valides du meme tenant mais appartenant a des organisations differentes constituent `BUDGET_REFERENCE_RELATION_INVALID`.

Le resultat du resolveur de portefeuille fournit aussi son `functionId` canonique. Lorsqu'une ligne porte un `portfolioId`, son `functionId` devient obligatoire et doit etre strictement egal a celui du portefeuille resolu. Le serveur refuse toute contradiction ; il ne conserve pas deux classifications divergentes et ne remplace pas silencieusement la fonction fournie.

Le resolveur de dossier fournit son `portfolioId` canonique ; un futur resolveur de projet fournit son `dossierId` et celui de phase son `projectId`. Chaque identifiant enfant est compare au parent soumis et resolu. L'absence du champ parent canonique dans une source rend cette relation indisponible et bloque la reference ; deux identifiants individuellement valides ne suffisent jamais.

Le serveur persiste ensuite `referenceSnapshots` a la racine de l'enveloppe V2 stockee, a cote de `contractVersion`, `budget` et de l'eventuel bloc `promotion`. Ce champ est interdit dans les charges clientes et suit le schema ferme suivant ; `ref` designe exactement `{ "id", "labelSnapshot", "statusSnapshot", "effectiveFrom", "effectiveTo", "sourceRevision", "resolvedAt" }`, sans autre champ, avec `effectiveTo: null` lorsqu'il n'existe pas :

```text
referenceSnapshots
├── identity
│   ├── entityId: ref
│   └── fiscalYearId: ref + entityId + summaryYear + startDate + endDate
│       + periodicity + timezone + periods[{periodId, ordinal, startDate, endDate}]
├── responsibilities
│   ├── budgetOwnerAgentId: ref + teamId
│   └── controllerAgentId: null | ref + teamId
└── rows[]
    ├── rowId: valeur exacte de budget.rows[].id
    └── dimensions
        ├── functionId: null | ref
        ├── teamId: null | ref
        ├── agentId: null | ref + teamId
        ├── countryId: null | ref
        ├── portfolioId: null | ref + functionId
        ├── dossierId: null | ref + portfolioId
        ├── projectId: null | ref + dossierId
        └── phaseId: null | ref + projectId
```

`identity` et `responsibilities` possedent exactement les cles affichees. `rows` contient exactement une entree par ligne budgetaire, sans doublon ni entree orpheline ; la correspondance se fait par `rowId`, jamais par position. Chaque objet `dimensions` contient exactement les huit cles, avec `null` pour une dimension absente. Tous les champs supplementaires par type ci-dessus sont serveur, canoniques et inclus dans l'instantane. A chaque creation, promotion ou mise a jour V2, le serveur re-resout toutes les references et remplace atomiquement le bloc complet avec la version de `budget` correspondante ; il ne fusionne jamais un ancien instantane avec une nouvelle ligne.

Les identifiants, revisions source et statuts sont des chaines ASCII non vides de 128 caracteres maximum ; les libelles UTF-8 sont bornes a 200 caracteres. `effectiveFrom`, `effectiveTo` et `resolvedAt` sont des horodatages RFC 3339 UTC, sauf `effectiveTo: null`. Les dates d'exercice et de periode sont ISO `YYYY-MM-DD`, `summaryYear` porte exactement quatre chiffres, `periodicity` vaut `monthly`, `timezone` est un identifiant IANA borne a 64 caracteres et `ordinal` est un entier unique de `1` a `12`. Chaque identifiant parent suit la meme grammaire que `id` et doit correspondre au parent resolu du budget.

Avec les tables V1 inchangees, une mise a jour remplace `budget_json` et ne conserve donc pas les instantanes des versions precedentes. T1 ne revendique aucun historique probatoire des revisions. Un historique immuable exige un stockage versionne distinct, relevant d'un futur lot DDL et d'audit explicitement autorise. Le journal d'evenements courant conserve uniquement l'action et le numero de version.

Le resultat est recevable seulement si :

1. l'identifiant est exact et unique ;
2. le tenant correspond a l'identite authentifiee ;
3. le statut et sa periode d'effet autorisent l'operation budgetaire a l'instant serveur de la requete ;
4. la politique de confidentialite et de visibilite propre a l'objet autorise cet utilisateur a le referencer et a revoir son libelle ;
5. la revision source est disponible pour l'audit ;
6. les relations parent-enfant sont coherentes.

Le serveur capture un seul instant UTC pour la requete. Chaque resolveur normalise une periode d'effet semi-ouverte `[effectiveFrom, effectiveTo)` ; `effectiveTo` peut etre nul pour une reference non expirante. Une revision future, expiree ou sans datation verifiable est refusee. Un registre sans dates natives doit fournir une regle d'activation versionnee et auditable dans son contrat de resolveur avant ouverture ; aucune date n'est deduite d'un libelle ou de la saisie cliente.

Les statuts canoniques recevables sont lies a l'operation :

| Reference | Creation, mise a jour ou promotion | Liste, lecture ou export d'un brouillon existant |
| --- | --- | --- |
| Organisation | `active` dans sa periode d'effet | `active`; un statut `inactive`, `suspended`, `revoked` ou `deleted` bloque aussi la restitution |
| Exercice | `planned` seulement avant `startDate`; `open` entre `startDate` et `endDate` incluses, dans le fuseau de l'exercice | `planned`, `open` ou `closed`, si l'exercice reste visible ; `cancelled` ou `deleted` bloque la restitution |
| Fonction, equipe, agent, portefeuille, dossier et pays | `active` dans leur periode d'effet | `active`, ou `archived` si la politique de conservation maintient explicitement la visibilite historique ; `inactive`, `revoked` ou `deleted` bloque la restitution |
| Projet et phase, lorsqu'un registre sera autorise | `planned`, `active` ou `open` dans leur periode d'effet | ces statuts, ainsi que `completed` ou `closed` si la visibilite historique est maintenue ; `cancelled`, `revoked` ou `deleted` bloque la restitution |

Tout statut natif doit etre mappe explicitement vers cette enumeration dans le contrat du resolveur. Un statut inconnu, un mapping absent ou une periode d'effet non prouvable ferme l'operation. Le statut `restricted` reste un niveau de confidentialite, jamais un statut de cycle de vie, et continue d'exiger sa politique Management propre.

Une permission Finance et l'appartenance au tenant ne suffisent pas a ouvrir un objet `restricted`. Le resolveur applique aussi la confidentialite de chaque portefeuille, dossier ou future reference ; il renvoie le meme refus generique pour un objet absent et un objet non visible afin de ne pas reveler son existence. Dans T1, toute reference Management marquee `restricted` reste bloquee par `BUDGET_REFERENCE_NOT_FOUND` tant qu'un contrat d'autorisation Management actif ne relie pas explicitement l'identite courante a cet objet. `responsible_agent_id` seul, surtout nul, n'accorde aucun acces et aucune permission Finance ne lui est substituee.

RH-001 ne porte actuellement aucun `tenantId` autoritatif. Il peut documenter les libelles et la coherence equipe-agent dans le contexte 2SG, mais ne peut pas prouver seul l'appartenance d'un agent au tenant authentifie. Toute reference d'agent V2, y compris `budgetOwnerAgentId` obligatoire et `controllerAgentId`, reste donc `BLOQUANTE` jusqu'a l'activation d'un mapping agent-tenant explicite, versionne et tenant-scoped. Aucun tenant implicite n'est invente et aucun annuaire inter-tenant n'est ouvert.

Une indisponibilite de source, une ambiguite ou une reference inconnue produit un refus ferme. Aucun libelle, alias, devise, texte `Autre` ou valeur historique ne remplace un identifiant.

## Matrice d'ouverture technique

| Reference | Source candidate | Etat T1 | Effet sur une future ecriture V2 |
| --- | --- | --- | --- |
| Organisation | registre a confirmer | `BLOQUANT` | Refus tant que le registre actif n'existe pas |
| Exercice | registre a creer ou confirmer | `BLOQUANT` | Refus tant que bornes, periodicite et fuseau ne sont pas resolus |
| Fonction | menus canoniques / portefeuille | `TRANSITION` | Lecture candidate seulement apres contrat unique |
| Equipe et agent | RH-001 / `teamAgentContract` | `BLOQUANT` | Libelles et coherence observables, mais aucune reference V2 avant mapping agent-tenant autoritatif |
| Portefeuille et dossier | registres Management | `ACTIF BORNE` | Resolution tenant-scoped et chaine parentale obligatoire ; references `restricted` bloquees sans contrat d'autorisation Management |
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

1. Un budget V2 possede exactement une organisation et un exercice dont l'`entityId` parent correspond a cette organisation.
2. Chaque `row.id` est non vide et unique dans le budget.
3. Une ligne possede au plus une valeur par dimension T1 et exactement le jeu de periodes de l'exercice resolu.
4. Un portefeuille exige une fonction correspondante ; un dossier exige son portefeuille parent.
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

La commande candidate `POST /api/finance/budget-drafts-v2/promotions/:sourceDraftId` exige un en-tete `Idempotency-Key` et une charge limitee a la version source attendue et aux references cibles. La cle est sensible a la casse, contient de 16 a 128 caracteres ASCII parmi `[A-Za-z0-9._:-]`, n'est ni trimmee ni normalisee et est refusee si elle ne respecte pas exactement cette grammaire. Son empreinte est l'hexadecimal minuscule de `SHA-256(UTF8("m3s:budget:promotion:v1\\0" + tenantId + "\\0" + authorUserId + "\\0" + Idempotency-Key))`. La chaine de domaine, les separateurs NUL et les octets UTF-8 sont normatifs afin que toutes les instances calculent la meme valeur sans conserver la cle brute.

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

`expectedSourceVersion` est un entier compris entre `1` et `1000000`, borne terminale V1 incluse puisque la promotion ne modifie pas la source. Le serveur re-resout ces trois identifiants dans le tenant courant, verifie le responsable metier avec le contrat RH-001, refuse tout champ supplementaire et ne deduit jamais l'organisation du tenant, du libelle V1 ou de l'auteur technique. Le `controllerAgentId` du brouillon promu est initialise a `null` et peut etre renseigne seulement par une mise a jour V2 ulterieure valide. Le serveur derive ensuite un identifiant UUID stable du tenant, de l'auteur, du brouillon V1 source, de sa version, de son empreinte et des trois identifiants cibles canoniques. Cet identifiant utilise une derivation cryptographique canonique dont les bits de version et de variante sont forces au format UUID V4 afin de rester accepte par le `ID_PATTERN` du routeur V1 partage ; il ne pretend pas etre un UUID V4 aleatoire. Le serveur persiste ensuite dans l'enveloppe V2 :

```json
{
  "promotion": {
    "sourceContractVersion": 1,
    "sourceDraftId": "uuid-v4-source",
    "sourceVersion": 3,
    "sourceContentDigest": "sha256-canonique",
    "sourceExportRevision": 42,
    "sourceLegacyYear": "2027",
    "targetEntityId": "ORG-2SG",
    "targetFiscalYearId": "FY-2SG-2027",
    "targetBudgetOwnerAgentId": "agent-id",
    "intentFingerprint": "sha256-intention-stable",
    "requestFingerprint": "sha256-requete-canonique",
    "idempotencyKeyHash": "empreinte-bornee",
    "promotedAt": "horodatage-serveur"
  }
}
```

Apres validation de la grammaire de la cle et de la charge fermee, le serveur calcule d'abord un `intentFingerprint` stable couvrant le tenant, l'auteur, `sourceDraftId`, `expectedSourceVersion` et les trois identifiants cibles fournis. Il consulte ensuite la liaison par `idempotencyKeyHash` avant de relire le brouillon V1. Si la cle est deja liee a la meme intention, il ne relit pas le contenu mutable du V1 : il retrouve l'identifiant V2 persiste, charge sa version V2 courante, puis lui applique exactement la validation complete de lecture V2. Celle-ci re-resout l'organisation, l'exercice, toutes les responsabilites et toutes les dimensions de chaque ligne, y compris celles ajoutees ou modifiees apres la promotion, et recontrole leurs statuts, periodes d'effet, relations et visibilite courante avant toute restitution. Si ces controles reussissent, il restitue le resultat courant sous le meme identifiant V2, meme si la version V1 a change entre-temps ; sinon il applique le meme refus generique que la lecture V2, conserve la liaison et ne cree rien. Si la cle est liee a une autre intention, il retourne `BUDGET_PROMOTION_CONFLICT` sans lire ni creer de brouillon.

Lorsqu'aucune liaison n'existe encore pour `idempotencyKeyHash`, la cle est en premiere utilisation : le serveur relit le brouillon V1 source, son `version`, le tenant et l'auteur, puis resout et valide les references cibles. La promotion exige alors `version === expectedSourceVersion` ; sinon elle retourne `BUDGET_SOURCE_VERSION_CONFLICT` sans creation ni liaison. Le serveur calcule aussi une empreinte SHA-256 du JSON V1 canonique et persiste `sourceVersion`, `sourceContentDigest`, `sourceExportRevision`, `targetEntityId`, `targetFiscalYearId` et `targetBudgetOwnerAgentId` dans `promotion`. `sourceExportRevision` recopie exactement l'entier V1 `budget.revision`, compris entre `0` et `1000000` ; il reste une provenance historique immuable, n'est jamais confondu avec la version serveur V2 et n'est ni remis a zero ni reconstruit. Le contrat T1 ne cree pas de nouveau compteur d'export client V2 ; sa definition eventuelle appartient a un lot frontend distinct. L'empreinte canonique complete de la requete et l'identifiant V2 deterministe couvrent le tenant, l'auteur, le brouillon source, sa version, son empreinte et les trois identifiants cibles resolus, puis l'identifiant est encode dans la forme UUID V4 acceptee par le validateur partage. La specification des deux derivations, leurs vecteurs de test et le controle de collision appartiennent au micro-lot `T1-E` avant toute implementation.

Avant toute ecriture, le serveur lie atomiquement, dans la portee tenant-auteur, chaque `idempotencyKeyHash` a son premier `intentFingerprint`, a son `requestFingerprint` canonique complet et au resultat V2 persiste ; chaque intention et chaque empreinte complete de demande sont reciproquement liees a leur premiere empreinte de cle. Une reprise avec la meme cle et la meme intention retrouve ce resultat avant toute relecture du V1, puis applique les controles courants de restitution aux references persistees. La reutilisation d'une cle avec une autre source, version attendue ou cible, comme l'emploi d'une autre cle pour la meme intention ou la meme demande canonique deja creee, retourne `BUDGET_PROMOTION_CONFLICT` sans creer de brouillon.

La creation V2 utilise ensuite un `MERGE` transactionnel sur l'identifiant deterministe ; une reponse incertaine se reconcilie par la liaison precedente et par lecture de cet identifiant. Une relance avec la meme cle et la meme charge retrouve donc le resultat initial apres une mutation du V1. Une nouvelle cle portant une `expectedSourceVersion` devenue obsolete echoue avec `BUDGET_SOURCE_VERSION_CONFLICT`. Une version V1 ulterieure explicitement attendue ou une autre cible constitue une autre intention et peut produire un autre brouillon V2, toujours au statut `draft` et sans autorite implicite, mais elle exige sa propre cle encore inutilisee. La cle brute et le contenu source ne sont jamais journalises.

Cette liaison doit resister a deux requetes concurrentes et ne peut pas reposer sur un scan JSON suivi d'une insertion non protegee. Si `T1-E` ne peut pas prouver cette unicite bidirectionnelle avec le stockage autorise, il reste `NO-GO` jusqu'a la confirmation d'un micro-lot de persistance ou d'index distinct ; aucun DDL n'est deduit du present contrat.

Le bloc `promotion` est une metadonnee serveur immuable. Il est interdit dans toute charge cliente de creation ou de mise a jour V2. Lors d'une mise a jour d'un brouillon promu, le serveur relit ce bloc dans le document stocke, le recopie sans modification dans la nouvelle enveloppe `budget_json` au sein de la transaction de version et rejette toute tentative de surcharge. Un brouillon V2 cree directement ne possede pas ce bloc.

La promotion des douze positions V1 est autorisee automatiquement uniquement vers un exercice civil janvier-decembre confirme, en reliant chaque position a son `periodId` canonique. Chaque chaine V1 doit deja respecter la grammaire V2 exacte : `""` pour l'absence ou decimal sans espace exterieur. Une valeur V1 entierement composee d'espaces ou dont `value !== value.trim()` retourne `incompatible` dans le rapport ; elle n'est ni trimmee, ni convertie, ni persistee en V2. Le triplet V1 `rate`, `rateSource`, `rateDate` suit la meme exigence : les trois valeurs exactement vides sont conservees ; sinon chacune doit etre non vide, identique a son `trim()` et conforme a la grammaire V2. Un taux ou une source entoures d'espaces, ou un taux entierement compose d'espaces, rend la promotion `incompatible` sans normalisation silencieuse. Pour tout autre calendrier ou valeur incompatible, aucun montant n'est deplace ou reordonne sans arbitrage explicite.

## Codes d'erreur candidats

| Code | Sens |
| --- | --- |
| `BUDGET_V2_DISABLED` | Contrat T1 non ouvert dans l'environnement |
| `BUDGET_REFERENCE_UNAVAILABLE` | Source de referentiel indisponible |
| `BUDGET_REFERENCE_NOT_FOUND` | Identifiant absent, non recevable, non visible ou hors tenant ; aucun detail public |
| `BUDGET_REFERENCE_RELATION_INVALID` | Chaine parentale incoherente |
| `BUDGET_FISCAL_YEAR_INVALID` | Exercice absent, ferme, chevauchant ou incompatible |
| `BUDGET_RESPONSIBILITY_INVALID` | Agent ou equipe non coherent |
| `BUDGET_SOURCE_VERSION_CONFLICT` | Version V1 courante differente de `expectedSourceVersion` |
| `BUDGET_VERSION_LIMIT` | Version terminale atteinte ; aucune nouvelle mise a jour admise |
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
| `T1-E` | Promotion explicite V1 vers V2 | Version et empreinte source, UUID V2 deterministe compatible avec le validateur partage, liaison atomique cle-requete, reconciliation et rollback |

Chaque lot possede sa revue, ses tests et sa decision separee. La capacite V2 reste fermee jusqu'a un GO distinct des controles d'infrastructure et de production.

## Criteres de recette candidate

1. Les tests V1 actuels restent inchanges et reussissent.
2. Une charge V2 sur V1 et une charge V1 sur V2 sont refusees sans perte.
3. Tenant, auteur et droits fournis par le client sont ignores ou refuses.
4. Une organisation ou un exercice non resolu bloque la creation V2 ; un exercice rattache a une autre organisation est refuse.
5. Les relations fonction, portefeuille, dossier, projet et phase incoherentes sont refusees, notamment une fonction differente de celle du portefeuille resolu.
6. Une reference `restricted` est refusee sans reveler son existence tant qu'aucune politique Management active ne prouve l'acces de l'identite courante.
7. Une equipe et l'agent de la meme ligne incompatibles sont refuses ; le collectif reste limite a son equipe. Le responsable budgetaire de toute creation ou promotion V2 est un agent resolu explicite, jamais l'auteur deduit, et toute reference d'agent reste bloquee tant que son appartenance au tenant n'est pas prouvee par une source autoritative.
8. Deux lignes ne peuvent jamais partager le meme `row.id`.
9. Chaque ligne contient exactement les `periodId` de l'exercice resolu ; l'ordre du tableau ne change pas leur sens.
10. Chaque reference resolue persiste sa revision, son statut, sa periode d'effet, son libelle et ses parents canoniques dans le schema ferme de `referenceSnapshots` ; il existe exactement une entree par `row.id`, remplacee atomiquement avec la version courante, sans pretendre conserver l'historique anterieur.
11. Une revocation apres sauvegarde exclut le brouillon des listes et bloque lecture, export, mise a jour et restitution d'une reprise idempotente sans fuite ; la reprise conserve sa liaison, ne relit pas le contenu V1 et applique la validation de lecture V2 a toutes les references de la version V2 courante, y compris celles ajoutees apres promotion.
12. L'annee de synthese vient du referentiel d'exercice ; une annee V1 divergente bloque la promotion.
13. Une source indisponible produit un refus ferme, sans secours par libelle.
14. Le schema ferme refuse les champs inconnus, les enumerations hors contrat, les tailles excessives et toute mise a jour sans `expectedVersion` valide.
15. Vide, zero reel et invalide restent trois etats distincts ; les montants V2 suivent la grammaire decimale bornee du contrat.
16. Le taux est soit entierement absent, soit positif, borne et accompagne d'une source et d'une date ISO valides ; toute combinaison partielle est refusee.
17. Un conflit de version reste `409` sans ecrasement ; `expectedVersion` s'arrete a `999999` et la version stockee `1000000` est terminale.
18. Un calendrier accepte est mensuel et contient exactement douze periodes valides couvrant l'exercice ; toute autre periodicite est refusee comme incompatible. Une valeur mensuelle, un taux ou une source de taux V1 avec espaces exterieurs est egalement signale incompatible, sans normalisation silencieuse.
19. La grammaire de `Idempotency-Key` et sa derivation SHA-256 normative produisent la meme empreinte sur toutes les instances ; aucune cle brute n'est persistee ou journalisee.
20. Une premiere utilisation d'une cle valide sans liaison lit et compare la version V1, resout les cibles, puis cree et lie atomiquement la promotion ; `expectedSourceVersion` accepte toute version V1 lisible de `1` a `1000000`. Deux reprises portant la meme cle, la meme version source attendue et les memes references cibles, responsable budgetaire compris, retournent le meme UUID V2 au format accepte par le validateur partage avant toute relecture du V1, y compris si le V1 a change apres une reponse perdue ; une nouvelle cle avec une version source obsolete echoue sans creation. Toute reutilisation de cle avec une autre intention et toute autre cle pour la meme intention ou demande deja creee sont refusees atomiquement, y compris sous concurrence.
21. Les metadonnees de promotion restent serveur, immuables et preservees apres toute mise a jour V2 ; la valeur V1 `budget.revision` est conservee exactement dans `sourceExportRevision` sans devenir la version serveur V2 ni etre remise a zero.
22. Aucun montant, cle idempotente brute ni contenu de brouillon n'apparait dans les journaux techniques.

## Arbitrage groupe candidat

Confirmer ou amender `BUDGET-T1-TECH-001 V0.1` en une seule decision :

1. retenir des routes V1 et V2 distinctes, sans conversion implicite ;
2. maintenir le contrat V1 executable inchange ;
3. imposer organisation et exercice resolus avant toute creation V2 ;
4. utiliser des resoluteurs serveur tenant-scoped appliquant la confidentialite et persister leurs revisions dans la version courante, sans revendiquer d'historique avant stockage versionne ;
5. stocker d'abord l'enveloppe V2 dans le JSON existant, sans DDL implicite ;
6. maintenir responsabilites metier et permissions applicatives strictement separees ;
7. deriver l'entite et l'annee de synthese des referentiels resolus et recontroler leur visibilite a chaque restitution ;
8. promouvoir V1 vers V2 uniquement par commande explicite liee a la version, a l'empreinte source et aux references cibles resolues, avec metadonnees serveur immuables, identifiant V2 deterministe au format UUID V4 accepte par le validateur partage, cle idempotente hachee et reconciliation ;
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
