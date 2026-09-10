# BUDGET-T1-D-B-3-001 V0.1 - cadrage candidat de la recette PostgreSQL isolee

Date de preparation : 09-09-2026.

Statut : candidat documentaire a confirmer ou amender. Ce document ne cree aucun adaptateur SQL, moteur, conteneur, compte, role, secret, sauvegarde ou cible partagee. Il ne lance aucune recette et n'autorise ni installation, acces cloud, IAM reel, migration partagee, donnee reelle, route HTTP, preview ou activation Budget.

## Finalite

T1-D-B.3 doit determiner si PostgreSQL peut devenir le stockage transactionnel V2 candidat en prouvant, avec des donnees strictement fictives :

1. l'unicite effective et le compare-and-swap concurrent ;
2. l'atomicite entre brouillon courant et evenement d'audit ;
3. l'isolation tenant-auteur pour les lectures et les ecritures ;
4. la classification sure des echecs certains et resultats incertains ;
5. la sauvegarde et la restauration d'une cible complete ;
6. la separation entre identite de migration et identite runtime ;
7. le nettoyage integral des ressources de preuve.

T1-D-B.3 ne rend pas encore Budget visible. Son issue peut seulement etre `GO technique candidat`, `GO sous reserves` ou `NO-GO`. Une cible preview, des routes et une interface exigent des decisions ulterieures distinctes.

## Etat acquis

| Porte | Resultat livre |
| --- | --- |
| `T1-D-B.1` | adaptateur logique pur et contrats de stockage |
| `T1-D-B.2-A` | DDL PostgreSQL V2 hors ligne et catalogue ferme |
| `T1-D-B.2-B` | planificateur cible, expire et autorise |
| `T1-D-B.2-C` | application unique du DDL sur PGlite en memoire |
| `T1-D-B.3` | recette fonctionnelle et operationnelle encore fermee |

Les preuves de T1-D-B.2-C confirment uniquement l'applicabilite du schema : PostgreSQL PGlite 18.3, transaction DDL, controle de catalogue, annulation certaine et anti-rejeu local. Elles ne prouvent ni l'adaptateur de donnees, ni la concurrence metier, ni la sauvegarde, ni les roles d'un serveur PostgreSQL complet.

## Decision de decoupage

La recette est separee en deux portes obligatoires.

### T1-D-B.3-A - preuve transactionnelle locale

T1-D-B.3-A utilise PGlite en memoire et doit produire :

- un executeur SQL compatible avec l'interface T1-D-B.1 ;
- les requetes parametrees de lecture, liste, creation et remplacement ;
- l'ecriture atomique du brouillon courant et de son audit ;
- les preuves de collision, compare-and-swap, isolation et interruption ;
- une matrice de resultats nettoyee et reproductible.

Cette porte n'installe rien, n'ouvre aucun port et ne prouve pas les roles ou la restauration d'un serveur complet.

### T1-D-B.3-B - preuve PostgreSQL complete

T1-D-B.3-B exige une instance PostgreSQL ephemere complete avec outils clients compatibles. Elle doit produire :

- une sauvegarde logique puis une restauration sur une seconde instance neuve ;
- l'inventaire avant et apres restauration ;
- des identites distinctes de migration et runtime ;
- la preuve que le runtime ne peut executer aucun DDL ;
- la preuve que les donnees, contraintes et audits fictifs sont conserves ;
- la fermeture et le nettoyage des deux instances.

T1-D-B.3-B reste ferme tant qu'un environnement ephemere adapte n'est pas choisi et explicitement autorise.

Le cadrage detaille candidat de cette porte est porte par `FINANCE-BUDGET-T1-D-B-3-B-POSTGRES-RECIPE-FRAMING.md` (`BUDGET-T1-D-B-3-B-001 V0.1`).

Les deux portes sont cumulatives. La reussite de 3-A seule ne permet pas de prononcer le `GO technique candidat` de T1-D-B.3.

