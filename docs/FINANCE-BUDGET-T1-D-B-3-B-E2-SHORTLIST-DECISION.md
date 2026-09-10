# BUDGET-T1-D-B-3-B-E2-001 V0.1 - decision de liste courte

Date de decision : 10-09-2026.

Statut : decision E2 prononcee par Cheikh ; releve documentaire candidat a confirmer ou amender avant fusion. Cette decision confirme la liste courte et ses reserves. Elle ne selectionne aucun fournisseur ou offre et n'autorise ni E3, E4, compte, essai, depense, secret, cible, installation, connexion, IAM, migration ou execution.

## Decision E2

La liste courte est limitee aux deux fournisseurs recherches en E1, dans l'ordre suivant :

| Rang | Fournisseur | Position E2 confirmee | Acces futur a E3 |
| ---: | --- | --- | --- |
| 1 | Supabase | candidat prioritaire sous reserves | admissible a une future instruction E3, sans selection actuelle |
| 2 | Neon | candidat secondaire ajourne par la porte reseau | ferme tant que la restriction reseau n'est pas disponible a un cout acceptable |

Neon reste inscrit en second rang pour conserver une solution de repli et une comparaison tracable. Son inscription ne leve pas son ajournement et ne le rend pas selectionnable sous les conditions actuellement observees.

## Reserves obligatoires pour Supabase

| ID | Reserve a fermer avant toute execution | Porte minimale |
| --- | --- | --- |
| E2-SUP-01 | confirmer une adresse CIDR fixe et appliquer la restriction avant toute connexion | E3 |
| E2-SUP-02 | verifier la compatibilite IPv6 ou une solution IPv4 bornee du futur runner | E3 |
| E2-SUP-03 | limiter le dump au schema et aux deux tables V2 autorises, sans schema gere du fournisseur | E3 |
| E2-SUP-04 | definir trois roles distincts : proprietaire ephemere, migration et runtime DML limite | E3 |
| E2-SUP-05 | confirmer une region acceptable pour des donnees exclusivement synthetiques | E3 |
| E2-SUP-06 | fixer un plafond total incluant branche, compute, stockage, egress, taxes et options | E3 |
| E2-SUP-07 | borner la duree de vie des deux environnements et definir la preuve de suppression | E3 |
| E2-SUP-08 | nommer separement les responsables de creation, controle et nettoyage | E4 |

Le fait que les branches ne soient pas couvertes par le Spend Cap reste une reserve de cout bloquante tant que le plafond total n'est pas fixe.

## Conditions de reexamen de Neon

Neon ne peut revenir comme candidat selectionnable que si les conditions cumulatives suivantes sont documentees sur une source officielle actuelle :

1. restriction IP ou reseau prive disponible avant toute connexion ;
2. cout total compatible avec le plafond qui sera fixe en E3 ;
3. parent vierge et donnees strictement synthetiques ;
4. `pg_dump` et `pg_restore` sur connexions non groupees ;
5. roles minimaux, duree et suppression verifiable conformes au cadrage.

La regle 2SG d'absence d'accessibilite publique n'est pas amendee par cette decision.

## Conditions communes maintenues

- Deux environnements neufs et ephemeres : source et restauration.
- Aucune donnee reelle, personnelle, financiere ou issue de production.
- `psql`, `pg_dump` et `pg_restore` disponibles sur un runner autorise sans installation implicite sur le laptop.
- Secrets temporaires hors depot et hors journal documentaire.
- Runtime limite au DML sur les deux tables V2.
- Sauvegarde, restauration, controles de roles et nettoyage executes seulement apres E4.
- Preuve finale de suppression des environnements, secrets et artefacts.

## Portes apres E2

| Porte | Etat apres la decision | Contenu autorise |
| --- | --- | --- |
| E2 | confirmee | liste courte et reserves seulement |
| E3 | fermee | aucune selection de fournisseur, offre, region ou cout |
| E4 | fermee | aucune creation de compte, cible, secret ou execution |

La prochaine decision humaine pourra uniquement autoriser la preparation d'un paquet candidat E3. Elle ne devra pas etre interpretee comme une selection, une depense ou une autorisation d'executer.

## Tracabilite

- Cadrage de recette : `BUDGET-T1-D-B-3-B-001 V0.1`.
- Decision de categorie : `BUDGET-T1-D-B-3-B-ENV-001 V0.1`.
- Recherche officielle : `BUDGET-T1-D-B-3-B-E1-001 V0.1`.
- Decision presente : `BUDGET-T1-D-B-3-B-E2-001 V0.1`.

## Verdict E2 V0.1

- **Liste courte :** confirmee, deux fournisseurs exactement.
- **Priorite :** Supabase sous huit reserves.
- **Repli :** Neon ajourne par la porte reseau.
- **Fournisseur ou offre selectionne :** aucun.
- **E3 et E4 :** fermes.
- **Etat operationnel :** `NO-GO` maintenu.
