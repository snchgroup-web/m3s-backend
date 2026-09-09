# BUDGET-T1-D-B-2-001 V0.1 - decision de moteur et cadrage de migration V2

Date de preparation : 09-09-2026.

Statut : candidat documentaire a confirmer ou amender. Ce document ne selectionne aucun fournisseur cloud, ne cree aucun schema, table, compte, role ou secret et ne contient aucun DDL executable. Il n'autorise ni installation de pilote, acces reel, IAM, migration, donnee reelle, recette preview ou activation Budget.

## Decision recommandee

BigQuery est `NO-GO` comme stockage transactionnel de reference des brouillons Budget V2. Il peut rester une cible analytique ou de restitution ulterieure, mais il ne doit pas porter l'etat courant faisant autorite.

PostgreSQL devient le moteur transactionnel candidat a verifier pour T1-D-B.2. Cette recommandation ne vaut ni choix de fournisseur, ni choix d'hebergement, ni autorisation d'implementation. Le passage au statut `GO` exige encore un DDL candidat, des tests locaux reproductibles et la preuve isolee T1-D-B.3.

Le contrat applicatif valide dans T1-D-A et T1-D-B.1 reste inchange. Le moteur doit s'y conformer ; le contrat ne sera pas affaibli pour conserver un produit de stockage.

## Motif du NO-GO BigQuery

BigQuery prend en charge des transactions multi-instructions ACID avec isolation par instantane. Cette capacite ne suffit toutefois pas au contrat T1-D-B :

- les contraintes de cle primaire et de cle etrangere BigQuery sont declarees `NOT ENFORCED` ;
- l'application reste responsable de l'unicite des donnees ;
- les insertions concurrentes ne fournissent donc pas la garantie moteur exigee pour obtenir exactement un gagnant sur une meme cle logique ;
- les mutations concurrentes peuvent etre annulees ou relancees par BigQuery, ce qui complique la classification stricte entre resultat certain et resultat incertain.

Conclusion : l'unicite effective de `(tenant_id, author_user_id, id)` et le gagnant unique de creation ne peuvent pas reposer sur une contrainte imposee par BigQuery. La porte zero de T1-D-B n'est donc pas franchie.

Cette decision est une inference technique issue des garanties documentees du moteur, et non un jugement general sur BigQuery. BigQuery reste adapte aux analyses, agregats et restitutions qui ne sont pas la source transactionnelle faisant autorite.

## Aptitude candidate de PostgreSQL

PostgreSQL fournit les mecanismes necessaires a une preuve T1-D-B :

- cle primaire ou contrainte unique composite effectivement imposee ;
- colonnes `NOT NULL` et contraintes `CHECK` imposees lors des ecritures ;
- transactions regroupant la mutation courante et l'evenement d'audit ;
- verrouillage et mise a jour conditionnelle de la version courante ;
- conflit d'unicite explicite pour une creation concurrente ;
- index B-tree cree automatiquement pour une cle primaire ou une contrainte unique.

Ces capacites rendent PostgreSQL admissible comme candidat, mais seules les preuves executees dans T1-D-B.3 pourront prononcer le `GO` final.

## Perimetre de T1-D-B.2

T1-D-B.2 doit produire, dans cet ordre :

1. `T1-D-B.2-A` : modele physique candidat, DDL hors ligne et validateur de plan, sans connexion ni execution ;
2. `T1-D-B.2-B` : planificateur de migration ferme par defaut, avec empreinte du plan et jeton d'autorisation explicite, encore sans cible reelle ;
3. `T1-D-B.2-C` : executeur PostgreSQL sur moteur local ephemere et donnees fictives, uniquement apres decision distincte ;
4. `T1-D-B.3` : recette isolee de concurrence, atomicite, restauration et moindre privilege, uniquement apres nouvelle decision.

La confirmation de ce document autorisera seulement la preparation de `T1-D-B.2-A` sur branche isolee. Les lots suivants restent fermes.

## Modele physique candidat

Le schema logique conserve les noms valides par T1-D-B.1. Le futur DDL devra placer les objets V2 dans un schema PostgreSQL Budget dedie, dont le nom exact restera configure et valide par liste blanche.

### Table courante `finance_budget_drafts_v2_current`

