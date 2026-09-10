# BUDGET-T1-D-B-3-B-ENV-001 V0.1 - recommandation candidate d'environnement

Date de preparation : 10-09-2026.

Statut : candidat documentaire a confirmer ou amender. Ce paquet recommande une categorie d'environnement pour une future recette `T1-D-B.3-B`. Il ne selectionne aucun fournisseur, produit, compte, region ou offre et n'autorise aucune recherche externe, installation, creation de cible, connexion, secret, IAM, migration ou execution.

## Objet de la decision

La decision doit retenir une categorie d'environnement suffisamment fidele a PostgreSQL serveur pour prouver :

- la sauvegarde logique et la restauration sur une seconde instance neuve ;
- la separation entre proprietaire ephemere, migration et runtime ;
- le refus de tout DDL au runtime ;
- la conservation des contraintes, revisions, donnees et audits fictifs ;
- la fermeture et le nettoyage complet des ressources.

Cette decision ne vaut ni choix de fournisseur ni autorisation d'executer les vingt-six controles de `BUDGET-T1-D-B-3-B-001 V0.1`.

## Faits disponibles

### Socle technique

- `T1-D-B.3-A` est fusionne dans `main` et prouve les transactions sur PGlite en memoire.
- Le cadrage `BUDGET-T1-D-B-3-B-001 V0.1` est fusionne dans `main` via `4a5cf97`.
- PGlite ne remplace pas une recette PostgreSQL serveur complete.

### Poste de travail au 10-09-2026

| Element observe | Valeur |
| --- | --- |
| memoire physique totale | 15,7 Go |
| memoire libre au controle | 5,9 Go |
| espace libre sur le disque C | 45,2 Go |
| Docker | absent |
| Podman | absent |
| `psql`, `pg_dump`, `pg_restore` | absents |

Ces valeurs sont un instantane de cadrage. Elles devront etre recontrolees avant toute execution et ne justifient aucune installation automatique.

## Classement candidat

| Rang | Option | Position candidate | Motif principal |
| ---: | --- | --- | --- |
| 1 | C. Cible preview ephemere gouvernee | recommandee pour instruction | fidelite serveur sans charger ni modifier le laptop |
| 2 | A. Conteneur local ephemere | solution de repli | bonne reproductibilite, mais moteur absent et ressources locales a surveiller |
| 3 | B. PostgreSQL local dedie | non recommande en premiere intention | installation plus intrusive, service et nettoyage locaux plus difficiles a borner |

## Recommandation candidate

L'option C est recommandee comme categorie a instruire en premier, sous conditions cumulatives :

1. cible strictement `non-production` et `synthetic-only` ;
2. deux instances neuves et ephemeres, source et restauration ;
3. aucune accessibilite publique ;
4. secrets temporaires, distincts et jamais consignes dans le depot ;
5. roles proprietaire, migration et runtime separes ;
6. duree de vie et suppression automatique ou verifiable ;
7. cout maximal approuve avant creation ;
8. region, sous-traitance et conditions de traitement acceptees ;
9. compatibilite prouvee avec `psql`, `pg_dump` et `pg_restore` ;
10. responsable humain nomme pour la creation, le controle et le nettoyage.

Cette recommandation ne choisit aucun fournisseur. Une cible externe reste fermee tant que les portes ci-dessous ne sont pas franchies.

## Portes de decision separees

| Porte | Decision humaine | Sortie attendue | Etat V0.1 |
| --- | --- | --- | --- |
| E0 | confirmer ou amender le classement A/B/C | categorie prioritaire candidate | ouverte a validation |
| E1 | autoriser une recherche externe bornee | criteres et sources officielles seulement | fermee |
| E2 | confirmer une liste courte | deux fournisseurs candidats au maximum, sans creation de compte | fermee |
| E3 | selectionner un fournisseur et une offre | cout, region, duree, reseau, secrets et responsable | fermee |
| E4 | autoriser le paquet d'execution | cible exacte et vingt-six controles | fermee |

Les portes sont sequentielles. La confirmation de E0 n'autorise pas E1 ; E1 n'autorise ni compte, essai gratuit, secret, cible ou execution.

La recherche officielle candidate de la porte E1 est portee par `FINANCE-BUDGET-T1-D-B-3-B-E1-PROVIDER-RESEARCH.md` (`BUDGET-T1-D-B-3-B-E1-001 V0.1`).

## Criteres de comparaison d'un futur fournisseur

Une future recherche autorisee devra comparer uniquement des informations officielles et datees :

| Domaine | Critere eliminatoire ou de classement |
| --- | --- |
| moteur | PostgreSQL serveur compatible avec les outils clients requis |
| cycle de vie | creation et suppression rapides, expiration bornee et verifiable |
| sauvegarde | export logique et restauration sur une seconde instance permis |
| reseau | acces public desactive ou filtrage strictement borne |
| identites | comptes ou roles distincts avec moindre privilege testable |
| secrets | valeurs temporaires, rotation et suppression possibles |
| region | localisation explicite et acceptable pour le pilote fictif |
| cout | plafond total connu, absence de renouvellement implicite |
| preuves | journaux nettoyables et confirmation de suppression disponibles |
| sortie | aucune dependance proprietaire necessaire pour recuperer ou detruire la preuve |

## Motifs de refus immediat

Un fournisseur ou une offre est ecarte si :

- une carte bancaire ou un engagement payant est requis avant arbitrage ;
- l'offre impose un renouvellement automatique non borne ;
- la base doit etre publique ;
- la region ou la duree de conservation est inconnue ;
- les roles minimaux ne peuvent pas etre distingues ;
- `pg_dump` ou `pg_restore` est interdit ou incompatible ;
- la suppression complete n'est pas verifiable ;
- l'offre exige une donnee reelle, un acces M3S ou une connexion a la production.

## Solution de repli A

L'option A ne pourra etre reouverte que si :

- l'installation d'un moteur de conteneurs est autorisee separement ;
- le disque C conserve une marge de securite apres installation et images ;
- la memoire et la charge du laptop sont compatibles avec deux instances temporaires ;
- les ports restent locaux et non publics ;
- les images, volumes, secrets et reseaux sont supprimes apres recette.

Elle reste une solution de repli et non une autorisation d'installation.

## Option B

L'installation d'un PostgreSQL local dedie n'est pas recommandee en premiere intention. Elle cumule service local, ports, repertoires, comptes, versions et nettoyage avec une valeur probatoire comparable aux autres options. Elle ne sera reconsideree que si les options C et A deviennent impossibles et apres un nouvel arbitrage.

## Verdict V0.1

- **Categorie recommandee pour instruction :** option C.
- **Solution de repli :** option A.
- **Option non prioritaire :** option B.
- **Choix de fournisseur :** aucun.
- **Recherche externe :** non autorisee.
- **Installation et execution :** `NO-GO`.
- **Ouvertures operationnelles :** routes, stockage reel, IAM reel, preview, frontend, production et Budget personnel restent fermes.

## Prochaine decision proposee

Confirmer ou amender uniquement E0, c'est-a-dire le classement candidat `C puis A puis B`. Une autorisation separee sera necessaire pour E1 et devra borner la recherche a deux fournisseurs, aux sources officielles, aux criteres ci-dessus et a l'absence de toute creation de compte ou depense.
