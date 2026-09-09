# BUDGET-T1-D-B-001 V0.1 - cadrage candidat de la persistance V2

Date de preparation : 09-09-2026.

Statut : candidat documentaire a confirmer ou amender. Ce document ne cree aucun adaptateur, schema, dataset, table, compte ou secret. Il n'autorise ni DDL, migration, acces cloud, donnee reelle, route HTTP, recette preview ou activation Budget.

## Decision et finalite

T1-D-B cadre la future persistance reelle des brouillons Budget V2 d'organisation. Il doit relier les services purs T1-C-A et T1-D-A a un stockage qui respecte exactement leurs contrats, sans modifier V1 et sans exposer une capacite HTTP.

Le stockage cible devra garantir ensemble :

- separation physique entre V1 et V2 ;
- unicite logique d'un brouillon dans la portee tenant-auteur ;
- creation atomique du brouillon et de son evenement d'audit ;
- comparaison et remplacement atomiques de la version courante et de l'audit ;
- distinction entre resultat certain, conflit certain et resultat incertain ;
- lecture unitaire non revelatrice et liste bornee, ordonnee et chargee progressivement ;
- absence de contenu financier dans les evenements, erreurs et journaux techniques.

T1-D-B ne choisit pas implicitement BigQuery parce que V1 l'utilise. Le moteur sera retenu seulement apres une preuve reproductible de ses garanties de concurrence. V1, ses tables, ses routes et ses donnees restent inchanges.

## Decoupage Fast Track ferme

Le paquet regroupe le cadrage mais conserve trois portes techniques distinctes :

1. `T1-D-B.1` : adaptateur pur et constructeurs de requetes sur un executeur injecte, avec doubles uniquement ; aucun SDK cloud, DDL ou acces reel.
2. `T1-D-B.2` : DDL V2 et migration explicite en mode plan par defaut ; aucune execution sans autorisation nommant la cible exacte.
3. `T1-D-B.3` : preuve isolee de concurrence, atomicite, restauration et moindre privilege avec donnees fictives ; aucune activation.

L'ordre est obligatoire. Une confirmation de ce document permettra de proposer uniquement `T1-D-B.1`. Chaque sous-lot exigera une PR, une revue et une decision de fusion propres. `T1-D-B.2` et `T1-D-B.3` ne sont pas autorises par anticipation.

## Porte zero - aptitude du moteur

Avant tout DDL, le moteur candidat doit demontrer sur une cible ephemere :

1. une cle unique effective sur `(tenant_id, author_user_id, id)`, et non une simple declaration informative ;
2. deux creations concurrentes de la meme cle : exactement un succes et un doublon certain ;
3. deux remplacements concurrents avec la meme version attendue : exactement un succes et un conflit certain ;
4. aucune ligne de brouillon sans evenement correspondant apres succes certain ;
5. aucun evenement sans mutation correspondante ;
6. un resultat de commit perdu ou non prouvable classe `uncertain`, sans nouvelle tentative automatique ;
7. isolation tenant-auteur imposee dans toutes les requetes, y compris les lectures de verification ;
8. transaction et niveau d'isolation documentes avec une preuve executable, pas seulement une hypothese.

Si BigQuery ne prouve pas l'unicite effective ou le comportement concurrent exige, il est `NO-GO` pour T1-D-B. Le paquet devra alors comparer un moteur transactionnel adapte avant de poursuivre. Aucun affaiblissement du contrat T1-D-A n'est admis pour conserver un produit de stockage.

## Modele logique V2 candidat

Les noms ci-dessous sont candidats et ne valent pas DDL :

### `finance_budget_drafts_v2_current`

| Champ | Type logique | Regle |
| --- | --- | --- |
| `id` | UUID V4 | partie de la cle logique |
| `tenant_id` | texte borne | partie de la cle logique et de toute requete |
| `author_user_id` | texte borne | partie de la cle logique et de toute requete |
| `contract_version` | entier | toujours `2` |
| `version` | entier | de `1` a `1000000` |
| `title` | texte borne | resume serveur, non fourni separement par le client |
| `entity` | texte borne | libelle historique issu de l'instantane |
| `year` | texte `YYYY` | annee de synthese de l'exercice |
| `scope` | texte ferme | toujours `organization` |
| `status` | texte ferme | toujours `draft` avant extension autorisee |
| `access` | texte ferme | toujours `owner-only` |
| `document_json` | document serialise | enveloppe V2 complete validee |
| `document_bytes` | entier | taille UTF-8 verifiee avant lecture du document |
| `created_at` | instant UTC | immuable apres creation |
| `updated_at` | instant UTC | egal au `resolvedAt` de l'enveloppe courante |

