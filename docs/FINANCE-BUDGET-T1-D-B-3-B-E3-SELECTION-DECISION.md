# BUDGET-T1-D-B-3-B-E3-DEC-001 V0.1 - decision candidate de selection

Date de preparation : 10-09-2026.

Statut : proposition de decision E3 a prononcer explicitement. Elle rassemble les valeurs candidates deja confirmees mais ne selectionne encore aucun fournisseur ou offre. Elle n'autorise ni E4, compte, essai, depense, secret, cible, installation, connexion, IAM, migration ou execution.

## Fondements acquis

| Fondement | Decision acquise |
| --- | --- |
| E0 | option C, cible preview ephemere gouvernee, prioritaire ; option A en repli |
| E1 | recherche officielle limitee a Supabase et Neon |
| E2 | Supabase prioritaire sous reserves ; Neon secondaire ajourne par la porte reseau |
| paquet E3 | offre, duree, cout, region, reseau, runner, roles et nettoyage cadres |
| preuves E3 | laptop client leger, IPv4 `/32`, pooler de session, Zurich et plafond de 35 USD acceptes comme valeurs candidates |

## Selection E3 proposee

| Champ | Valeur a selectionner | Portee exacte |
| --- | --- | --- |
| fournisseur | Supabase | uniquement pour preparer une future recette E4 |
| offre | Pro | aucun abonnement ou paiement autorise par E3 |
| ressources | deux preview branches Micro | source et restauration, toutes deux neuves |
| region | Zurich `eu-central-2` | donnees synthetiques uniquement |
| runner | laptop 2SG comme client PostgreSQL leger | aucun serveur local ni Docker |
| route | pooler de session IPv4 sur le port `5432` | SSL et `/32` obligatoires avant connexion |
| reseau | IPv4 publique active epinglee en `/32` | non consignee ; arret si elle change |
| duree | huit heures maximum sur une meme journee | suppression le jour meme |
| plafond | 35 USD au total | aucune depense sans autorisation E4 distincte |
| repli | option A, conteneur local ephemere | reste ferme et non installe |

## Effet limite d'une future decision E3

Si cette selection est prononcee :

1. Supabase Pro devient le fournisseur et l'offre retenus pour instruire E4 ;
2. les valeurs du tableau deviennent les seules bornes admissibles ;
3. Neon reste ajourne et l'option A reste le repli non ouvert ;
4. E3 devient fermee et acquise sur le plan decisionnel ;
5. E4 reste fermee et aucune operation externe ne peut commencer.

La decision E3 ne cree aucun droit d'acces et ne vaut ni engagement commercial, ni acceptation de conditions contractuelles, ni autorisation de paiement.

## Controles reportes a E4

| ID | Controle obligatoire avant ou pendant E4 | Echec |
| --- | --- | --- |
| E4-01 | revalider offre, prix, region et fonctions sur les sources officielles | `STOP` |
| E4-02 | presenter le montant total et obtenir l'autorisation de depense | `STOP` |
| E4-03 | relever l'IPv4 sans l'ecrire dans le depot, le journal ou un artefact partage | `STOP` |
| E4-04 | appliquer uniquement le `/32` et verifier la restriction avant toute connexion | `STOP` |
| E4-05 | autoriser separement l'installation des seuls clients PostgreSQL compatibles | `STOP` |
| E4-06 | creer deux environnements neufs, ephemeres et sans donnees de production | `STOP` |
| E4-07 | separer proprietaire, migration et runtime DML limite | `STOP` |
| E4-08 | borner le dump au schema et aux deux tables V2 | `STOP` |
| E4-09 | verifier l'IPv4 avant chaque phase et interrompre si elle change | `STOP` |
| E4-10 | supprimer branches, secrets et outils temporaires puis verifier le cout final | `STOP` |

Ces controles completent les vingt-six controles de `BUDGET-T1-D-B-3-B-001 V0.1` ; ils ne les remplacent pas.

## Criteres d'arret immediat

- Montant affiche superieur a 35 USD ou frais non bornes.
- Region Zurich indisponible ou remplacee sans arbitrage.
- Restriction `/32` absente, non verifiable ou elargie.
- Changement de l'adresse IPv4 pendant la fenetre.
- Outil client incompatible ou exigeant Docker.
- Donnee autre que synthetique.
- Role runtime capable d'executer du DDL.
- Nettoyage impossible a prouver le jour meme.

## Etats des portes

| Porte | Etat avant decision | Etat si la selection est prononcee |
| --- | --- | --- |
| E2 | confirmee et livree | inchangee |
| E3 | fermee en attente de decision | selection acquise et porte fermee |
| E4 | fermee | fermee, aucune execution implicite |

## Tracabilite

- Cadrage de recette : `BUDGET-T1-D-B-3-B-001 V0.1`.
- Decision de categorie : `BUDGET-T1-D-B-3-B-ENV-001 V0.1`.
- Recherche officielle : `BUDGET-T1-D-B-3-B-E1-001 V0.1`.
- Liste courte : `BUDGET-T1-D-B-3-B-E2-001 V0.1`.
- Paquet candidat E3 : `BUDGET-T1-D-B-3-B-E3-001 V0.1`.
- Preuves candidates E3 : `BUDGET-T1-D-B-3-B-E3-EVD-001 V0.1`.
- Decision candidate presente : `BUDGET-T1-D-B-3-B-E3-DEC-001 V0.1`.

## Verdict candidat

- **Decision E3 :** prete a etre prononcee en une fois.
- **Selection actuellement prononcee :** aucune.
- **Valeurs candidates :** confirmees.
- **E4 :** fermee.
- **Etat operationnel :** `NO-GO` maintenu.
