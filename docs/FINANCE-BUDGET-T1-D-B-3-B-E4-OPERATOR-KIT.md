# BUDGET-T1-D-B-3-B-E4-KIT-001 V0.2 - kit operateur E4

Date de preparation : 11-09-2026.

Statut : kit documentaire correctif candidat. Il remplace la route unique de V0.1 apres le `NO-GO` de `RUN-001`, sans ouvrir une nouvelle execution, creer une ressource, installer un outil, ouvrir une connexion ou engager une depense.

## Finalite

Fournir une feuille unique pour conduire, arreter, nettoyer et rapporter la recette PostgreSQL ephemere E4. Le cadrage `BUDGET-T1-D-B-3-B-E4-001 V0.1` reste la source normative ; ce kit n'en change ni les trente-six controles ni les frontieres.

## Identification de la session

| Champ | Valeur initiale |
| --- | --- |
| reference | nouvelle reference `RUN-002` ou ulterieure a attribuer apres autorisation |
| date | a autoriser |
| fenetre | a autoriser, huit heures maximum sur une meme journee |
| responsable humain | Cheikh |
| operateur technique | Codex |
| fournisseur et offre | Supabase Pro, a revalider avant toute depense |
| region | Zurich `eu-central-2` |
| plafond absolu | 35 USD, taxes et frais compris |
| route SQL ordinaire | pooler de session IPv4 pour `psql` |
| route dump/restauration | connexion directe IPv6 par defaut ; IPv4 facture uniquement sur arbitrage explicite |
| donnees | synthetiques uniquement |
| verdict initial | `FERME` |

Les references de compte, projet, branche, hote, utilisateur, IP et secret ne sont jamais inscrites dans ce document.

## Prevol avant toute depense

Ce prevol est documentaire. Les constats techniques ou commerciaux sont interdits avant l'ouverture effective de P0.

- [ ] laptop alimente et espace de travail ferme aux donnees reelles ;
- [ ] Cheikh disponible pour authentification, conditions et paiement ;
- [ ] plafond de 35 USD et heure de fin nouvellement autorisee rappeles ;
- [ ] documents E3, E4 et P0 accessibles localement ;
- [ ] `COR-01` : matrice phase/connexion conforme aux sources officielles ;
- [ ] `COR-02` : compatibilite IPv6 constatee par un resultat booleen nettoye ;
- [ ] `COR-03` : disponibilite documentaire de la route directe confirmee ; controle effectif differe apres P3 sans consigner les hotes ;
- [ ] `COR-04` : cout maximal complet, taxes et frais inclus, inferieur ou egal a 35 USD ;
- [ ] `COR-05` : P0 V0.2, kit V0.2, nouvelle date et nouvelle autorisation concordants ;
- [ ] emplacement ephemere de preuve et regle de suppression identifies ;
- [ ] production, routes, IAM M3S, preview applicative et Budget personnel confirmes hors perimetre.

Une case manquante maintient P0 en `NO-GO`.

## Tableau de conduite P0 a P7

| Phase | Controles de reference | Intervention humaine | Porte de sortie | Etat initial |
| --- | --- | --- | --- | --- |
| P0 | `COR-01`, `COR-02`, `COR-04`, `COR-05`, qualification de `COR-03`, `E4-01`, `3B-01` a `3B-03` | confirmer route, fenetre, responsables et bornes | decision horodatee complete | `FERME` |
| P1 | `E4-02` | verifier offre, conditions et paiement | cout engage inferieur ou egal a 35 USD | `NON EXECUTE` |
| P2 | `E4-03` a `E4-05`, `E4-09`, `3B-06` | confirmer l'usage temporaire des adresses requises | `psql`, pooler, SSL et restrictions reseau conformes | `NON EXECUTE` |
| P3 | `E4-06`, `E4-07`, `3B-04` a `3B-12`, controle effectif `COR-03` | aucune sauf authentification imposee | deux cibles neuves, trois roles bornes et connexion directe disponible | `NON EXECUTE` |
| P4 | `3B-13` a `3B-15` | aucune | schema, fixtures et vingt controles `3-A` conformes | `NON EXECUTE` |
| P5 | `E4-08`, `3B-16` a `3B-18` | aucune | connexion directe nommee, dump borne et restauration exacte | `NON EXECUTE` |
| P6 | `3B-19` a `3B-23` | aucune | concordance, isolation et refus DDL conformes | `NON EXECUTE` |
| P7 | `E4-10`, `3B-24` a `3B-26` | constater cout et fermeture | aucune ressource residuelle | `NON EXECUTE` |