## Constat d'environnement au 09-09-2026

Le poste de travail ne dispose actuellement d'aucun des outils suivants dans son chemin executable :

- Docker ;
- Podman ;
- `psql` ;
- `pg_dump` ;
- `pg_restore`.

Ce constat n'est pas un blocage de T1-D-B.3-A. Il bloque seulement toute execution credible de T1-D-B.3-B sur ce poste dans l'etat actuel.

Aucun outil ne sera installe automatiquement. Une future decision devra choisir entre un conteneur local, un PostgreSQL local dedie ou une cible preview ephemere gouvernee, puis nommer le responsable, la duree de vie, les secrets et le nettoyage.

## Perimetre de T1-D-B.3-A

### Executeur SQL candidat

L'executeur concret doit implementer les operations deja fermees par T1-D-B.1 :

```text
probe
getCurrent
scanCurrent
loadCurrent
findPromotionLinks
createAtomic
replaceAtomic
```

Il recoit une session PGlite en memoire deja initialisee et conforme. Il ne cree ni schema, ni table, ni client. Il ne lit aucun fichier, secret ou variable d'environnement et n'est jamais importe par `server.js`.

Toutes les valeurs metier utilisent des parametres lies. Les seuls identifiants SQL admissibles sont les noms fixes livres par T1-D-B.2-A.

### Lecture unitaire

`getCurrent` doit :

- filtrer par `tenant_id`, `author_user_id`, `id` et `contract_version = 2` ;
- limiter le resultat a deux lignes pour detecter une corruption ;
- ne jamais chercher un identifiant dans une autre portee ;
- restituer uniquement les colonnes attendues par T1-D-B.1.

### Liste et chargement paresseux

`scanCurrent` doit :

- filtrer par tenant, auteur et version de contrat ;
- ordonner par `updated_at DESC, id ASC` ;
- utiliser un curseur lie aux deux champs d'ordre ;
- limiter chaque lot a 50 positions ;
- ne selectionner que `id`, `updated_at` et `document_bytes`.

`loadCurrent` charge ensuite un seul document, dans la meme portee et avec le meme `updated_at`. Une divergence rend le stockage indisponible ; aucune page partielle n'est acceptee.

### Creation atomique

Dans une transaction `READ COMMITTED` unique :

1. inserer la ligne courante avec `version = 1` ;
2. inserer l'evenement `budget_v2_draft_created` ;
3. confirmer le commit ;
4. retourner `created` uniquement apres confirmation.

Une violation certaine de la cle primaire retourne `duplicate`. Aucun `UPSERT`, remplacement implicite ou rejeu n'est autorise.

### Remplacement compare-and-swap

Dans une transaction `READ COMMITTED` unique :

1. mettre a jour la ligne de la portee complete avec `version = expectedVersion` ;
2. exiger exactement une ligne affectee ;
3. inserer l'evenement `budget_v2_draft_updated` ;
4. confirmer le commit ;
5. retourner `updated` uniquement apres confirmation.

Zero ligne affectee impose une lecture bornee dans la meme portee pour distinguer `missing` de `conflict`. Aucun resultat ne doit reveler l'existence d'un brouillon hors portee.

### Resultats fermes

Les seules issues admises restent :

```text
created | updated | missing | conflict | duplicate | unavailable | uncertain
```

Une erreur avant transaction est `unavailable`. Une violation certaine ou zero ligne affectee est classee selon le contrat. Toute perte de preuve du commit est `uncertain`, sans nouvelle tentative automatique.

## Matrice de preuve T1-D-B.3-A

### Unicite et concurrence

1. deux creations concurrentes de la meme cle produisent exactement un `created` et un `duplicate` ;
2. deux remplacements concurrents de la meme version produisent exactement un `updated` et un `conflict` ;
3. la version finale est incrementee une seule fois ;
4. aucun audit supplementaire n'est cree par le perdant.