La cle logique unique est `(tenant_id, author_user_id, id)`. Toute autre ligne portant le meme `id`, meme dans une autre portee, reste invisible hors de sa portee et ne doit jamais provoquer une divulgation.

Le document stocke reste la source complete du brouillon. Les colonnes de resume sont des projections verifiees a chaque lecture par `validateBudgetV2StoredRecord`; elles ne peuvent pas reparer ni remplacer un document invalide.

### `finance_budget_draft_events_v2`

| Champ | Type logique | Regle |
| --- | --- | --- |
| `event_id` | identifiant unique | genere pour un seul evenement |
| `draft_id` | UUID V4 | identifiant du brouillon |
| `tenant_id` | texte borne | portee de l'evenement |
| `actor_user_id` | texte borne | auteur de la commande |
| `version` | entier | version effectivement creee ou remplacee |
| `action` | texte ferme | `budget_v2_draft_created` ou `budget_v2_draft_updated` |
| `occurred_at` | instant UTC | exactement le `writeAt` de la commande |

Le journal ne contient ni titre, entite, annee, montant, devise, ligne, dimension, instantane, document JSON ou adresse technique privee. Une future conservation d'historique metier ne doit pas detourner ce journal d'audit minimal.

## Separation V1 et V2

- Aucun `ALTER` des tables `finance_budget_drafts_v1` ou `finance_budget_draft_events_v1`.
- Aucune lecture V2 depuis une table V1, meme si un JSON semble compatible.
- Aucune ecriture V2 dans une table V1.
- Aucun `UNION` V1/V2 dans les listes avant un contrat explicite de coexistence.
- Aucun identifiant V1 promu ou reutilise sans T1-E.
- Dataset dedie Budget requis par les garde-fous P1-P4 ; le dataset applicatif commun reste exclu.

## Contrat de l'adaptateur T1-D-B.1

L'adaptateur devra implementer exactement l'interface deja consommee par T1-C-A et T1-D-A :

```text
probe()
getCurrentDraft({ id, tenantId, authorUserId })
scanCurrentDrafts({ tenantId, authorUserId, batchSize, maxPositions })
findPromotionLinks({ tenantId, authorUserId, draftId })
createCurrentDraft({ record, audit })
replaceCurrentDraft({ id, tenantId, authorUserId, expectedVersion, nextRecord, audit })
```

Le constructeur recoit uniquement une configuration deja validee et un executeur injecte. Il ne lit pas directement `process.env`, ne cree pas de client, ne demarre pas de migration et ne connait pas Express.

Toutes les valeurs metier passent par des parametres lies. Seuls les identifiants de projet, dataset et table, controles par une liste blanche avant construction, peuvent apparaitre dans le texte de requete. Aucun identifiant ou contenu client n'est concatene.

### `probe`

`probe` controle sans mutation :

- disponibilite de l'executeur ;
- cible V2 distincte de V1 ;
- contrat exact des deux tables V2 ;
- localisation et politique de conservation attendues ;
- absence d'ouverture si la configuration ou les metadonnees divergent.

Il retourne exactement `{ available: true }` ou echoue. Il ne cree aucune ressource et ne corrige aucun schema.

### `getCurrentDraft`

La requete porte obligatoirement sur `id + tenant_id + author_user_id + contract_version = 2`, avec une borne de deux lignes. Elle retourne `{ available: true, records: [] }` ou un tableau de lignes brutes converties en enregistrements camelCase. Deux lignes, un JSON illisible, une taille divergente ou un champ inattendu restent visibles au service comme corruption, jamais comme absence reparee.

### `scanCurrentDrafts`

La liste suit l'ordre exact `updated_at DESC, id ASC`. Elle n'extrait d'abord que `id`, `updated_at` et `document_bytes`, par lots de `batchSize <= 50`, avec une pagination par cle stable et un maximum de positions impose par l'appelant.

Chaque position fournit un handle ferme :

```text
{ id, updatedAt, serializedBytes, load }
```

`load` effectue une lecture unitaire dans la meme portee et exige le meme `updatedAt`. Le document complet n'est jamais selectionne pour toutes les positions en une seule fois. Une derive entre le handle et le chargement, une position surnumeraire ou une pagination non monotone fait echouer toute la liste sans page partielle.

### `findPromotionLinks`

Avant T1-E, aucune table de promotion n'est creee. L'adaptateur peut retourner une liste vide seulement si une capacite interne immuable confirme que T1-E est absent. Toute table, colonne, liaison ou configuration de promotion inattendue rend le stockage indisponible. T1-E remplacera ce comportement par un contrat et une migration separes.

## Serialisation et deserialisation