| Champ | Type PostgreSQL candidat | Contrainte candidate |
| --- | --- | --- |
| `tenant_id` | texte borne | `NOT NULL`, partie de la cle primaire |
| `author_user_id` | texte borne | `NOT NULL`, partie de la cle primaire |
| `id` | UUID | `NOT NULL`, partie de la cle primaire |
| `contract_version` | petit entier | `NOT NULL`, exactement `2` |
| `version` | entier | `NOT NULL`, entre `1` et `1000000` |
| `title` | texte borne | `NOT NULL` |
| `entity` | texte borne | `NOT NULL` |
| `year` | texte fixe | `NOT NULL`, format `YYYY` |
| `scope` | texte borne | `NOT NULL`, exactement `organization` |
| `status` | texte borne | `NOT NULL`, exactement `draft` |
| `access` | texte borne | `NOT NULL`, exactement `owner-only` |
| `document_json` | texte | `NOT NULL`, JSON UTF-8 serialise exactement une fois |
| `document_bytes` | entier | `NOT NULL`, entre `1` et `4194304`, egal a la taille UTF-8 du texte |
| `created_at` | instant avec fuseau | `NOT NULL`, immuable apres creation |
| `updated_at` | instant avec fuseau | `NOT NULL`, superieur ou egal a `created_at` |

La cle primaire candidate est `(tenant_id, author_user_id, id)`. Elle impose ensemble la portee, l'auteur et l'identifiant, sans index d'unicite global sur `id` qui pourrait reveler l'existence d'un brouillon dans une autre portee.

`document_json` reste un texte et non un type JSON binaire dans ce lot. Cette decision preserve les octets UTF-8 exacts produits par T1-D-B.1 et permet de verifier `document_bytes` sans normalisation implicite du moteur. La validation JSON complete reste assuree avant ecriture et apres lecture par le contrat applicatif.

Le futur DDL devra imposer la coherence par une contrainte de ligne equivalente a `octet_length(document_json) = document_bytes`. Cette expression illustre la regle attendue ; elle n'est pas un DDL autorise par ce document.

Le futur DDL doit ajouter un index de liste couvrant au minimum `(tenant_id, author_user_id, updated_at DESC, id ASC)`. Aucun partitionnement n'est retenu pour le premier pilote transactionnel : le volume attendu est faible et la simplicite facilite la preuve de correction.

### Table d'evenements `finance_budget_draft_events_v2`

| Champ | Type PostgreSQL candidat | Contrainte candidate |
| --- | --- | --- |
| `event_id` | grand entier identitaire | cle primaire generee par le moteur, sans extension |
| `tenant_id` | texte borne | `NOT NULL` |
| `actor_user_id` | texte borne | `NOT NULL` |
| `draft_id` | UUID | `NOT NULL` |
| `version` | entier | `NOT NULL`, entre `1` et `1000000` |
| `action` | texte borne | `NOT NULL`, action V2 autorisee uniquement |
| `occurred_at` | instant avec fuseau | `NOT NULL` |

Une contrainte unique candidate porte sur `(tenant_id, actor_user_id, draft_id, version, action)`. Elle interdit le doublage d'un evenement pour une meme mutation sans imposer de dependance a la version mutable de la table courante.

La valeur technique `event_id` peut comporter des trous apres annulation d'une transaction. Elle n'a aucune signification metier, chronologique ou comptable et n'est jamais exposee comme preuve de continuite.

Une cle etrangere candidate peut relier `(tenant_id, actor_user_id, draft_id)` a la cle de la table courante. Sa suppression doit etre interdite ou restreinte ; aucun effacement en cascade n'est autorise. La decision finale sur cette cle etrangere appartient a T1-D-B.2-A, car la future politique de suppression logique n'est pas encore ouverte.

Le journal reste append-only au niveau applicatif. Aucun titre, montant, devise, ligne budgetaire ou document JSON n'y est admis.

## Contrat transactionnel candidat

Le niveau candidat est `READ COMMITTED`, fixe explicitement pour chaque transaction d'ecriture. Dans PostgreSQL, une mise a jour concurrente attend le premier ecrivain puis reevalue sa clause `WHERE` sur la version devenue courante. Ce comportement permet au second compare-and-swap de constater zero ligne affectee et de retourner un conflit certain sans rejouer l'ecriture.

