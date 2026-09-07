# BUDGET-T1-001 V0.1 - referentiels, exercice et responsabilites

Date de cadrage : 07-09-2026.

Ce paquet traduit l'etape `T1` de `BUDGET-MAP-001 V0.1` en un contrat fonctionnel candidat. Il ne modifie ni l'API, ni les tables, ni les droits, ni les donnees. Il n'autorise aucune recette preview, migration, activation Budget, approbation, donnee reelle ou ouverture du Budget personnel.

## Regles de lecture

| Niveau | Sens |
| --- | --- |
| `ACTIF` | Objet ou controle present dans le backend courant et utilisable comme source technique constatee. |
| `TRANSITION` | Source existante et utile, mais qui ne constitue pas encore un referentiel maitre complet. |
| `CADRAGE` | Modele documente, sans registre applicatif actif confirme. |
| `FERME` | Besoin reconnu, mais volontairement exclu du prochain lot d'implementation. |

Une reference n'est utilisable que dans le tenant courant, avec un identifiant stable et un statut recevable. Son libelle sert a l'affichage et peut etre conserve comme instantane historique; il ne remplace jamais l'identifiant et ne donne aucun droit.

## Identite du budget

| Information | Regle T1 candidate | Situation actuelle |
| --- | --- | --- |
| `budget_id` | UUID technique genere par le serveur, immuable | `ACTIF` sous le champ `id` |
| `budget_code` | Reference metier lisible, unique dans le couple organisation/exercice; format definitif a confirmer | `CADRAGE`; ne pas le fabriquer depuis le titre |
| `tenant_id` | Frontiere de securite derivee de l'identite authentifiee | `ACTIF`; jamais fourni par le client |
| `entity_id` | Organisation budgetee issue d'un referentiel autorise | `CADRAGE`; le `tenant_id` ne vaut pas automatiquement `entity_id` |
| `entity_label_snapshot` | Libelle affiche au moment de la version, sans effet d'autorisation | `TRANSITION` depuis l'actuel champ libre `entity` |
| `title` | Libelle humain du budget, non unique et non structurant | `ACTIF` |
| `scope_type` | `organization` impose par le serveur dans ce domaine | `ACTIF`; toute portee personnelle reste `FERME` |
| `author_user_id` | Auteur technique derive de la session qui cree le brouillon | `ACTIF` sous `owner_user_id` |

Le proprietaire technique actuel assure l'isolement du brouillon; il ne devient pas automatiquement responsable budgetaire, controleur ou approbateur.

## Exercice budgetaire

L'exercice devient un objet de reference distinct du simple entier `year`.

| Champ candidat | Regle |
| --- | --- |
| `fiscal_year_id` | Identifiant stable de l'exercice pour une organisation. |
| `label` | Libelle affiche, par exemple `Exercice 2027`; il n'est pas la cle. |
| `start_date`, `end_date` | Bornes inclusives, continues et sans chevauchement pour la meme organisation. |
| `periodicity` | `monthly` pour le contrat actuel a douze periodes. |
| `timezone` | Fuseau de cloture explicite; valeur 2SG encore a confirmer. |
| `status` | `planned`, `open` ou `closed`; ce statut ne remplace ni le workflow ni la version du budget. |

La grille actuelle janvier-decembre n'est compatible qu'avec un exercice civil. Un ancien brouillon peut etre relie automatiquement a un futur exercice uniquement si l'organisation confirme des bornes du 1er janvier au 31 decembre de la meme annee. Sinon, il reste lisible avec `fiscal_year_id` indisponible; aucun calendrier n'est invente et les douze valeurs ne sont pas decalees.

Les devises de restitution de l'organisation et la devise de reference de l'exercice restent a confirmer. T1 conserve donc chaque devise de ligne et l'hypothese CHF/CFA datee, sans imposer une nouvelle devise comptable.

## Responsabilites distinctes

