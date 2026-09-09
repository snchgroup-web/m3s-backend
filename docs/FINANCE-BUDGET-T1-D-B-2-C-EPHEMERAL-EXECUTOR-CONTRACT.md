# BUDGET-T1-D-B-2-C-001 V0.1 - cadrage candidat de l'executeur PostgreSQL ephemere

Date de preparation : 09-09-2026.

Statut : candidat documentaire a confirmer ou amender. Ce document ne cree aucun executeur, schema, table, compte, role ou secret. Il ne lance aucun moteur, n'execute aucun DDL et n'autorise ni acces cloud, IAM, migration partagee, donnee reelle, route HTTP, recette preview ou activation Budget.

## Finalite

T1-D-B.2-C doit prouver que le plan `planned-create` produit par T1-D-B.2-B peut etre applique une seule fois sur un moteur PostgreSQL local, ephemere et reserve aux donnees fictives, puis controle contre le catalogue ferme de T1-D-B.2-A.

Le lot ne constitue pas encore une preuve d'aptitude a la production. Il valide seulement la chaine technique minimale suivante :

```text
instance PostgreSQL embarquee en memoire
-> schema dedie vide cree par le harnais
-> inventaire atteste
-> plan ferme et autorisation exacte
-> transaction DDL unique
-> controle de catalogue apres application
-> preuve non sensible
-> fermeture de l'instance
```

## Position dans la trajectoire

| Porte | Objet | Etat apres ce cadrage |
| --- | --- | --- |
| `T1-D-B.2-A` | DDL PostgreSQL V2 hors ligne | livre dans `main` |
| `T1-D-B.2-B` | planificateur pur et autorisation liee | livre dans `main` |
| `T1-D-B.2-C` | application locale ephemere du plan | cadrage candidat uniquement |
| `T1-D-B.3` | concurrence, atomicite, restauration et moindre privilege | ferme |
| cible preview | PostgreSQL isole et gouverne | fermee |
| routes V2 | exposition backend authentifiee | fermees |
| frontend Budget | interface en deploy preview | ferme |
| production | stockage et interface publics | fermes |

La confirmation de ce document n'autorise pas a elle seule l'execution. Elle permettra seulement de proposer un micro-lot T1-D-B.2-C sur branche isolee. Son lancement devra etre explicitement autorise dans la meme decision ou dans une decision ulterieure.

## Cible ephemere candidate

Le moteur retenu pour cette preuve est `@electric-sql/pglite`, deja present comme dependance de developpement du backend et deja utilise par la validation locale REF-01.

Cette cible est adaptee a T1-D-B.2-C parce qu'elle :

- execute PostgreSQL dans le processus de test ;
- peut fonctionner entierement en memoire ;
- n'ouvre aucun port TCP ;
- ne demande ni serveur partage, ni compte cloud, ni secret ;
- disparait a la fermeture de l'instance ;
- reste exclue du demarrage normal de l'API.

PGlite ne vaut pas choix d'hebergement et ne remplace pas une recette ulterieure sur le moteur et le fournisseur reellement retenus. Toute divergence entre son comportement et PostgreSQL heberge devra etre consideree comme un risque a traiter dans T1-D-B.3.

## Separation des responsabilites

### Harnais local

Le harnais de test est seul autorise a :

1. creer une instance PGlite neuve en memoire ;
2. verifier la version PostgreSQL exposee et l'encodage UTF-8 ;
3. creer uniquement le schema vide `finance_budget_v2` ;
4. injecter la session SQL bornee au collecteur et a l'executeur ;
5. fermer l'instance dans un bloc de nettoyage garanti.

La creation du schema dedie appartient au harnais et ne doit pas etre ajoutee aux trois instructions T1-D-B.2-A. Aucun schema V1, objet applicatif existant ou fixture reelle n'est charge.

### Collecteur local

Le collecteur candidat `BUDGET-T1-D-B-2-COL-001` lit seulement les metadonnees necessaires au contrat :

- version majeure PostgreSQL ;
- encodage de la base ;
- existence et etat du schema dedie ;
- tables, colonnes, contraintes, relations et index du schema dedie ;
- vues, declencheurs, routines, extensions et droits inattendus.

Il ne lit jamais le contenu des tables. Sa sortie fermee doit etre acceptee par T1-D-B.2-B avant la production d'un plan.

### Planificateur

Le planificateur deja livre reste l'unique source des instructions admises. L'executeur ne lit aucun fichier SQL, ne reconstruit aucun DDL et n'accepte aucune instruction fournie separement.

### Executeur

L'executeur candidat recoit uniquement :

```text
executeBudgetV2PostgresEphemeralMigration({
  session,
  plan,
  authorization,
  executionContext,
  consumptionStore,
  inspectCatalog
})
```

Il ne cree ni client, ni moteur, ni schema. Il ne lit ni variable d'environnement, ni chaine de connexion, ni horloge, ni fichier. La session, l'instant et les interfaces sont injectes par le harnais.

## Contexte d'execution ferme

`executionContext` doit contenir exactement :