`REPEATABLE READ` et `SERIALIZABLE` ne sont pas retenus par defaut dans ce contrat, car leurs echecs de serialisation appellent normalement une reprise de la transaction. Toute elevation future du niveau d'isolation exigera un contrat distinct d'idempotence et de reprise.

### Creation

Dans une transaction unique :

1. inserer la ligne courante avec `version = 1` ;
2. inserer l'evenement `budget_v2_draft_created` ;
3. valider le commit ;
4. retourner `created` seulement si le commit est confirme.

Une violation certaine de la cle primaire retourne `duplicate`. Elle ne declenche ni mise a jour implicite, ni seconde tentative, ni insertion d'audit.

### Remplacement compare-and-swap

Dans une transaction unique :

1. mettre a jour la ligne cible avec la portee complete et `version = expectedVersion` ;
2. remplacer document, resume, taille, version et `updated_at`, sans modifier `created_at` ;
3. exiger exactement une ligne affectee ;
4. inserer l'evenement `budget_v2_draft_updated` ;
5. valider le commit et retourner `updated` seulement si le commit est confirme.

Zero ligne affectee impose une lecture bornee dans la meme portee pour distinguer `missing` de `conflict`. Plus d'une ligne affectee est une corruption fermee.

### Resultat incertain

Une perte de connexion avant preuve du commit produit `uncertain`. L'application ne relance jamais automatiquement la commande. Les reprises automatiques du pilote, du proxy ou du fournisseur doivent etre desactivees pour les ecritures ou demontrees compatibles avec un identifiant d'operation idempotent, lequel n'est pas encore autorise.

## Plan de migration ferme par defaut

Le futur planificateur T1-D-B.2-B doit respecter les regles suivantes :

- aucun DDL au demarrage de l'API ;
- aucun recours a `schemaMigrations.js`, qui reste reserve aux migrations BigQuery existantes ;
- aucune lecture directe de `process.env` dans le planificateur pur ;
- production deterministe d'un plan et de son empreinte cryptographique ;
- mode par defaut `plan`, sans connexion ni mutation ;
- refus si la cible, le schema, l'encodage UTF-8, la version PostgreSQL ou la localisation divergent ;
- application impossible sans reference d'autorisation, empreinte exacte et confirmation explicite de la cible ;
- refus de toute table V1 ou table hors des deux objets V2 ;
- controle post-application complet avant de declarer la migration terminee ;
- retour arriere non destructif par desactivation applicative ; aucune suppression de table ou de donnee sans decision separee.

Le plan doit etre monotone et versionne. Une structure existante conforme est un succes idempotent ; une structure partielle ou divergente est un arret, jamais une correction automatique.

## Controle post-migration candidat

La recette de schema devra verifier :

1. existence des deux tables V2 et absence de modification V1 ;
2. types, nullabilite et contraintes exacts ;
3. cle primaire composite effectivement imposee ;
4. contraintes de domaine et de taille effectivement imposees ;
5. index de liste exact et ordre compatible ;
6. unicite des evenements ;
7. absence de declencheur, fonction, extension ou droit inattendu ;
8. encodage UTF-8 de la base et restitution exacte de `document_json` ;
9. absence de compte, secret ou identifiant de cible dans les preuves partagees ;
10. inventaire avant/apres et empreinte du schema obtenue.

## Migration de donnees

Aucune donnee V1 n'est migree dans T1-D-B.2. Les tables V2 demarrent vides.

Toute conversion, copie ou promotion V1 vers V2 appartient a T1-E et exigera :

- un contrat de correspondance explicite ;
- une simulation sans ecriture ;
- des controles tenant-auteur ;
- un rapport d'ecarts ;
- une autorisation distincte nommant les donnees et la cible.

## Fournisseur, hebergement et exploitation

Ce document choisit un type de moteur candidat, pas un service heberge. Cloud SQL, un autre PostgreSQL gere ou un moteur local ne sont pas departages.

Le futur arbitrage devra comparer au minimum : localisation, sauvegarde et restauration, cout, haute disponibilite, chiffrement, journalisation, identites de service, rotation des secrets et capacite de couper tout acces public.

L'identite runtime devra etre separee de l'identite de migration. Le runtime ne recevra aucun droit DDL. Aucun utilisateur M3S n'accedera directement a PostgreSQL.

## Preuves exigees avant GO

Le choix PostgreSQL ne devient definitif qu'apres les preuves fictives suivantes :