| Responsabilite | Effet candidat | Source ou limite actuelle |
| --- | --- | --- |
| Auteur technique | Cree et met a jour son brouillon selon les droits Finance | `ACTIF`; authentification, `finance:read` et `finance:write` |
| Responsable budgetaire | Porte le perimetre, les hypotheses et la preparation du budget | `CADRAGE`; identite a choisir dans un referentiel d'agents recevable |
| Controleur | Controle coherence, sources et ecarts sans approuver | `CADRAGE`; peut etre une fonction ou une personne mandatee |
| Approbateur | Prononce une decision budgetaire tracee | `FERME` jusqu'a T2, avec workflow, separation des responsabilites et audit confirmes |
| Lecteur | Consulte selon la visibilite autorisee | Limite actuelle : auteur proprietaire seulement |

Un role metier n'est pas une permission applicative. Les permissions actuelles `finance:read` et `finance:write` restent la seule verite d'acces du module; T1 ne cree ni permission d'approbation ni partage entre utilisateurs.

Le futur rattachement des responsabilites devrait utiliser une relation versionnee plutot que multiplier des colonnes de personnes dans le budget. Une meme personne peut cumuler auteur et responsable en phase de brouillon, mais aucune auto-approbation ne pourra etre deduite de ce cumul.

## Matrice des dimensions analytiques

| Dimension | Source M3S constatee | Niveau | Regle T1 candidate |
| --- | --- | --- | --- |
| Organisation | Identite de tenant active; pas de registre d'entites confirme | `CADRAGE` | Obligatoire sur le budget; creer ou confirmer une reference d'organisation avant implementation. |
| Fonction | Menus metier canoniques et `management_portfolios.function_id` | `TRANSITION` | Rattacher a une fonction operationnelle M3S, jamais a un DAS ou a un libelle de poste. |
| Equipe | `teamAgentContract` et RH-001 : `Team_ZH`, `Team_SN` | `TRANSITION` | Employer l'identifiant canonique; verifier la coherence agent/equipe et permettre le collectif de la meme equipe. |
| Pays | Valeurs metier utilisees par les modules, sans registre pays actif confirme | `CADRAGE` | Utiliser un identifiant pays seulement apres validation du referentiel; ne pas deduire le pays d'une devise. |
| Portefeuille | `management_portfolios` | `ACTIF` | Reference tenant-scoped; le portefeuille porte les dossiers. |
| Dossier | `management_dossiers`, avec `portfolio_id` | `ACTIF` | Un dossier budgete doit appartenir a un portefeuille recevable. |
| Projet | Modele standard `projets`, rattache a `dossier_id`; pas de registre backend actif confirme | `CADRAGE` | Aucun projet sans dossier; aucune saisie libre de projet. |
| Phase de projet | Modele standard `phases_projet`, rattache a `projet_id` | `CADRAGE` | Aucune phase sans projet; utiliser le referentiel de phase, pas son libelle comme cle. |
| DAS strategique | Mapping confirme des BU historiques vers quatre DAS | `TRANSITION` | Deriver du contexte source lorsque le mapping existe; ne pas remplacer fonction, equipe ou BU historique. |
| Centre de cout | Aucun referentiel actif confirme | `FERME` | Differer jusqu'a definition des codes, proprietaires et dates d'effet. |
| Financeur | Aucun referentiel actif confirme | `FERME` | Differer; ne pas convertir un fournisseur, donateur ou texte libre en financeur. |

Les quatre DAS de pilotage restent `SOCIAL`, `BUSINESS`, `DIGITAL` et `GOUVERNANCE_ORGANISATION`. M3S est le systeme de management de 2SG, pas un DAS. Les codes historiques restent conserves comme traces sources.

## Cardinalites et controles