### Atomicite

5. un echec apres insertion du brouillon mais avant l'audit annule les deux ;
6. un echec apres insertion de l'audit mais avant commit annule les deux ;
7. aucun brouillon courant ne subsiste sans evenement correspondant ;
8. aucun evenement ne subsiste sans brouillon courant correspondant.

### Isolation

9. deux tenants utilisant le meme auteur et le meme identifiant restent independants ;
10. deux auteurs d'un tenant utilisant le meme identifiant restent independants ;
11. lecture, liste, chargement et mise a jour hors portee retournent l'absence sans fuite ;
12. les audits portent toujours le tenant et l'acteur de la mutation correspondante.

### Integrite et bornes

13. JSON, taille UTF-8, chronologie, domaines et cle etrangere sont imposes par le moteur ;
14. un document proche de 4 Mio reste lisible et un depassement est refuse ;
15. la pagination reste stable en cas d'horodatages egaux ;
16. le chargement paresseux ne materialise jamais tous les documents d'une liste.

### Interruption et observabilite

17. erreur avant ouverture de transaction : zero requete de mutation ;
18. erreur certaine dans la transaction : rollback et issue non incertaine ;
19. perte simulee d'accuse de commit : `uncertain` et aucune reprise ;
20. erreur et preuve ne contiennent ni document, identite, parametres SQL ou trace brute.

## Perimetre de T1-D-B.3-B

### Cible complete

La future cible doit etre :

- explicitement nommee `non-production` et `synthetic-only` ;
- isolee de toute base M3S existante ;
- creee pour une duree bornee ;
- inaccessible publiquement ;
- liee a un responsable de creation et de nettoyage ;
- inventoriee avant toute migration.

Une cible partagee, un nom de production ou une base contenant des objets inattendus est refusee.

### Roles minimaux

Trois responsabilites doivent etre distinguees :

| Identite | Droits candidats |
| --- | --- |
| proprietaire ephemere | creation et suppression de la base de preuve uniquement |
| migration | usage du schema et DDL limite au plan autorise |
| runtime | connexion, usage, lecture et mutations DML sur les deux tables V2 uniquement |

Le runtime ne doit pouvoir ni creer, modifier ou supprimer un schema, une table, un index, une fonction, un role ou une extension. Aucun utilisateur M3S n'accede directement a la base.

### Sauvegarde et restauration

La preuve doit suivre cet ordre :

1. appliquer le schema autorise sur une instance source neuve ;
2. injecter uniquement les fixtures fictives de 3-A ;
3. calculer inventaires, comptes et empreintes non sensibles ;
4. produire une sauvegarde logique chiffree ou confinee a l'espace ephemere ;
5. restaurer sur une seconde instance neuve ;
6. reexecuter les validations de schema, contraintes, lignes et audits ;
7. comparer les empreintes source/restauration ;
8. supprimer les artefacts de sauvegarde et fermer les deux instances.

Le rapport partage ne contient ni sauvegarde, chaine de connexion, secret, nom d'hote, utilisateur ou contenu financier.

## Regles de donnees fictives

Les fixtures utilisent uniquement :

- tenants `tenant-synthetic-a` et `tenant-synthetic-b` ;
- auteurs `actor-synthetic-a` et `actor-synthetic-b` ;
- UUID reserves au test ;
- montants artificiels sans correspondance avec 2SG ;
- libelles explicitement marques `Synthetic` ;
- dates fixes de recette.

Aucun extrait Finance, budget existant, nom de membre, justificatif, taux reel ou identifiant de production n'est admis.

## Preuve finale candidate

Le rapport T1-D-B.3 doit regrouper :

