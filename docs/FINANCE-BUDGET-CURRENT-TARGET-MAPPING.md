# BUDGET-MAP-001 V0.1 - matrice du contrat actuel vers le modele cible

Date de cadrage : 07-09-2026.

Cette matrice rapproche le contrat Budget effectivement implemente du modele fonctionnel confirme dans `BUDGET-BMK-001 V1.0`. Elle ne modifie ni l'API, ni le stockage, ni les droits. Elle n'autorise aucune recette preview, migration, activation de production ou ouverture du Budget personnel.

## Lecture des statuts

| Statut | Sens |
| --- | --- |
| `COUVERT` | Le contrat actuel porte deja l'information de facon explicite. |
| `PARTIEL` | Une information proche existe, mais ne remplit pas encore tout le besoin cible. |
| `DERIVE` | La valeur peut etre calculee sans devenir une nouvelle source maitresse. |
| `ABSENT` | Le contrat actuel ne porte pas cette information. |
| `FERME` | Le besoin est reconnu, mais son ouverture reste volontairement interdite. |

## Verite du contrat implemente

- Objet unique : brouillon annuel d'organisation, isole par `tenant_id` et `owner_user_id`.
- API : capacites, liste, lecture, creation et mise a jour avec controle de version optimiste.
- Enveloppe : `title`, `entity`, `year`, `revision`, hypothese de taux et lignes budgetaires.
- Ligne : libelle, nature, sens du flux, devise et douze montants mensuels.
- Devises : `CHF` ou `CFA`; conversion uniquement avec un taux saisi, source et date.
- Etats des montants : le client distingue vide, zero reel et valeur invalide; le serveur conserve vide et zero reel, mais refuse tout brouillon contenant une valeur invalide.
- Statut serveur fixe : `draft`; acces fixe : `owner-only`; portee fixe : `organization`.
- Stockage prepare : JSON du brouillon et journal technique `created`/`updated`, sans montant dans les evenements.
- Frontieres : aucune suppression, approbation, collaboration, allocation d'operation reelle, preuve GED, tresorerie, scenario ou donnee personnelle.

## Correspondance des objets

| Objet cible confirme | Equivalent actuel | Statut | Suite requise avant implementation |
| --- | --- | --- | --- |
| Budget organisation | Brouillon annuel `scope: organization` | `PARTIEL` | Definir l'identite metier stable du budget au-dela du brouillon technique. |
| Version budgetaire | `budget.revision` dans le fichier et `version` serveur | `PARTIEL` | Distinguer version initiale, revisee et courante du compteur de concurrence. |
| Enveloppe / ligne | `rows[]` | `PARTIEL` | Ajouter codes, rattachements analytiques et responsabilites apres validation de la taxonomie. |
| Periode mensuelle | `months[12]` | `COUVERT` | Nommer l'exercice et conserver le mois comme periode explicite lors d'une future normalisation. |
| Hypothese de change | `rate`, `rateSource`, `rateDate` | `COUVERT` | Conserver le principe : aucun taux courant implicite. |
| Scenario | Aucun | `ABSENT` | Definir baseline, optimiste, prudent et leurs droits de modification. |
| Engagement | Aucun | `ABSENT` | Definir l'evenement metier et sa source maitresse avant tout champ. |
| Allocation d'une operation reelle | Aucune | `FERME` | Valider les sources Recettes, Depenses, Paiements et Finance immobiliere ainsi que les regles d'allocation. |
| Prevision de tresorerie | Aucune | `ABSENT` | Definir solde d'ouverture, encaissements, decaissements et horizon. |
| Decision / approbation | Aucune; statut fixe `draft` | `FERME` | Definir roles, transitions, trace et effet d'une approbation. |
| Source / preuve GED | Source et date du taux seulement | `PARTIEL` | Ajouter une reference GED sans copier de piece dans le brouillon. |
| Budget personnel / menage | `personalEnabled: false` | `FERME` | Concevoir un domaine prive separe, owner-only, avec consentement et retention propres. |
| Besoin economique du porteur | Aucun | `FERME` | Deriver seulement sur consentement, sans transferer le detail prive vers le budget 2SG. |

## Correspondance des champs

