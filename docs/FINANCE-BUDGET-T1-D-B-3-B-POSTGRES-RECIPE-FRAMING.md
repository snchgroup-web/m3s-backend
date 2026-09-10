# BUDGET-T1-D-B-3-B-001 V0.1 - cadrage candidat de la preuve PostgreSQL complete

Date de preparation : 10-09-2026.

Statut : candidat documentaire a confirmer ou amender. Ce document compare des environnements et definit une matrice de recette. Il n'installe aucun outil, ne cree aucune cible, ne lance aucune commande, n'ouvre aucun acces et n'autorise ni donnee reelle, route HTTP, IAM reel, preview ou activation Budget.

## Decision recue

Le cadrage est limite :

1. a la matrice de recette PostgreSQL ephemere ;
2. au choix compare de l'environnement ;
3. aux garde-fous de sauvegarde, restauration, roles et nettoyage.

Toute installation, execution ou ouverture operationnelle exige une decision humaine ulterieure distincte.

## Position dans la trajectoire

| Element | Etat confirme | Portee probatoire |
| --- | --- | --- |
| `T1-D-B.3-A` | fusionne dans `main` via `2000437` | transactions, concurrence et audit sur PGlite en memoire |
| `T1-D-B.3-B` | cadrage seulement | PostgreSQL serveur complet, sauvegarde, restauration et moindre privilege |
| Routes, preview, frontend, production | fermes | aucune |

PGlite reste une preuve locale utile mais n'est pas un environnement candidat pour `3-B`. Les deux portes `3-A` et `3-B` sont cumulatives.

## Resultat attendu de 3-B

Une execution future recevable devra demontrer, avec des donnees exclusivement fictives :

- l'application du schema autorise sur une instance source neuve ;
- la separation entre proprietaire ephemere, migration et runtime ;
- l'impossibilite pour le runtime d'executer du DDL ;
- la sauvegarde logique puis la restauration sur une seconde instance neuve ;
- la conservation des donnees, contraintes, revisions et audits ;
- l'isolation tenant-auteur apres restauration ;
- la fermeture des instances et la suppression des artefacts temporaires.

Le resultat ne pourra etre que `GO technique candidat`, `GO sous reserves` ou `NO-GO`. Aucun de ces verdicts ne vaut activation Budget.

## Comparaison des environnements candidats

Echelle : 1 = defavorable, 3 = moyen, 5 = favorable. Les notes orientent l'arbitrage et ne constituent pas une selection.

| Option | Fidelite PostgreSQL | Isolation | Charge du poste | Gouvernance des acces | Nettoyage | Conditions prealables | Etat |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| A. Conteneur local ephemere | 5 | 5 | 2 | 4 | 5 | Docker ou Podman compatible, espace disque et memoire controles | non disponible sur le poste au 10-09-2026 |
| B. PostgreSQL local dedie | 5 | 3 | 2 | 4 | 3 | installation bornee, ports locaux, service et repertoire dedies | non disponible sur le poste au 10-09-2026 |
| C. Cible preview ephemere gouvernee | 5 | 5 | 5 | 2 | 4 | fournisseur, compte, secret, reseau, region, cout, duree de vie et responsable approuves | acces externe non autorise |

### Lecture candidate

- L'option A offre la meilleure reproductibilite locale, mais le moteur de conteneurs est absent et la charge du poste doit etre recontrolee.
- L'option B limite les dependances cloud, mais son installation et son nettoyage sont plus intrusifs.
- L'option C preserve les ressources du poste, mais ouvre des decisions supplementaires de fournisseur, secret, IAM, cout et sortie de donnees, meme fictives.
- Aucun fournisseur, produit, region ou offre commerciale n'est retenu dans cette version.

## Portes de recette

Toutes les portes sont obligatoires. Une porte non prouvee produit un `NO-GO` ou un `GO sous reserves` explicitement motive.

| Porte | Objet | Preuves minimales | Critere de fermeture |
| --- | --- | --- | --- |
| G0 | autorisation | cible et perimetre approuves, responsable nomme, echeance fixee | aucune creation avant decision |
| G1 | cible neuve | inventaire vide, marqueurs `non-production` et `synthetic-only` | aucun objet inattendu |
| G2 | versions et outils | version serveur et compatibilite de `psql`, `pg_dump`, `pg_restore` | versions consignees sans adresse ni secret |
| G3 | roles minimaux | proprietaire, migration et runtime distincts | runtime sans DDL ni gestion de roles |
| G4 | instance source | schema autorise, fixtures synthetiques, 20 controles `3-A` rejoues | aucune donnee ou identite reelle |
| G5 | sauvegarde et restauration | sauvegarde logique confinee, seconde instance neuve, restauration achevee | empreintes et comptes source/cible concordants |
| G6 | controles apres restauration | contraintes, revisions, audits, isolation et refus DDL | aucun ecart inexplique ou droit excessif |
| G7 | nettoyage | deux instances fermees, sauvegarde et secrets supprimes, rapport nettoye | aucune ressource de preuve residuelle |

## Matrice de controles candidate

### A. Pre-vol et cible