- revision du code et contrats verifies ;
- moteur et version sans adresse technique ;
- matrice des 20 controles de 3-A ;
- matrice de sauvegarde, restauration et droits de 3-B ;
- nombres de brouillons et audits fictifs ;
- empreintes nettoyees avant/apres ;
- incidents, reserves et limites connues ;
- confirmation de fermeture des instances et suppression des artefacts ;
- verdict `GO technique candidat`, `GO sous reserves` ou `NO-GO`.

Le verdict ne vaut ni activation, ni autorisation de cible preview, ni mise en production.

## Criteres d'arret

Le paquet repasse en `NO-GO` si :

- la cle composite ou le compare-and-swap n'impose pas un gagnant unique ;
- mutation et audit peuvent diverger ;
- un resultat incertain declenche une nouvelle tentative ;
- une requete peut omettre tenant ou auteur ;
- PGlite exige un fichier ou un acces reseau pour 3-A ;
- 3-B doit reutiliser une cible ou une identite de production ;
- le runtime conserve un droit DDL ou un droit sur une autre base ;
- la restauration perd une contrainte, une ligne ou un evenement ;
- un secret ou une donnee reelle entre dans le depot ou la preuve ;
- une ressource ou sauvegarde ephemere ne peut pas etre supprimee ;
- la preuve exige d'ouvrir une route, une preview ou le Budget personnel.

## Trajectoire apres T1-D-B.3

Apres reussite et decision distincte seulement :

1. prononcer le choix du moteur transactionnel candidat ;
2. cadrer un fournisseur et une cible preview isolee ;
3. preparer IAM, secrets, sauvegarde et observabilite preview ;
4. raccorder l'adaptateur derriere une capacite fermee ;
5. ouvrir les routes V2 en deploy preview ;
6. connecter le frontend Budget ;
7. effectuer la recette desktop/mobile ;
8. demander une autorisation separee avant toute production.

## Arbitrage groupe candidat

Confirmer ou amender `BUDGET-T1-D-B-3-001 V0.1` en une decision unique :

1. separer T1-D-B.3 en portes cumulatives 3-A et 3-B ;
2. limiter 3-A a PGlite en memoire, aux donnees fictives et a l'adaptateur SQL ;
3. reserver 3-B a un PostgreSQL complet ephemere avec outils de sauvegarde et roles ;
4. ne pas installer implicitement Docker, PostgreSQL ou un outil systeme ;
5. imposer la matrice des 20 controles transactionnels de 3-A ;
6. imposer sauvegarde, restauration et moindre privilege dans 3-B ;
7. interdire toute donnee reelle, cible partagee, route ou activation ;
8. autoriser apres confirmation uniquement le micro-lot T1-D-B.3-A sur branche isolee, avec tests et PR jusqu'au verdict propre, sans fusion automatique ;
9. maintenir fermes T1-D-B.3-B, choix fournisseur, cible preview, IAM reel, routes, frontend et production ;
10. maintenir T1-E et le Budget personnel hors perimetre.

La confirmation de ce paquet valide uniquement le cadrage. Elle n'autorise ni implementation, fusion, installation d'outil, cible PostgreSQL complete, sauvegarde, IAM, preview ou activation.

## Sources internes

- `docs/FINANCE-BUDGET-T1-D-B-STORAGE-CONTRACT.md`
- `docs/FINANCE-BUDGET-T1-D-B-2-ENGINE-MIGRATION-CONTRACT.md`
- `docs/FINANCE-BUDGET-T1-D-B-2-C-EPHEMERAL-EXECUTOR-CONTRACT.md`
- `financeBudgetV2StorageAdapter.js`
- `financeBudgetV2Writes.js`
- `financeBudgetV2PostgresSchema.js`
- `financeBudgetV2PostgresMigrationPlanner.js`
- `financeBudgetV2PostgresEphemeralExecutor.js`
- `tests/financeBudgetV2StorageAdapter.test.js`
- `tests/financeBudgetV2Writes.test.js`
- `tests/financeBudgetV2PostgresEphemeralExecutor.test.js`