- `record.document` est serialise une fois en UTF-8 ; la taille exacte est stockee dans `document_bytes`.
- L'adaptateur refuse une valeur non serialisable, un octetage nul ou incoherent et toute taille depassant la borne partagee qui sera fixee dans T1-D-B.1.
- La borne doit couvrir l'enveloppe complete, pas seulement `budget` ; elle doit rester compatible avec la limite de requete `512 Kio` et le plafond de liste `64 Mio`.
- Les instants sont transportes sans conversion de fuseau et reconstruits en ISO UTC canonique.
- Les entiers sont controles avant conversion JavaScript ; aucune version ou taille hors entier sur n'est acceptee.
- Aucun champ inconnu n'est ignore silencieusement.

La borne de l'enveloppe stockee sera une constante partagee et testee. Son choix chiffre appartient a T1-D-B.1 et doit etre justifie par le pire cas valide du contrat V2, puis rester inferieur aux limites du moteur retenu.

## Creation atomique

`createCurrentDraft` recoit un enregistrement deja valide et un audit minimal. Dans une seule transaction :

1. verifier ou faire appliquer l'unicite de la cle logique ;
2. inserer exactement une ligne courante V2 ;
3. inserer exactement un evenement `budget_v2_draft_created` ;
4. valider le commit ;
5. retourner seulement `{ outcome: 'created', id, version: 1 }` si le commit est prouve.

Une collision certaine retourne exactement `{ outcome: 'duplicate' }` sans ecriture ni evenement. Une indisponibilite prouvee avant toute mutation retourne `{ outcome: 'unavailable' }`. Des que le resultat du commit n'est plus prouvable, l'adaptateur retourne `{ outcome: 'uncertain' }` ou leve une erreur que T1-D-A classe comme incertaine. Il ne relance jamais l'ecriture.

## Remplacement atomique

`replaceCurrentDraft` execute dans une seule transaction :

1. cibler la cle `id + tenant + auteur + contractVersion 2` ;
2. comparer `expectedVersion` a la version courante ;
3. remplacer ensemble document, resume, taille, version et `updatedAt` ;
4. conserver `createdAt` ;
5. inserer exactement un evenement `budget_v2_draft_updated` ;
6. valider le commit et retourner l'issue fermee.

Les issues exactes sont `updated`, `missing`, `conflict`, `duplicate`, `unavailable` ou `uncertain`. Un resultat `updated` contient uniquement l'identifiant attendu et `nextRecord.version`. Une ligne affectee sans audit, un audit sans ligne affectee, un nombre de lignes superieur a un ou une version retournee divergente sont des echecs fermes.

## BigQuery comme candidat conditionnel

La cible Budget dediee et les outils actuels rendent BigQuery economiquement reutilisable, mais cela ne suffit pas a le retenir. Son candidat T1-D-B devra notamment prouver :

- comportement reel de deux transactions concurrentes sur la meme cle ;
- absence de doublon malgre l'absence eventuelle de contrainte unique appliquee par le moteur ;
- resultat exploitable de la ligne affectee dans le meme script transactionnel ;
- requetes de liste bornees et cout mesurable ;
- restauration fictive compatible avec la politique P1 ;
- moindre privilege compatible avec P2.

Si une de ces garanties n'est pas prouvee, T1-D-B devra evaluer un stockage transactionnel avec contrainte unique effective. La decision de moteur sera documentee avant tout DDL et ne modifiera pas les interfaces applicatives.

## DDL et migration T1-D-B.2 candidats

Le futur lot de schema devra :

- creer uniquement les deux tables V2 dans la cible Budget explicitement autorisee ;
- etre idempotent en plan et refuser une structure existante divergente ;
- ne jamais creer de dataset, compte ou droit IAM ;
- ne jamais s'executer au demarrage HTTP ;
- exiger une reference d'autorisation et une confirmation exacte d'application ;
- fournir un plan de retour arriere qui ne supprime aucune donnee sans decision distincte ;
- verifier schema, nullabilite, partitionnement, clustering, conservation et localisation apres execution ;
- laisser les tables V1 strictement intactes.

Le DDL exact, le partitionnement et le clustering ne sont pas prononces par V0.1. Ils dependent du moteur et des mesures de `T1-D-B.3`.

## IAM, secrets et configuration

- Identite de migration distincte de l'identite runtime.
- Runtime limite aux lectures, insertions et mises a jour necessaires sur les seules tables Budget V2.
- Aucun utilisateur M3S n'accede directement au stockage.
- Aucun secret dans le depot, les tests, la PR, les preuves ou le journal.
- Configuration V2 distincte et fermee par defaut ; absence ou divergence signifie indisponible.
- Aucun droit n'est accorde, retire ou modifie par T1-D-B.1.

## Observabilite minimale

Les journaux techniques peuvent contenir uniquement : operation, issue fermee, duree, nombre de lignes affectees, moteur, revision applicative et identifiant de correlation non metier.