| Champ cible | Champ actuel | Statut | Regle de passage |
| --- | --- | --- | --- |
| `budget_id` | `id` serveur | `COUVERT` | Conserver l'UUID comme identifiant technique. |
| `version_id` | `version` et `revision` | `PARTIEL` | Introduire un identifiant de version metier distinct des deux compteurs existants. |
| `scope_type` | `scope: organization` renvoye par l'API | `PARTIEL` | Ne pas accepter de valeur fournie par le client avant l'ouverture d'autres portees. |
| `owner_id` | `owner_user_id` issu de l'identite | `COUVERT` | Rester exclusivement derive de l'authentification serveur. |
| `tenant_id` | `tenant_id` issu de l'identite | `COUVERT` | Ne jamais le prendre dans le corps de requete. |
| Entite | `entity` | `PARTIEL` | Le libelle actuel est descriptif; un futur `entity_id` devra venir d'un referentiel autorise. |
| Exercice fiscal | `year` | `PARTIEL` | L'annee civile existe; debut, fin et calendrier fiscal restent a definir. |
| Periode | Position dans `months[12]` | `PARTIEL` | La rendre explicite si les lignes sont normalisees. |
| Libelle | `rows[].label` | `COUVERT` | Conserver la limite et la validation actuelles. |
| Categorie | Aucune categorie distincte | `ABSENT` | Valider la taxonomie avant ajout. |
| Nature | `rows[].kind` | `COUVERT` | Correspondances : fonctionnement, investissement, financement. |
| Sens | `rows[].direction` | `COUVERT` | Correspondances : entrant et sortant. |
| Montant original | `rows[].months[]` | `PARTIEL` | Conserver les chaines decimales et la distinction vide/zero; l'invalide reste un etat client refuse par l'API, jamais une valeur persistee. |
| Devise originale | `rows[].currency` | `COUVERT` | Valeurs actuelles : CHF ou CFA. |
| Montants CHF et CFA | Montant original plus hypothese de taux | `DERIVE` | Ne pas stocker un equivalent comme montant saisi ni utiliser un taux live implicite. |
| Taux, date, source | `rate`, `rateDate`, `rateSource` | `COUVERT` | Source et date obligatoires des qu'un taux est saisi. |
| Budget initial | Aucun axe explicite | `ABSENT` | Creer seulement apres definition de la promotion d'un brouillon. |
| Budget revise | `revision` ne suffit pas | `ABSENT` | Ne pas reutiliser le compteur d'export comme statut metier. |
| Budget courant | Aucun | `ABSENT` | Definir la regle de selection de la version faisant autorite. |
| Prevision | Les douze mois du brouillon | `PARTIEL` | L'existant constitue une prevision simple, sans scenario ni fin de periode. |
| Engage | Aucun | `ABSENT` | Source et definition obligatoires. |
| Realise rapproche | Aucun | `FERME` | Ouvrir uniquement apres contrat de rapprochement. |
| Paye rapproche | Aucun | `FERME` | Ne pas confondre realise, paye et mouvement bancaire. |
| Ecart | Sommes calculables entre valeurs futures | `DERIVE` | Calculer uniquement lorsque les deux bases comparees sont valides et de meme perimetre. |
| Taux d'execution | Aucun | `DERIVE` | Definir le denominateur et traiter le budget nul ou indisponible. |
| Prevision de fin de periode | Aucune | `ABSENT` | Definir la methode et les hypotheses. |
| Organisation, fonction, dossier, projet, phase, pays, equipe, DAS, centre de cout, financeur | `entity` seulement | `PARTIEL` | Ajouter des identifiants de referentiels, jamais des libelles libres faisant office de droits. |
| Responsable | Proprietaire technique uniquement | `PARTIEL` | Distinguer auteur, responsable budgetaire, controleur et approbateur. |
| Statut d'approbation | `status: draft` fixe | `FERME` | Introduire une machine d'etats seulement avec roles et audit valides. |
| Reference source / document GED | `rateSource` pour le taux | `PARTIEL` | Generaliser par references stables sans integrer les pieces sensibles. |
| Horodatages | `created_at`, `updated_at`, `occurred_at` | `COUVERT` | Les conserver cote serveur. |

## Correspondance des quatre axes