| ID | Controle | Resultat attendu |
| --- | --- | --- |
| `3B-01` | autorisation distincte de l'execution | reference et limites presentes |
| `3B-02` | responsable de creation et nettoyage | identite fonctionnelle nommee |
| `3B-03` | duree de vie | debut, expiration et marge de nettoyage fixes |
| `3B-04` | cible isolee | aucune connexion a une base M3S existante |
| `3B-05` | inventaire initial | base neuve, aucun objet inattendu |
| `3B-06` | exposition reseau | aucune accessibilite publique |

### B. Roles et moindre privilege

| ID | Controle | Resultat attendu |
| --- | --- | --- |
| `3B-07` | proprietaire ephemere | creation et suppression limitees a la preuve |
| `3B-08` | identite de migration | DDL limite au plan autorise |
| `3B-09` | identite runtime | connexion et DML sur les deux tables V2 uniquement |
| `3B-10` | refus de schema | creation, modification et suppression refusees au runtime |
| `3B-11` | refus d'administration | roles, extensions et bases refuses au runtime |
| `3B-12` | acces direct utilisateur | aucun utilisateur M3S directement connecte |

### C. Source, sauvegarde et restauration

| ID | Controle | Resultat attendu |
| --- | --- | --- |
| `3B-13` | schema source | catalogue et empreinte conformes au DDL autorise |
| `3B-14` | fixtures | tenants, acteurs, UUID, dates et montants synthetiques uniquement |
| `3B-15` | preuve transactionnelle | les 20 controles `3-A` restent conformes |
| `3B-16` | sauvegarde logique | artefact produit dans un espace ephemere confine |
| `3B-17` | instance de restauration | seconde cible neuve et inventoriee |
| `3B-18` | restauration | execution terminee sans objet additionnel |

### D. Concordance et nettoyage

| ID | Controle | Resultat attendu |
| --- | --- | --- |
| `3B-19` | comptes | memes nombres de brouillons et audits |
| `3B-20` | empreintes | empreintes nettoyees source/restauration identiques |
| `3B-21` | contraintes | unicite et references actives apres restauration |
| `3B-22` | isolation | aucune lecture ou mutation inter-tenant ou inter-auteur |
| `3B-23` | refus DDL apres restauration | runtime toujours prive de DDL |
| `3B-24` | suppression sauvegarde | aucun artefact logique residuel |
| `3B-25` | fermeture des cibles | source et restauration supprimees ou arretees |
| `3B-26` | rapport final | preuves nettoyees, limites et verdict consignes |

## Donnees admises

La recette future reprend exclusivement les fixtures de `3-A` :

- tenants `tenant-synthetic-a` et `tenant-synthetic-b` ;
- acteurs `actor-synthetic-a` et `actor-synthetic-b` ;
- UUID reserves au test ;
- montants artificiels ;
- libelles marques `Synthetic` ;
- dates fixes de recette.

Sont interdits : extraits Finance, budgets existants, noms de membres, justificatifs, taux reels, identifiants de production et copies de bases M3S.

## Regles de sauvegarde et de preuve

- La sauvegarde reste chiffree ou confinee a l'espace ephemere retenu.
- Aucun fichier de sauvegarde n'est joint a la PR ou au rapport partage.
- Les preuves publiees excluent chaine de connexion, secret, nom d'hote, utilisateur technique, adresse IP, commande complete et contenu financier.
- Les comparaisons utilisent des comptes, catalogues et empreintes non reversibles.
- Toute perte d'accuse, restauration partielle ou divergence d'empreinte est signalee ; aucune reprise automatique ne masque l'incertitude.

## Criteres d'arret immediat

La recette future doit s'arreter avant migration si :

- la cible contient un objet inattendu ;
- la cible est publique, partagee ou porte un nom de production ;
- un secret est expose dans la sortie ou le depot ;
- une donnee reelle est detectee ;
- les roles ne sont pas distincts ;
- le runtime dispose d'un droit DDL ou administratif ;
- le nettoyage ne peut pas etre garanti dans la fenetre autorisee.

Apres demarrage, tout ecart d'isolation, de contrainte, d'audit, de sauvegarde ou de restauration impose un arret controle et un `NO-GO` provisoire.

## Paquet de decision avant execution

La recommandation candidate de categorie d'environnement est portee par `FINANCE-BUDGET-T1-D-B-3-B-ENVIRONMENT-DECISION.md` (`BUDGET-T1-D-B-3-B-ENV-001 V0.1`).

Une prochaine decision humaine devra renseigner ensemble :

1. l'option A, B ou C retenue ;
2. le responsable de creation et de nettoyage ;
3. la date et la duree de vie maximales ;
4. les outils et versions autorises ;
5. le mode de gestion des secrets ;
6. la regle reseau et l'absence d'acces public ;
7. le cout maximal, si l'option C est retenue ;
8. l'autorisation ou le refus d'executer les 26 controles.

## Verdict du cadrage V0.1

- **Cadrage :** `PRET A REVOIR`.
- **Execution :** `NO-GO`, car aucune option n'est selectionnee et aucune installation, cible ou execution n'est autorisee.
- **Portes operationnelles :** routes, stockage reel, IAM reel, preview, frontend, production et Budget personnel restent fermes.