1. Un budget T1 appartient a exactement une organisation et un exercice.
2. Une ligne budgetaire herite de ces deux rattachements et ne peut pas pointer vers un autre tenant.
3. Chaque dimension analytique autorisee porte au plus une valeur principale par ligne dans T1. Les allocations multiples et pourcentages de repartition restent fermes jusqu'a T4.
4. `project_id` exige un `dossier_id` coherent; `phase_id` exige le `project_id` parent; `dossier_id` exige son `portfolio_id`.
5. `agent_id` et `team_id`, lorsqu'ils existent ensemble, doivent respecter RH-001 et `teamAgentContract`. Un collectif ne peut appartenir qu'a sa propre equipe.
6. `das_id` ne doit pas etre saisi en contradiction avec le mapping d'une BU historique connue.
7. Une reference inactive, absente, d'un autre tenant ou non unique est refusee; elle ne devient ni texte libre ni valeur `Autre` silencieuse.
8. Une valeur inconnue reste indisponible. Elle ne devient ni zero, ni rattachement par defaut, ni preuve d'appartenance.

## Compatibilite et migration future

- Les brouillons T0 restent lisibles sans nouveau champ obligatoire.
- `entity` devient au mieux `entity_label_snapshot`; aucun `entity_id` ne lui est attribue par ressemblance de texte.
- `year` reste conserve. Un `fiscal_year_id` n'est ajoute par rapprochement que si les bornes civiles sont confirmees sans ambiguite.
- Les libelles historiques de fonction, equipe, pays, portefeuille, dossier, projet ou phase ne sont pas transformes automatiquement en identifiants.
- Tout rapprochement futur produit un rapport `apparie`, `ambigu`, `introuvable` ou `incompatible`, sans correction silencieuse.
- Les nouveaux rattachements resteront optionnels pour les anciens brouillons jusqu'a une migration explicitement relue, autorisee et reversible.

## Decisions T1 candidates

Confirmer ou amender `BUDGET-T1-001 V0.1` en une seule decision groupee :

1. retenir une identite metier distincte du titre, du tenant et de l'UUID technique;
2. retenir un exercice budgetaire reference, sans supposer que toute annee est civile;
3. maintenir `tenant_id`, auteur et droits exclusivement derives du serveur;
4. distinguer auteur, responsable budgetaire, controleur et approbateur, sans ouvrir l'approbation avant T2;
5. retenir fonction, equipe, pays et la chaine portefeuille > dossier > projet > phase comme axes analytiques controles;
6. conserver le DAS comme lecture strategique derivee et distincte des fonctions, equipes et BU historiques;
7. limiter T1 a une valeur principale par dimension et differer les allocations multiples a T4;
8. maintenir centre de cout, financeur, Budget personnel, donnees reelles, partage et activation dans l'etat `FERME`.

Apres confirmation, le prochain micro-lot pourra produire le contrat technique candidat de T1 et sa strategie de compatibilite, toujours sans DDL, migration, activation ni donnees reelles.

## Suite technique preparee

Apres confirmation et fusion de ce cadrage, `BUDGET-T1-TECH-001 V0.1` est documente dans `FINANCE-BUDGET-T1-TECHNICAL-CONTRACT.md`. Il propose un contrat V2 separe, la compatibilite V1, des resoluteurs tenant-scoped et cinq micro-lots d'implementation futurs. Il reste candidat et n'ouvre aucun code, DDL, referentiel, stockage ou environnement.

## Sources internes consultees

- `docs/FINANCE-BUDGET-CURRENT-TARGET-MAPPING.md`
- `docs/FINANCE-BUDGET-DRAFTS.md`
- `managementPortfolio.js` et `referentiels/managementPortfolioSeed.json`
- `teamAgentContract.js` et `referentiels/rh001MembersDirectory.json`
- `financeAccess.js`
- [Modele transversal M3S au commit frontend `e2141df`](https://github.com/snchgroup-web/m3s-frontend-v2/blob/e2141df74a38739fb72ae0902f9cce62894f0a0a/DATA_MODEL_STANDARD_M3S.md)
- [Mapping DAS executable au commit frontend `e2141df`](https://github.com/snchgroup-web/m3s-frontend-v2/blob/e2141df74a38739fb72ae0902f9cce62894f0a0a/src/strategicMapping.js)
