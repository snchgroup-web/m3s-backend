# BUDGET-T1-D-B-3-B-E4-KIT-001 V0.1 - kit operateur E4

Date de preparation : 10-09-2026.

Statut : kit documentaire candidat. Il prepare l'execution autorisee pour le 11-09-2026 de 14:00 a 22:00 Europe/Zurich, sans lancer une phase, creer une ressource, installer un outil, ouvrir une connexion ou engager une depense.

## Finalite

Fournir une feuille unique pour conduire, arreter, nettoyer et rapporter la recette PostgreSQL ephemere E4. Le cadrage `BUDGET-T1-D-B-3-B-E4-001 V0.1` reste la source normative ; ce kit n'en change ni les trente-six controles ni les frontieres.

## Identification de la session

| Champ | Valeur initiale |
| --- | --- |
| reference | `BUDGET-T1-D-B-3-B-E4-RUN-001` |
| date | 11-09-2026 |
| fenetre | 14:00-22:00 Europe/Zurich |
| responsable humain | Cheikh |
| operateur technique | Codex |
| fournisseur et offre | Supabase Pro, a revalider avant toute depense |
| region | Zurich `eu-central-2` |
| plafond absolu | 35 USD, taxes et frais compris |
| donnees | synthetiques uniquement |
| verdict initial | `NON EXECUTE` |

Les references de compte, projet, branche, hote, utilisateur, IP et secret ne sont jamais inscrites dans ce document.

## Prevol avant 14:00

Ce prevol est documentaire. Les constats techniques ou commerciaux sont interdits avant l'ouverture effective de P0.

- [ ] laptop alimente et espace de travail ferme aux donnees reelles ;
- [ ] Cheikh disponible pour authentification, conditions et paiement ;
- [ ] plafond de 35 USD et fin de fenetre a 22:00 rappeles ;
- [ ] documents E3, E4 et P0 accessibles localement ;
- [ ] emplacement ephemere de preuve et regle de suppression identifies ;
- [ ] production, routes, IAM M3S, preview applicative et Budget personnel confirmes hors perimetre.

Une case manquante maintient P0 en `NO-GO`.

## Tableau de conduite P0 a P7

| Phase | Controles de reference | Intervention humaine | Porte de sortie | Etat initial |
| --- | --- | --- | --- | --- |
| P0 | `E4-01`, `3B-01` a `3B-03` | confirmer fenetre, responsables et bornes | decision horodatee complete | `NON EXECUTE` |
| P1 | `E4-02` | verifier offre, conditions et paiement | cout engage inferieur ou egal a 35 USD | `NON EXECUTE` |
| P2 | `E4-03` a `E4-05`, `E4-09`, `3B-06` | confirmer l'usage temporaire de l'IPv4 | outils, SSL et `/32` conformes | `NON EXECUTE` |
| P3 | `E4-06`, `E4-07`, `3B-04` a `3B-12` | aucune sauf authentification imposee | deux cibles neuves et trois roles bornes | `NON EXECUTE` |
| P4 | `3B-13` a `3B-15` | aucune | schema, fixtures et vingt controles `3-A` conformes | `NON EXECUTE` |
| P5 | `E4-08`, `3B-16` a `3B-18` | aucune | dump borne et restauration exacte | `NON EXECUTE` |
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

Le rapport final reprend une ligne par controle avec : ID, statut, heure, preuve nettoyee, reserve et decision de passage. Une preuve absente interdit le statut `REUSSI`.

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
| phases atteintes | P0 a P7 |
| controles | total par statut |
| source et restauration | comptes et empreintes uniquement |
| cout final | montant USD |
| nettoyage | complet, incomplet ou non applicable |
| ecarts | references nettoyees |
| verdict technique | `GO`, `NO-GO` ou `INDETERMINE` |

Le verdict technique ne vaut ni activation Budget ni autorisation d'une etape ulterieure.

## Verdict du kit V0.1

- **Kit operateur :** `PRET A REVOIR`.
- **Execution actuelle :** `NON EXECUTE`.
- **Ressource, outil, compte, secret ou depense cree :** aucun.
- **Fenetre autorisee :** 11-09-2026, 14:00-22:00 Europe/Zurich.
- **Prochaine action :** confirmer ou amender le kit ; son eventuelle fusion restera documentaire.
