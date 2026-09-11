# BUDGET-T1-D-B-3-B-E4-P0-001 V0.2 - porte d'autorisation E4

Date de preparation : 11-09-2026.

Statut : version corrective candidate, preparee apres le `NO-GO` de `BUDGET-T1-D-B-3-B-E4-RUN-001`. Elle n'ouvre aucune nouvelle fenetre et n'autorise aucune action.

## Finalite

Permettre une seule decision humaine, courte mais complete, couvrant les sept autorisations obligatoires du cadrage `BUDGET-T1-D-B-3-B-E4-001 V0.1`. La decision n'ouvre que la recette technique isolee de Budget V2 et ne vaut jamais activation de Budget, acces a une donnee reelle ou connexion a M3S.

## Parametres deja acquis

| Champ | Valeur bornee |
| --- | --- |
| fournisseur | Supabase |
| offre candidate | Pro, a revalider sur source officielle avant paiement |
| ressources | deux preview branches Micro neuves |
| region | Zurich `eu-central-2` |
| poste client | laptop 2SG, clients PostgreSQL legers uniquement |
| connexion P2 a P4 et P6 | `psql` par pooler de session IPv4, port `5432`, SSL |
| connexion P5, route A | `pg_dump` et `pg_restore` par connexion directe IPv6, port `5432`, SSL |
| connexion P5, route B | connexion directe IPv4 avec extension facturee, seulement si A est indisponible et B expressement autorisee |
| reseau route A | IPv4 publique limitee a un `/32` pour le pooler et IPv6 limitee a un `/128` pour la connexion directe ; adresses non consignees |
| reseau route B | IPv4 publique limitee a un `/32` ; adresse et hote non consignes |
| duree maximale | huit heures sur une meme journee nouvellement autorisee |
| plafond absolu | 35 USD, taxes et frais compris |
| donnees | fixtures synthetiques uniquement |
| controles | trente-six controles du paquet E4 |
| portes correctives | `COR-01` a `COR-05` du paquet `BUDGET-T1-D-B-3-B-E4-COR-001 V0.1` |
| nettoyage | P7 obligatoire, meme apres arret anticipe |

Ces parametres ne valent ni commande, ni souscription, ni consentement contractuel, ni execution.

## Sept autorisations a prononcer ensemble

| ID | Autorisation requise | Valeur confirmee | Etat acquis |
| --- | --- | --- | --- |
| `P0-A01` | date et fenetre | nouvelle date, debut et fin le meme jour, huit heures maximum | `A AUTORISER` |
| `P0-A02` | depense | plafond total de 35 USD, sans depassement ni renouvellement non borne | `A AUTORISER` |
| `P0-A03` | compte et conditions | Cheikh ouvre ou utilise le compte et accepte lui-meme les conditions applicables | `A AUTORISER` |
| `P0-A04` | outils et route | `psql` par pooler ; `pg_dump` et `pg_restore` par route directe A ou B nommee | `A AUTORISER` |
| `P0-A05` | cibles et roles | deux branches neuves et trois roles ephemeres distincts | `A AUTORISER` |
| `P0-A06` | execution | portes correctives aux moments prescrits, puis P1 a P7 et trente-six controles, strictement dans l'ordre | `A AUTORISER` |
| `P0-A07` | responsabilites | Cheikh pour authentification, conditions et paiement ; Codex pour controle, execution bornee et nettoyage | `A AUTORISER` |

Une valeur manquante, ambigue ou differente du paquet confirme maintient `NO-GO`.

## Interventions humaines obligatoires

1. Avant toute depense, Cheikh confirme la nouvelle date et reste disponible pendant la fenetre.
2. Codex controle la compatibilite IPv6 sous forme booleenne, sans consigner d'adresse. Un resultat positif selectionne la route A ; un resultat negatif maintient `NO-GO` jusqu'a l'arbitrage explicite de la route B.
3. En P1, Cheikh controle l'offre affichee, accepte les conditions et realise lui-meme toute authentification ou tout paiement.
4. Avant la premiere connexion, Cheikh confirme l'usage temporaire des seules adresses reseau requises, sans qu'elles soient consignees.
5. Apres P7, Cheikh constate le cout final et la fermeture des ressources.