| Champ | Regle candidate |
| --- | --- |
| `executionRef` | identifiant fictif visible ASCII et borne |
| `targetRef` | egal au plan et a l'autorisation |
| `environment` | exactement `local-ephemeral` |
| `engine` | exactement `pglite-postgresql` |
| `dataClassification` | exactement `synthetic-only` |
| `startedAt` | instant UTC canonique fourni par le harnais |
| `deadlineAt` | au plus deux minutes apres `startedAt` |
| `networkMode` | exactement `none` |
| `storageMode` | exactement `memory-only` |

Il ne contient ni nom personnel, identifiant M3S reel, hote, port, utilisateur, mot de passe, URL ou jeton.

## Precontrole obligatoire

Avant toute requete DDL, l'executeur doit refuser si :

- le plan n'est pas `planned-create` ;
- le plan ou l'autorisation ne passent plus le validateur T1-D-B.2-B ;
- le plan est expire au regard de l'instant unique fourni ;
- la cible, le contexte et l'autorisation ne correspondent pas exactement ;
- les instructions ne sont pas exactement les trois instructions T1-D-B.2-A ;
- une instruction destructive ou supplementaire existe ;
- la session n'atteste pas une instance locale, en memoire et sans reseau ;
- l'empreinte du plan a deja ete reservee, appliquee ou classee incertaine ;
- le delai d'execution est invalide ou deja depasse.

Un refus de precontrole ne doit ouvrir aucune transaction et ne doit envoyer aucune requete SQL.

## Registre anti-rejeu

`consumptionStore` est un double en memoire, propre a une instance de test. Il expose une operation atomique de reservation de l'empreinte du plan et interdit toute seconde reservation.

Etats candidats :

| Etat | Signification |
| --- | --- |
| `reserved` | execution engagee, aucune nouvelle tentative admise |
| `applied` | commit confirme et catalogue post-application conforme |
| `failed` | echec certain avant commit, sans application persistante |
| `uncertain` | resultat du commit ou controle post-commit non prouvable |

Une empreinte `failed` ou `uncertain` n'est jamais rejouee automatiquement. Une nouvelle tentative exige un nouvel inventaire, un nouveau plan, une nouvelle empreinte et une nouvelle autorisation.

Ce registre local ne constitue pas le registre persistant d'une migration preview ou de production. Son seul role est de prouver le contrat anti-rejeu dans le lot ephemere.

## Transaction DDL unique

Apres reservation reussie, l'executeur doit :

1. ouvrir une transaction explicite ;
2. fixer le niveau `READ COMMITTED` ;
3. appliquer les trois instructions du plan dans leur ordre exact ;
4. collecter le catalogue dans la meme transaction ;
5. valider le catalogue avec T1-D-B.2-A ;
6. confirmer le commit ;
7. refaire un controle post-commit borne ;
8. marquer le plan `applied` uniquement si les deux controles sont conformes.

Aucune instruction n'est concatenee, reformatee ou derivee de l'entree utilisateur. Aucune reprise automatique n'est admise.

## Classification des resultats

L'executeur retourne une structure gelee, sans client, SQL ou exception brute.

### `applied`

Possible uniquement si :

- les trois instructions ont ete executees une fois ;
- le controle dans la transaction est conforme ;
- le commit est confirme ;
- le controle post-commit est conforme ;
- le registre est passe de `reserved` a `applied`.

### `failed`

Possible uniquement pour un echec certain avant commit avec annulation confirmee. La preuve indique l'etape fermee et l'empreinte, jamais le message SQL brut.

### `uncertain`

Obligatoire si le commit, la connexion logique, le controle post-commit ou l'etat du registre ne peut pas etre prouve. Ce resultat interdit toute nouvelle tentative avec le meme plan.

Il n'existe aucun resultat `partial`, `repaired`, `forced`, `retried` ou `best-effort`.

## Preuve non sensible

La preuve candidate contient exactement les informations utiles a la revue :

- identifiants des contrats T1-D-B.2-A, 2-B et 2-C ;
- reference d'execution fictive ;
- empreinte du plan ;
- reference logique de cible ;
- version majeure PostgreSQL ;
- instants de debut et de fin fournis ;
- nombre d'instructions attendues et appliquees ;
- empreintes des inventaires avant et apres ;
- resultat du validateur de catalogue ;
- etat final du registre anti-rejeu ;
- issue finale `applied`, `failed` ou `uncertain`.

La preuve exclut : SQL integral, contenu Budget, identite reelle, hote, chemin local, configuration, secret, trace de pile et exception brute.

## Nettoyage et retour arriere

Le retour arriere de T1-D-B.2-C repose sur la disparition de l'instance en memoire, pas sur un DDL destructif :

1. exporter la preuve non sensible en memoire pour assertion de test ;
2. fermer l'instance PGlite dans tous les cas ;
3. verifier qu'aucune reference de session ne reste accessible ;
4. ne produire aucun fichier de base ni artefact persistant ;
5. ne jamais ajouter `DROP`, `TRUNCATE`, `DELETE` ou migration descendante au plan.

La fermeture de l'instance n'est pas une preuve de sauvegarde ou de restauration. Ces controles restent dans T1-D-B.3.

## Recette candidate du futur micro-lot