| Axe confirme | Couverture actuelle | Verdict |
| --- | --- | --- |
| Version : initial, revise, courant | Deux compteurs techniques sans semantique budgetaire | `ABSENT` au sens metier |
| Workflow : brouillon, soumis, approuve, cloture | Brouillon uniquement | `FERME` au-dela de `draft` |
| Execution : planifie, engage, realise, paye | Planifie simple uniquement | `PARTIEL`; rapprochement ferme |
| Mesures derivees : disponible, ecart, taux, prevision | Totaux annuels par devise calculables dans le client | `PARTIEL`; definitions cibles a fixer |

Ces axes restent independants. Une version courante n'est pas necessairement approuvee; une ligne realisee n'est pas necessairement payee; un brouillon enregistre n'est pas une decision.

## Correspondance des vues organisationnelles

| Vue cible | Donnees actuelles reutilisables | Statut |
| --- | --- | --- |
| Vue d'ensemble | Totaux par devise, sens et completude des mois | `PARTIEL` |
| Previsions | Lignes et douze mois | `PARTIEL` |
| Execution et ecarts | Aucun realise rapproche | `FERME` |
| Tresorerie | Aucun solde d'ouverture ni calendrier d'encaissement | `ABSENT` |
| Scenarios | Aucun scenario | `ABSENT` |
| Versions et approbations | Compteurs techniques seulement | `FERME` |
| Sources et justificatifs | Hypothese de taux documentee | `PARTIEL` |

Les six branches sont des vues reliees d'un meme budget. Elles ne doivent pas devenir six totaux independants ni six registres concurrents.

## Frontieres confirmees

1. Le Budget personnel et menage reste un domaine prive distinct, non active et non alimente par le contrat organisation actuel.
2. Aucun detail personnel ne remonte automatiquement au tableau de bord global, au Daily Intelligence, aux assistants partages ou aux exports 2SG.
3. Le besoin economique d'un porteur de projet pourra etre calcule par consentement explicite a partir d'agregats minimaux; il ne copie pas ses depenses privees dans le budget d'entreprise.
4. Le rapprochement avec Recettes, Depenses, Paiements et Finance immobiliere reste ferme jusqu'a validation des sources, des cles de liaison et des allocations multiples.
5. Une valeur absente ne devient jamais zero; une hypothese ne devient jamais un realise; une piece citee ne devient jamais une preuve acceptee automatiquement.

## Trajectoire technique candidate

| Etape | Contenu | Condition de sortie |
| --- | --- | --- |
| `T0` | Conserver le brouillon annuel actuel et ses garde-fous | Preuves et verdicts `GO` distincts pour P1-P4, puis decision P5 separee |
| `T1` | Ajouter identite budgetaire, exercice fiscal et rattachements analytiques valides | Taxonomie, responsables et referentiels confirmes |
| `T2` | Introduire versions metier et workflow d'approbation | Roles, transitions et audit confirmes |
| `T3` | Ajouter scenarios et tresorerie | Hypotheses, solde d'ouverture et methode confirmes |
| `T4` | Rapprocher engage, realise et paye | Sources maitresses et allocations confirmees |
| `T5` | Concevoir separement Budget personnel/menage et vue porteur consentie | Politique de confidentialite, retention, droits et consentement confirmes |

Chaque etape constitue un micro-lot autonome. Aucune colonne ou table future n'est ajoutee par anticipation dans le lot actuel.

## Arbitrage groupe candidat

Confirmer ou amender `BUDGET-MAP-001 V0.1` comme correspondance de reference entre le contrat implemente et `BUDGET-BMK-001 V1.0`, avec les decisions suivantes :

1. conserver l'actuel brouillon annuel comme socle `T0` et non comme modele final complet;
2. retenir les statuts `COUVERT`, `PARTIEL`, `DERIVE`, `ABSENT` et `FERME` pour piloter les ecarts;
3. ne pas reutiliser `revision` ou `version` comme statut de version budgetaire metier;
4. traiter les six branches organisationnelles comme des vues reliees d'un meme budget;
5. maintenir rapprochement reel, approbation et Budget personnel fermes;
6. preparer ensuite un seul cadrage `T1` des referentiels, roles et rattachements analytiques, sans implementation implicite.