Codex ne demande, ne lit et ne conserve aucun numero de carte, code de verification, mot de passe ou facteur d'authentification.

## Regles Fast Track d'execution future

- L'autorisation du 11-09-2026 est consommee et ne peut pas etre reutilisee.
- Une nouvelle decision P0 complete ouvre `COR-01`, `COR-02`, `COR-04`, `COR-05` et la qualification documentaire de `COR-03` avant P1, puis les phases P1 a P7 dans une seule fenetre.
- La disponibilite effective de la connexion directe sur les deux cibles complete `COR-03` apres leur creation en P3 et avant toute operation P5. Un echec declenche `STOP` puis P7.
- Chaque phase produit sa preuve nettoyee et sa porte de passage avant la suivante.
- Tout ecart produit `STOP`; P7 reste alors obligatoire pour le nettoyage.
- Aucun depassement de cout, de duree ou de perimetre n'est tacitement accepte.
- Aucun secret, identifiant de projet, nom d'hote, adresse IP ou contenu de table n'entre dans Git, le journal ou un rapport partage.
- Le navigateur, le compte et le moyen de paiement restent sous controle humain.

## Portes encore fermees

La future autorisation E4 ne devra pas ouvrir :

- une route HTTP Budget ;
- un stockage ou une migration de production ;
- un IAM M3S reel ;
- une donnee Finance, Budget ou identite reelle ;
- une recette preview applicative ;
- le frontend ou le Budget personnel ;
- l'activation de Budget sur `seneswiss-group.com`.

Toute action de cette liste exige un arbitrage distinct apres le verdict E4.

## Formule unique de decision

La decision pourra etre prononcee en une fois avec la formule suivante, apres remplacement de la date, des heures et de la route :

> Je confirme `BUDGET-T1-D-B-3-B-E4-P0-001 V0.2` et j'autorise une nouvelle execution E4 le `[JJ-MM-AAAA]` de `[HH:MM]` a `[HH:MM]` Europe/Zurich, selon la route `[A DIRECTE IPV6 / B DIRECTE IPV4]`, dans une fenetre maximale de huit heures et avec un plafond absolu de 35 USD taxes et frais compris. J'autorise les cinq portes correctives, l'utilisation ou la creation du compte Supabase sous mon controle, les seuls clients PostgreSQL prevus, les deux branches et trois roles ephemeres, les trente-six controles sequentiels et le nettoyage P7 obligatoire. Je conserve l'authentification, l'acceptation des conditions et le paiement. Cette autorisation n'ouvre aucune route HTTP, production, donnee reelle, IAM M3S, recette preview, frontend, Budget personnel ou activation Budget.

La confirmation du document seul n'autorise pas l'execution. La formule doit comporter une date effective et l'autorisation explicite d'executer E4.

Le kit de conduite et de preuve correspondant est prepare dans `FINANCE-BUDGET-T1-D-B-3-B-E4-OPERATOR-KIT.md` (`BUDGET-T1-D-B-3-B-E4-KIT-001 V0.2`). Il ne remplace pas les controles du cadrage et son eventuelle fusion reste documentaire.

## Verdict candidat V0.2

- **Paquet P0 :** corrige et `PRET A REVOIR`.
- **Autorisation du 11-09-2026 :** consommee par `RUN-001`, non reutilisable.
- **Nouvelle autorisation operationnelle :** absente.
- **Execution E4 :** fermee.
- **Compte, depense, secret, cible ou outil cree :** aucun.
- **Prochaine action :** confirmer ou amender P0 V0.2 et le kit V0.2 ; fixer une nouvelle fenetre uniquement dans une decision ulterieure distincte.