1. l'instance est neuve, en memoire, sans reseau et fermee apres chaque scenario ;
2. le collecteur produit un inventaire ferme du schema vide ;
3. le planificateur produit `planned-create` avec trois instructions exactes ;
4. une autorisation exacte et non expiree permet une seule reservation ;
5. les trois instructions sont executees dans une transaction unique ;
6. le catalogue est conforme dans la transaction puis apres commit ;
7. une seconde consommation de la meme empreinte est refusee avant SQL ;
8. un plan bloque, no-op, modifie ou expire est refuse avant SQL ;
9. une cible, autorisation ou execution rattachee a une autre reference est refusee ;
10. une erreur certaine avant commit annule tous les objets et produit `failed` ;
11. une issue de commit non prouvable produit `uncertain` sans nouvelle tentative ;
12. aucune table V1, donnee reelle, route, variable d'environnement ou connexion reseau n'est utilisee ;
13. la preuve produite ne contient aucune information sensible ;
14. la suite backend complete et les controles statiques restent propres.

## Hors perimetre maintenu

T1-D-B.2-C ne prouve pas encore :

- deux creations ou mises a jour concurrentes ;
- l'atomicite mutation-audit du futur adaptateur reel ;
- la sauvegarde et la restauration ;
- le moindre privilege IAM ;
- la resilience d'un proxy ou d'une connexion distante ;
- la compatibilite d'un fournisseur PostgreSQL heberge ;
- le raccordement de T1-C-A ou T1-D-A a PostgreSQL ;
- une route HTTP ou une interface utilisateur ;
- une migration V1 vers V2 ;
- l'utilisation de donnees reelles.

Ces preuves appartiennent a T1-D-B.3 ou aux portes ulterieures.

## Criteres d'arret

Le lot s'arrete ou repasse en `NO-GO` si :

- PGlite exige un fichier persistant ou une connexion reseau ;
- le harnais ne peut pas garantir une instance neuve par scenario ;
- le schema dedie ne peut pas etre cree vide avant inventaire ;
- le collecteur doit lire le contenu d'une table ;
- l'executeur peut accepter du SQL hors du plan signe ;
- la transaction ou le commit ne peut pas etre observes sans ambiguite ;
- un plan peut etre rejoue apres reservation ;
- une erreur brute, un chemin local ou une cible sensible entre dans la preuve ;
- le serveur HTTP importe ou lance l'executeur ;
- une donnee reelle ou un acces partage devient necessaire ;
- l'execution de T1-D-B.3 devient necessaire pour terminer ce micro-lot.

## Trajectoire vers la visibilite utilisateur

La reussite de T1-D-B.2-C n'affichera encore rien sur `seneswiss-group.com`. Elle permettra seulement de passer au cadrage de T1-D-B.3.

La premiere interface visible restera conditionnee par :

1. la preuve T1-D-B.3 sur concurrence, atomicite, restauration et moindre privilege ;
2. le choix gouverne d'une cible preview ;
3. l'adaptateur PostgreSQL reel et ses tests d'integration ;
4. les routes V2 authentifiees ;
5. le frontend Budget en deploy preview ;
6. la recette desktop et mobile ;
7. une autorisation distincte de mise en production.

## Arbitrage groupe candidat

Confirmer ou amender `BUDGET-T1-D-B-2-C-001 V0.1` en une decision unique :

1. retenir PGlite en memoire comme moteur ephemere du micro-lot ;
2. interdire tout port reseau, fichier persistant, secret et cible partagee ;
3. separer harnais, collecteur, planificateur, executeur et registre anti-rejeu ;
4. limiter l'execution aux trois instructions exactes d'un plan `planned-create` autorise et non expire ;
5. imposer une transaction unique avec controle du catalogue avant et apres commit ;
6. interdire tout rejeu automatique, notamment apres echec ou resultat incertain ;
7. produire uniquement une preuve fermee et non sensible ;
8. nettoyer par fermeture de l'instance en memoire, sans DDL destructif ;
9. autoriser apres confirmation uniquement le micro-lot T1-D-B.2-C sur branche isolee, avec tests et PR jusqu'au verdict propre, sans fusion automatique ;
10. maintenir fermes T1-D-B.3, cible preview, adaptateur reel, route HTTP, IAM, migration, donnee reelle, frontend et activation Budget ;
11. maintenir T1-E et le Budget personnel hors perimetre.

La confirmation de ce paquet valide uniquement le cadrage. L'execution locale du futur micro-lot doit etre explicitement autorisee et restera strictement fictive et ephemere.

## Sources internes

- `docs/FINANCE-BUDGET-T1-D-B-2-ENGINE-MIGRATION-CONTRACT.md`
- `docs/FINANCE-BUDGET-T1-D-B-2-B-MIGRATION-PLANNER-CONTRACT.md`
- `financeBudgetV2PostgresSchema.js`
- `financeBudgetV2PostgresMigrationPlanner.js`
- `scripts/validateRef01Migrations.mjs`
- `tests/financeBudgetV2PostgresSchema.test.js`
- `tests/financeBudgetV2PostgresMigrationPlanner.test.js`
- `package.json`