1. deux creations concurrentes de la meme cle donnent exactement un `created` et un `duplicate` ;
2. deux remplacements concurrents de la meme version donnent exactement un `updated` et un `conflict` ;
3. aucune ligne courante n'existe sans evenement correspondant apres succes ;
4. aucun evenement n'existe sans mutation correspondante ;
5. une erreur avant commit annule les deux ecritures ;
6. une rupture apres envoi du commit produit `uncertain` sans nouvelle tentative ;
7. deux tenants et deux auteurs restent strictement isoles ;
8. le chargement paresseux et la pagination stable respectent les plafonds T1-D-B.1 ;
9. une sauvegarde et une restauration fictives conservent contraintes, donnees et audit ;
10. l'identite runtime ne peut ni creer, modifier ou supprimer le schema, ni lire une autre cible.

## Criteres d'arret

Le paquet reste ou repasse en `NO-GO` si :

- le fournisseur ne permet pas d'imposer la cle composite ;
- une couche de proxy relance silencieusement les ecritures ;
- mutation et audit ne partagent pas la meme transaction ;
- une configuration peut viser V1 ou un schema commun ;
- le pilote transforme un commit incertain en succes ou en conflit certain ;
- un DDL peut etre execute au demarrage HTTP ;
- la migration exige une donnee reelle ou un acces utilisateur direct ;
- le retour arriere suppose de supprimer les tables ou les donnees ;
- les preuves ne peuvent pas etre reproduites sur une cible ephemere nettoyee.

## Arbitrage groupe candidat

Confirmer ou amender `BUDGET-T1-D-B-2-001 V0.1` en une decision unique :

1. prononcer BigQuery `NO-GO` comme source transactionnelle V2 faisant autorite ;
2. conserver BigQuery comme cible analytique potentielle hors de T1-D-B ;
3. retenir PostgreSQL comme moteur candidat, sans choisir encore de fournisseur ;
4. conserver `document_json` sous forme de texte UTF-8 exact ;
5. imposer la cle primaire `(tenant_id, author_user_id, id)` ;
6. imposer une transaction unique pour la mutation courante et son audit ;
7. imposer le compare-and-swap par `expectedVersion` et la classification `uncertain` sans nouvelle tentative ;
8. demarrer les tables V2 vides et maintenir toute conversion V1 dans T1-E ferme ;
9. separer plan, application, recette ephemere et activation ;
10. autoriser apres confirmation uniquement `T1-D-B.2-A`, avec DDL hors ligne, validateur et tests sans connexion ;
11. maintenir fermes T1-D-B.2-B, T1-D-B.2-C, T1-D-B.3, route HTTP, stockage reel, IAM, migration, donnee reelle, recette preview et activation Budget ;
12. conserver le Budget personnel hors perimetre.

La confirmation de ce paquet valide uniquement le cadrage. Elle n'autorise ni DDL executable, installation de pilote, fusion automatique, acces cloud, migration ou activation.

## Sources officielles consultees

- Google Cloud, contraintes BigQuery : https://docs.cloud.google.com/bigquery/docs/primary-foreign-keys
- Google Cloud, transactions BigQuery : https://docs.cloud.google.com/bigquery/docs/transactions
- Google Cloud, concurrence DML BigQuery : https://docs.cloud.google.com/bigquery/docs/data-manipulation-language
- PostgreSQL, contraintes imposees : https://www.postgresql.org/docs/current/ddl-constraints.html
- PostgreSQL, creation de table et index d'unicite : https://www.postgresql.org/docs/current/sql-createtable.html
- PostgreSQL, isolation et reevaluation des mises a jour concurrentes : https://www.postgresql.org/docs/current/transaction-iso.html
- PostgreSQL, insertion et traitement des conflits : https://www.postgresql.org/docs/current/sql-insert.html

## Sources internes

- `docs/FINANCE-BUDGET-T1-D-B-STORAGE-CONTRACT.md`
- `docs/FINANCE-BUDGET-T1-D-WRITE-CONTRACT.md`
- `docs/FINANCE-BUDGET-T1-C-READ-CONTRACT.md`
- `financeBudgetV2StorageAdapter.js`
- `financeBudgetV2StoredRecords.js`
- `financeBudgetV2Reads.js`
- `financeBudgetV2Writes.js`
- `tests/financeBudgetV2StorageAdapter.test.js`