`E4-09` est recontrole avant chaque phase de connexion P2 a P6. Son inscription unique dans le tableau ne reduit pas cette repetition obligatoire.

## Registre des trente-six controles

Chaque ID recoit exactement un statut parmi `REUSSI`, `ECHEC`, `ARRETE` ou `NON EXECUTE`.

| Groupe | Identifiants | Quantite | Etat initial |
| --- | --- | --- | --- |
| controles E4 | `E4-01` a `E4-10` | 10 | `NON EXECUTE` |
| controles 3-B | `3B-01` a `3B-26` | 26 | `NON EXECUTE` |
| total | source normative E4 | 36 | `NON EXECUTE` |

Les cinq portes `COR-01` a `COR-05` sont rapportees separement et ne modifient pas le total normatif de trente-six controles. Le rapport final reprend une ligne par porte et par controle avec : ID, statut, heure, preuve nettoyee, reserve et decision de passage. Une preuve absente interdit le statut `REUSSI`.

## Format des preuves nettoyees

Sont admis :

- nom et version d'un outil ;
- resultat booleen d'un controle ;
- nombre d'objets ou de lignes synthetiques ;
- empreinte non reversible ;
- heure de debut ou de fin ;
- cout total en USD ;
- confirmation de suppression.

Sont exclus : chaine de connexion, hote, IP, identifiant de compte ou projet, nom technique d'une branche, mot de passe, jeton, moyen de paiement, contenu de table, dump, commande complete et journal brut.

## Procedure `STOP`

1. ne pas ouvrir la phase suivante ;
2. marquer le controle en `ECHEC` ou `ARRETE` avec une preuve nettoyee ;
3. couper toute nouvelle operation d'ecriture ou de connexion ;
4. passer a P7 pour supprimer ressources, secrets et artefacts autorises ;
5. verifier le cout final et l'absence de ressource residuelle ;
6. produire un verdict `NO-GO` ou `INDETERMINE`, sans reprise automatique.

Si P7 ne peut pas etre acheve, le rapport doit le signaler immediatement et demander l'intervention de Cheikh sans exposer de secret.

## Rapport final minimal

| Champ | Valeur a renseigner apres execution |
| --- | --- |
| debut et fin | heures Europe/Zurich |
| phases atteintes | portes COR puis P0 a P7 |
| portes correctives | statut de `COR-01` a `COR-05` |
| controles | total par statut sur les trente-six controles normatifs |
| source et restauration | comptes et empreintes uniquement |
| cout final | montant USD |
| nettoyage | complet, incomplet ou non applicable |
| ecarts | references nettoyees |
| verdict technique | `GO`, `NO-GO` ou `INDETERMINE` |

Le verdict technique ne vaut ni activation Budget ni autorisation d'une etape ulterieure.

Apres un verdict E4 recevable, le prochain cadrage candidat est `FINANCE-BUDGET-T1-E-PROMOTION-CONTRACT.md` (`BUDGET-T1-E-001 V0.1`). E4 ne l'ouvre pas automatiquement et T1-E demeure ferme pendant toute correction ou nouvelle execution E4.

## Verdict du kit V0.2

- **Kit operateur :** `PRET A REVOIR`.
- **Execution actuelle :** `FERMEE` apres le `NO-GO` de `RUN-001`.
- **Ressource, outil, compte, secret ou depense cree :** aucun.
- **Fenetre autorisee :** aucune.
- **Prochaine action :** confirmer ou amender P0 V0.2 et le kit V0.2 ; leur eventuelle fusion restera documentaire et n'autorisera pas une nouvelle fenetre.
