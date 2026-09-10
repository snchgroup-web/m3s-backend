# BUDGET-T1-D-B-3-B-E4-P0-001 V0.1 - porte d'autorisation E4

Date de preparation : 10-09-2026.

Statut : acte confirme et livre. La decision datee ouvre uniquement la future fenetre du 11-09-2026 de 14:00 a 22:00 Europe/Zurich ; aucune action n'est executee avant cette fenetre.

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
| connexion | pooler de session IPv4, port `5432`, SSL |
| reseau | IPv4 publique active limitee a un `/32` |
| duree maximale | huit heures sur une meme journee |
| plafond absolu | 35 USD, taxes et frais compris |
| donnees | fixtures synthetiques uniquement |
| controles | trente-six controles du paquet E4 |
| nettoyage | P7 obligatoire, meme apres arret anticipe |

Ces parametres ne valent ni commande, ni souscription, ni consentement contractuel, ni execution.

## Sept autorisations a prononcer ensemble

| ID | Autorisation requise | Valeur confirmee | Etat acquis |
| --- | --- | --- | --- |
| `P0-A01` | date et fenetre | 11-09-2026 de 14:00 a 22:00 Europe/Zurich | `AUTORISE 11-09-2026` |
| `P0-A02` | depense | plafond total de 35 USD, sans depassement ni renouvellement non borne | `AUTORISE 11-09-2026` |
| `P0-A03` | compte et conditions | Cheikh ouvre ou utilise le compte et accepte lui-meme les conditions applicables | `AUTORISE 11-09-2026` |
| `P0-A04` | outils clients | `psql`, `pg_dump` et `pg_restore` seulement, sans moteur local ni service resident | `AUTORISE 11-09-2026` |
| `P0-A05` | cibles et roles | deux branches neuves et trois roles ephemeres distincts | `AUTORISE 11-09-2026` |
| `P0-A06` | execution | phases P1 a P7 et trente-six controles, strictement dans l'ordre | `AUTORISE 11-09-2026` |
| `P0-A07` | responsabilites | Cheikh pour authentification, conditions et paiement ; Codex pour controle, execution bornee et nettoyage | `AUTORISE 11-09-2026` |

Une valeur manquante, ambigue ou differente du paquet confirme maintient `NO-GO`.

## Interventions humaines obligatoires

1. Avant P1, Cheikh confirme la date et reste disponible pendant la fenetre.
2. En P1, Cheikh controle l'offre affichee, accepte les conditions et realise lui-meme toute authentification ou tout paiement.
3. Avant la premiere connexion, Cheikh confirme que l'adresse IPv4 courante peut etre utilisee temporairement sans etre consignee.
4. Apres P7, Cheikh constate le cout final et la fermeture des ressources.

Codex ne demande, ne lit et ne conserve aucun numero de carte, code de verification, mot de passe ou facteur d'authentification.

## Regles Fast Track d'execution future

- Une decision P0 complete ouvre les phases P1 a P7 dans une seule fenetre.
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

La decision pourra etre prononcee en une fois avec la formule suivante, apres remplacement de la date :

> Je confirme `BUDGET-T1-D-B-3-B-E4-P0-001 V0.1` et j'autorise l'execution E4 le `[JJ-MM-AAAA]` dans une fenetre maximale de huit heures, avec un plafond absolu de 35 USD taxes et frais compris, l'utilisation ou la creation du compte Supabase sous mon controle, l'installation bornee des seuls clients PostgreSQL, la creation des deux branches et trois roles ephemeres, l'execution sequentielle des trente-six controles et le nettoyage P7 obligatoire. Je conserve l'authentification, l'acceptation des conditions et le paiement. Cette autorisation n'ouvre aucune route, production, donnee reelle, IAM M3S, recette preview, frontend, Budget personnel ou activation Budget.

La confirmation du document seul n'autorise pas l'execution. La formule doit comporter une date effective et l'autorisation explicite d'executer E4.

Le kit de conduite et de preuve correspondant est prepare dans `FINANCE-BUDGET-T1-D-B-3-B-E4-OPERATOR-KIT.md` (`BUDGET-T1-D-B-3-B-E4-KIT-001 V0.1`). Il ne remplace pas les controles du cadrage et son eventuelle fusion reste documentaire.

## Verdict candidat

- **Paquet P0 :** confirme et livre.
- **Autorisations operationnelles :** bornees a la fenetre du 11-09-2026, 14:00-22:00 Europe/Zurich.
- **Execution E4 :** autorisee dans cette fenetre uniquement, encore `NON EXECUTE`.
- **Compte, depense, secret, cible ou outil cree :** aucun.
- **Prochaine action :** ouvrir P0 a 14:00, revalider toutes les bornes puis executer ou prononcer `STOP`.
