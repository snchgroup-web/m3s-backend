# BUDGET-T1-D-B-3-B-E3-001 V0.1 - paquet candidat de selection

Date de preparation : 10-09-2026.

Statut : paquet E3 candidat a confirmer ou amender. Il propose un fournisseur, une offre, un perimetre, un cout plafond et des conditions de securite pour une future recette PostgreSQL ephemere. Il ne prononce aucune selection et n'autorise ni E3, E4, compte, essai, depense, secret, cible, installation, connexion, IAM, migration ou execution.

## Proposition groupee E3

| Champ | Valeur candidate | Etat |
| --- | --- | --- |
| fournisseur | Supabase | candidat E3, non selectionne |
| offre | Pro avec deux preview branches Micro | a revalider officiellement |
| finalite | recette PostgreSQL serveur de `T1-D-B.3-B` | bornee aux vingt-six controles |
| donnees | synthetiques uniquement | obligatoire |
| environnements | deux branches neuves : source et restauration | obligatoire |
| duree maximale | huit heures sur une meme journee | candidate |
| plafond total | 35 USD, taxes, compute, stockage et egress compris | candidat, aucune depense autorisee |
| region | region europeenne officiellement disponible et acceptable | a nommer avant selection |
| acces reseau | CIDR fixe applique avant toute connexion | bloquant |
| runner | runner controle avec sortie reseau fixe et outils PostgreSQL disponibles | a identifier |
| nettoyage | suppression le jour meme avec preuve independante | obligatoire |
| fournisseur de repli | Neon | ajourne tant que la porte reseau reste ouverte |

Le plafond de 35 USD est une borne candidate prudente, non une autorisation de paiement. Il couvre le plan de base observe en E1, les deux branches ephemeres et une marge pour les frais variables. Toute depense exige une decision humaine distincte apres revalidation du prix total.

## Huit reserves Supabase a fermer

| ID | Reserve | Proposition de fermeture E3 | Etat |
| --- | --- | --- | --- |
| E2-SUP-01 | CIDR fixe | fournir le CIDR du runner avant creation | bloquante |
| E2-SUP-02 | IPv6 ou IPv4 bornee | prouver la compatibilite du runner avec la connexion directe | bloquante |
| E2-SUP-03 | dump borne | autoriser seulement le schema et les deux tables V2 | cadrage pret |
| E2-SUP-04 | trois roles | proprietaire ephemere, migration et runtime DML limite | cadrage pret |
| E2-SUP-05 | region | confirmer une region europeenne et ses conditions | bloquante |
| E2-SUP-06 | cout total | revalider le tarif et confirmer le plafond de 35 USD | bloquante |
| E2-SUP-07 | duree et suppression | huit heures maximum, suppression et controle le jour meme | cadrage pret |
| E2-SUP-08 | responsables | repartir creation, execution, controle et nettoyage | a confirmer en E4 |

## Roles candidats

| Responsabilite | Candidat | Limite |
| --- | --- | --- |
| arbitrage et autorisation | Cheikh | aucune action technique implicite |
| preparation et execution technique | Codex | uniquement apres E4 explicite |
| controle des resultats | Cheikh avec rapport Codex | aucune acceptation automatique |
| nettoyage technique | Codex | suppression uniquement apres E4 explicite |
| confirmation du nettoyage | Cheikh | preuve sans secret ni donnee sensible |

Cette repartition est candidate. L'independance du controle repose sur une validation humaine distincte du rapport et des preuves de nettoyage.

## Runner candidat

Le runner ne peut pas etre selectionne tant que sa sortie reseau fixe n'est pas prouvee. Il devra cumuler :

1. adresse de sortie IPv4 ou IPv6 stable et documentee ;
2. `psql`, `pg_dump` et `pg_restore` dans des versions compatibles ;
3. environnement ephemere ou nettoyable sans artefact persistant ;
4. journal sans mot de passe, URI de connexion ou contenu de donnees ;
5. acces limite a la fenetre de huit heures ;
6. absence d'installation implicite sur le laptop.

Un runner GitHub heberge ou tout autre runner a plages d'adresses dynamiques ne doit pas etre presume compatible avec le CIDR fixe. Aucun runner n'est retenu par ce paquet.

## Paquet de cout candidat

| Poste | Borne candidate | Regle |
| --- | ---: | --- |
| offre de base | 25 USD | valeur observee en E1, a revalider |
| deux branches Micro pendant huit heures | environ 0,22 USD | calcul indicatif hors stockage et egress |
| marge taxes, stockage, egress et options | 9,78 USD maximum | ne peut pas etre depassee |
| plafond total | 35 USD | aucun paiement sans autorisation distincte |

Calcul indicatif des branches : `2 x 8 x 0,01344 USD = 0,21504 USD`. Les branches n'etant pas couvertes par le Spend Cap selon la recherche E1, une alerte manuelle et une suppression verifiee restent obligatoires.

## Conditions de selection E3

La selection ne pourra etre prononcee que si les quatre conditions bloquantes sont fermees ensemble :

1. runner et CIDR fixe identifies ;
2. compatibilite de connexion directe prouvee ;
3. region europeenne exacte et conditions de traitement acceptees ;
4. prix officiel revalide et plafond total confirme.

Si une condition echoue, E3 reste ajournee et l'option A, conteneur local ephemere, demeure le repli de categorie deja classe en E0. Neon ne revient pas automatiquement dans la selection.

## Portes apres preparation

| Porte | Etat | Effet |
| --- | --- | --- |
| E2 | confirmee et livree | liste courte acquise |
| E3 | fermee, paquet candidat prepare | aucune selection actuelle |
| E4 | fermee | aucune creation ni execution |

Une future confirmation du present paquet devra distinguer :

- la confirmation du cadrage E3 ;
- la fermeture documentee des quatre conditions bloquantes ;
- la selection explicite du fournisseur et de l'offre.

Aucune de ces decisions ne vaut ouverture E4.

## Tracabilite

- Cadrage de recette : `BUDGET-T1-D-B-3-B-001 V0.1`.
- Decision de categorie : `BUDGET-T1-D-B-3-B-ENV-001 V0.1`.
- Recherche officielle : `BUDGET-T1-D-B-3-B-E1-001 V0.1`.
- Liste courte : `BUDGET-T1-D-B-3-B-E2-001 V0.1`.
- Paquet candidat : `BUDGET-T1-D-B-3-B-E3-001 V0.1`.

## Verdict candidat

- **Paquet E3 :** pret pour arbitrage groupe.
- **Fournisseur et offre candidats :** Supabase Pro avec deux preview branches Micro.
- **Conditions bloquantes :** quatre, non fermees.
- **Fournisseur ou offre selectionne :** aucun.
- **Compte, cout ou cible autorise :** aucun.
- **E3 et E4 :** fermees.
- **Etat operationnel :** `NO-GO` maintenu.
