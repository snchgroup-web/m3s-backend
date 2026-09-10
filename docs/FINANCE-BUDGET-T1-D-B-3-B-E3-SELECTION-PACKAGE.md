# BUDGET-T1-D-B-3-B-E3-001 V0.1 - paquet candidat de selection

Date de preparation : 10-09-2026.

Statut : paquet E3 candidat a confirmer ou amender. Il propose un fournisseur, une offre, un perimetre, un cout plafond et des conditions de securite pour une future recette PostgreSQL ephemere. Il ne prononce aucune selection et n'autorise ni E3, E4, compte, essai, depense, secret, cible, installation, connexion, IAM, migration ou execution.

Les preuves candidates de fermeture des quatre conditions sont regroupees dans `FINANCE-BUDGET-T1-D-B-3-B-E3-CLOSURE-EVIDENCE.md` (`BUDGET-T1-D-B-3-B-E3-EVD-001 V0.1`). Elles proposent une route via laptop client leger, pooler de session IPv4, CIDR `/32` ephemere, region Zurich et plafond de 35 USD, sans prononcer de selection.

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
| region | Zurich `eu-central-2` | candidate, a confirmer avant selection |
| acces reseau | IPv4 `/32` ephemere appliquee et verifiee avant toute connexion | amendement candidat |
| runner | laptop utilise seulement comme client PostgreSQL leger | candidat, aucune installation autorisee |
| nettoyage | suppression le jour meme avec preuve independante | obligatoire |
| fournisseur de repli | Neon | ajourne tant que la porte reseau reste ouverte |

Le plafond de 35 USD est une borne candidate prudente, non une autorisation de paiement. Il couvre le plan de base observe en E1, les deux branches ephemeres et une marge pour les frais variables. Toute depense exige une decision humaine distincte apres revalidation du prix total.

## Huit reserves Supabase a fermer

| ID | Reserve | Proposition de fermeture E3 | Etat |
| --- | --- | --- | --- |
| E2-SUP-01 | CIDR borne | epingler l'IPv4 active du laptop en `/32` avant toute connexion et arreter si elle change | amendement candidat |
| E2-SUP-02 | route PostgreSQL | retenir le pooler de session IPv4 `5432` officiellement supporte pour la migration | prete a confirmer |
| E2-SUP-03 | dump borne | autoriser seulement le schema et les deux tables V2 | cadrage pret |
| E2-SUP-04 | trois roles | proprietaire ephemere, migration et runtime DML limite | cadrage pret |
| E2-SUP-05 | region | confirmer Zurich `eu-central-2` et ses conditions | prete a confirmer |
| E2-SUP-06 | cout total | tarif revalide le 10-09-2026 ; confirmer le plafond absolu de 35 USD | prete a confirmer |
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

Le laptop est propose comme runner client leger, sans moteur PostgreSQL local ni Docker. Cette proposition doit etre confirmee avec l'amendement `/32` ephemere et devra cumuler :

1. IPv4 publique relevee au debut de la fenetre, non consignee et epinglee en `/32` ;
2. `psql`, `pg_dump` et `pg_restore` dans des versions compatibles ;
3. environnement ephemere ou nettoyable sans artefact persistant ;
4. journal sans mot de passe, URI de connexion ou contenu de donnees ;
5. verification de l'IPv4 avant chaque phase et arret immediat si elle change ;
6. absence d'installation implicite sur le laptop.

Un runner GitHub standard ou tout autre runner a plages dynamiques larges ne doit pas etre ajoute a l'allowlist. Le laptop reste seulement candidat tant que la decision E3 n'est pas prononcee.

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

1. laptop client et controle fail-closed de l'IPv4 `/32` acceptes ;
2. pooler de session IPv4 officiellement supporte accepte en remplacement de la connexion directe ;
3. region Zurich `eu-central-2` et conditions de traitement acceptees ;
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