Ils ne contiennent jamais identifiant de brouillon, tenant, auteur, titre, entite, annee, document, montant, devise, dimension, requete parametree complete ou exception du fournisseur. Les metriques separent lecture, liste, creation, mise a jour, conflit et incertitude.

## Recette groupee candidate

### T1-D-B.1 - sans acces reel

1. validation stricte de la configuration et des noms de ressources ;
2. parametres lies pour toutes les valeurs ;
3. mapping exact ligne stockee vers enregistrement V2 ;
4. JSON invalide, octetage divergent, entier dangereux et champ inconnu refuses ;
5. lecture unitaire bornee a deux lignes et non revelatrice ;
6. scan par lots de 50, ordre stable, sentinelle, taille et chargement paresseux ;
7. creation et remplacement traduits vers les sept issues fermees ;
8. aucune nouvelle tentative apres resultat incertain ;
9. aucun contenu sensible dans audit, erreur ou journal ;
10. regression complete des services T1-C-A et T1-D-A ;
11. recherche statique prouvant l'absence de route, SDK cloud, `process.env`, DDL et migration ;
12. suite backend, `git diff --check` et worktree propres.

### T1-D-B.2 - schema sans application implicite

1. plan DDL deterministe et idempotent ;
2. deux tables V2 seulement et V1 inchange ;
3. derive de schema refusee ;
4. aucune commande d'application sans confirmation exacte ;
5. controle post-migration et retour arriere non destructif documentes.

### T1-D-B.3 - cible ephemere et donnees fictives

1. porte zero complete ;
2. creation, lecture, liste et mise a jour avec trois identites fictives ;
3. deux creations concurrentes et deux mises a jour concurrentes ;
4. audit atomique et contenu minimal ;
5. interruption simulee avant transaction, pendant mutation et apres commit ;
6. isolation de deux tenants et deux auteurs ;
7. expiration, sauvegarde et restauration fictive ;
8. inventaire IAM avant et apres, sans acces direct utilisateur ;
9. rapport nettoye, ressources ephemeres fermees et aucun reliquat sensible.

## Criteres d'arret

Le lot s'arrete en `NO-GO` si :

- l'unicite ou le compare-and-swap ne sont pas garantis par le moteur ;
- une ecriture et son audit peuvent diverger ;
- un resultat incertain est transforme en succes, conflit ou nouvelle tentative ;
- une requete omet le tenant ou l'auteur ;
- la liste charge tous les documents avant filtrage ;
- V1 doit etre modifie pour accueillir V2 ;
- une preuve exige une donnee reelle, un secret ou un acces utilisateur direct ;
- la cible, la conservation, le responsable ou le retour arriere restent indetermines.

## Arbitrage groupe candidat

Confirmer ou amender `BUDGET-T1-D-B-001 V0.1` en une decision unique :

1. conserver les interfaces T1-C-A et T1-D-A comme contrat de l'adaptateur ;
2. separer physiquement V1 et V2 ;
3. imposer une cle unique effective par tenant, auteur et identifiant ;
4. imposer mutation, version et audit dans une transaction unique ;
5. conserver la classification certaine ou incertaine sans nouvelle tentative ;
6. charger la liste par metadonnees bornees puis document unitaire ;
7. maintenir T1-E et toute promotion fermes ;
8. traiter BigQuery comme candidat conditionnel, non comme choix acquis ;
9. ordonner `T1-D-B.1`, puis `T1-D-B.2`, puis `T1-D-B.3` avec decisions separees ;
10. autoriser apres confirmation uniquement la preparation de `T1-D-B.1` sur branche isolee, avec doubles, tests et PR jusqu'au verdict propre, sans fusion automatique ;
11. maintenir fermes route HTTP, SDK ou acces cloud, IAM, DDL, migration, donnee reelle, recette preview et activation Budget ;
12. conserver le Budget personnel hors perimetre.

La confirmation du paquet valide uniquement ce cadrage. Elle n'autorise ni implementation, fusion, choix definitif du moteur, DDL, migration, acces cloud, recette preview ou activation.

## Sources internes

- `docs/FINANCE-BUDGET-T1-TECHNICAL-CONTRACT.md`
- `docs/FINANCE-BUDGET-T1-C-READ-CONTRACT.md`
- `docs/FINANCE-BUDGET-T1-D-WRITE-CONTRACT.md`
- `docs/FINANCE-BUDGET-DRAFTS.md`
- `financeBudgetV2Reads.js`
- `financeBudgetV2StoredRecords.js`
- `financeBudgetV2Writes.js`
- `financeBudgetDrafts.js`
- `schemaMigrations.js`
- `tests/financeBudgetV2Reads.test.js`
- `tests/financeBudgetV2Writes.test.js`
