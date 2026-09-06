# Registre des brouillons Budget organisation

Lot initial du 03-09-2026, actualise le 04-09-2026 apres fusion ordonnee de la PR backend 47 puis de la PR frontend 327.
Le code de sauvegarde est present sur les branches principales, mais reste desactive par defaut en production. Le frontend conserve donc son fonctionnement en session avec export/import JSON tant que les deux gardes d'activation ne sont pas explicitement ouvertes.

## Etat de livraison au 04-09-2026

- Backend `2de9541` et frontend `e2141df` fusionnes et publies dans cet ordre.
- Recette Railway/BigQuery isolee et authentifiee reussie avec donnees fictives : creation/relecture, isolation auteur et tenant, lecture seule et conflit de version sans ecrasement.
- Production fermee : aucune migration Budget executee, aucun flag backend ou frontend active et aucune donnee reelle enregistree.
- Budget personnel, approbation, realise, partage entre auteurs et promotion institutionnelle restent hors perimetre.

La fusion du code ne vaut ni autorisation de migration ni autorisation d'activation.

## Perimetre

- Un brouillon appartient a une organisation ET a son auteur authentifie. Aucun partage implicite avec les autres membres, y compris les responsables Finance.
- Le libelle `entity` est descriptif, pas un droit d'acces. `tenant_id` et `owner_user_id` proviennent uniquement de l'identite verifiee par le serveur.
- Lecture: `finance:read`. Creation/modification: `finance:read` ET `finance:write`. L'authentification reste obligatoire meme si le mode historique Finance desactive ses controles.
- Le compte courant est recontrole a chaque appel Budget: compte desactive/supprime ou tenant modifie refuse; droits Finance retires pris en compte sans attendre l'expiration d'un ancien token.
- Aucune route personnelle, validation de budget, affectation de transactions reelles, preuve, suppression, changement de proprietaire ou promotion institutionnelle.
- Les montants restent des chaines decimales avec la devise de chaque ligne; mois vide != zero. Aucun taux courant n'est injecte et aucun montant n'est recalcule.
- `budget.revision` reste la revision des exports du frontend. `version` est le compteur serveur independant, de 1 a 1000000. Au plafond, creer un nouveau brouillon; aucun compteur n'est remis a zero sur un enregistrement existant.

## Contrat API

Toutes les routes sont sous `/api/finance/budget-drafts`, Bearer authentifie et `Cache-Control: no-store`.

| Methode / chemin | Entree | Resultat |
| --- | --- | --- |
| GET `/capabilities` | aucune | `enabled`, `canWrite`, `scope: organization`, `access: owner-only`, `personalEnabled: false`; aucune requete BigQuery |
| GET `/` | `limit` 1..50 (20 par defaut), `offset` 0..10000 | `data` de metadonnees sans montants, `hasMore`, uniquement les brouillons de cet auteur et tenant |
| GET `/:id` | UUID v4 | `data` avec metadonnees, `version` et `budget` |
| POST `/` | `{budget}` | 201, `data.id`, `data.version: 1`, statut brouillon |
| PUT `/:id` | `{budget, expectedVersion}` | nouvelle `version`, ou 409 si obsolete |

`budget` reprend exactement les champs du modele frontend PR326: `title`, `entity`, `year`, `revision`, `rate`, `rateSource`, `rateDate`, `rows`.
Une ligne: `id`, `label`, `kind` (`operating`, `investment`, `financing`), `direction` (`in`, `out`), `currency` (`CHF`, `CFA`), `months` (12 chaines).
100 lignes maximum, 512 Kio maximum par corps, montants non negatifs <= 1 milliard avec deux decimales maximum. Un taux saisi exige sa source et sa date valide. Aucun champ additionnel n'est accepte, notamment owner, tenant, personal, approved ou actuals.

Codes: 400 entree invalide; 401 identite absente/incomplete; 403 permission absente; 404 inexistant OU autre auteur/tenant; 409 conflit de version; 503 stockage ferme, indisponible ou resultat non verifiable.

Ne jamais afficher "enregistre" sur erreur. Le client conserve le brouillon local tant qu'un succes n'a pas ete confirme. Sur une ecriture au resultat incertain, la reponse contient `draftId` et `reconcileRequired: true`: relire cet ID avant toute nouvelle creation, puis comparer le contenu. Ne pas relancer aveuglement un POST. Aucun retry automatique d'ecriture dans ce module.

## Stockage et concurrence

Deux tables isolees: `finance_budget_drafts_v1` et `finance_budget_draft_events_v1`.
Chaque ecriture et son evenement sont dans une transaction BigQuery. L'evenement ne contient ni montant ni libelle. Une mise a jour compare la version attendue dans la meme transaction et ne produit pas d'evenement sur conflit.
Une duplication d'identifiant detectee est bloquante, jamais resolue en choisissant une ligne arbitrairement.

Le choix reutilise l'infrastructure existante pour des sauvegardes explicites peu frequentes, pas une autosauvegarde par frappe. BigQuery n'est pas une base OLTP: revoir ce choix avant toute forte cadence ou collaboration simultanee.
References techniques: [transactions BigQuery](https://docs.cloud.google.com/bigquery/docs/transactions), [concurrence DML](https://docs.cloud.google.com/bigquery/docs/data-manipulation-language).

## Activation groupee, sans nouvelle cascade documentaire

1. Choisir un environnement de test separe, son dataset, sa region, les comptes pilotes et la conservation des brouillons/audits. Verifier IAM au niveau du service; les utilisateurs ne doivent pas contourner les filtres API par un acces direct aux tables.
2. `node scripts/printBudgetSchema.js PROJECT_ID DATASET_ID` imprime seulement les deux DDL. Aucun bootstrap de ces tables au demarrage du serveur. Relire et appliquer dans l'environnement explicitement autorise, jamais automatiquement.
3. En test, activer avec `FINANCE_BUDGET_DRAFTS_ENABLED=true`, `API_REQUIRE_AUTH=true` et une `JWT_SECRET` generee par `npm run auth:secret`. En production, tant que Budget est desactive, la configuration JWT existante reste utilisee sans rotation implicite. Toute demande d'activation Budget reste refusee avant l'ecoute HTTP tant qu'un fournisseur de cles persistant et partage n'est pas integre ; le serveur ne genere aucune cle ephemere par processus et ne remplace jamais silencieusement le secret historique. Le gestionnaire de cles et sa recette multi-instance restent une preuve P3 obligatoire avant GO production. La region suit la configuration existante du backend (`US`); tout autre emplacement exige son adaptation explicite avant activation.
4. Verifier sur BigQuery reel: create/read/update, atomicite de l'audit, deux PUT concurrents (un seul succes), version obsolete, isolation entre deux auteurs et deux tenants, droits retires, reponse perdue, table absente, absence de montants dans les logs.
5. Brancher le frontend avec choix explicite du brouillon, statut de sauvegarde, gestion du conflit sans ecrasement et export de secours. Puis activation de production dans le meme lot verifie.

Retour arriere non destructif: retirer les flags frontend puis backend, obtenir les redeploiements reussis et verifier la capacite desactivee ainsi que le refus ferme des ecritures. Conserver les tables et le journal; ne supprimer aucune donnee pour desactiver la fonction.

## Paquet unique de decision production

Une seule revue GO/NO-GO doit couvrir les cinq portes ci-dessous. Chaque porte recoit explicitement le verdict `GO` ou `NO-GO`, avec sa preuve. Une porte non documentee vaut `NO-GO`; le verdict global reste `NO-GO` tant que les cinq portes ne sont pas toutes `GO`. Les acquis de preview ne sont pas automatiquement transposes a la production.

| Porte | Preuve attendue | Verdict candidat au 04-09-2026 |
| --- | --- | --- |
| `P1` Schema et conservation | DDL relus pour la cible exacte, region confirmee, expiration/conservation et sauvegarde decidees | `NO-GO` - dataset candidat observe en `US`, mais cible Budget non decidee, expiration par defaut de 60 jours non arbitree et sauvegarde non documentee |
| `P2` Identite et moindre privilege | Compte de service de production identifie, `jobUser` borne et acces dataset sans droit direct des utilisateurs M3S | `NO-GO` - comptes backend `bigquery.admin` au niveau projet et acces herites plus larges que le moindre privilege |
| `P3` Authentification et secrets | `API_REQUIRE_AUTH=true`, secret JWT conforme, comptes pilotes et retrait de droits testes sans exposer de secret | `NO-GO` - authentification active et stockage Budget ferme observes, mais conformite du secret et retrait de droits non prouves en production |
| `P4` Exploitation et retour arriere | Alertes 5xx/409, journal sans montants, responsable, fenetre, critere d'arret et retrait des deux flags repetes | `NO-GO` - sante publique nominale, mais alertes, responsable, fenetre et repetition du retour arriere non prouves |
| `P5` Decision et perimetre | Autorisation explicite limitee aux brouillons Budget organisation, sans personnel, approbation ni realise | `NO-GO` - aucune autorisation d'activation |

## Collecte interne P1-P4 en lecture seule du 04-09-2026

Cette collecte a ete autorisee uniquement pour qualifier la preparation de production. Elle n'a execute aucun DDL, aucune migration, aucune requete sur le contenu des tables, aucune modification IAM, aucune revelation de secret, aucune activation de flag et aucun test d'ecriture. Une absence de preuve reste un echec de porte et non une presomption de conformite.

### P1 - cible, schema et conservation

- Projet actif observe : `mon-projet-data-2sg`.
- Dataset de production existant candidat : `m3s_2sg`, region `US`.
- Expiration par defaut observee pour les tables et partitions : `5184000000` ms, soit 60 jours.
- Les 23 tables/vues listees par leurs seules metadonnees ne comprennent ni `finance_budget_drafts_v1` ni `finance_budget_draft_events_v1`.
- Aucun choix formel ne designe encore `m3s_2sg` comme cible Budget et aucune politique de sauvegarde/restauration n'est documentee. L'expiration de 60 jours doit etre arbitree avant creation des brouillons et du journal d'audit.

Verdict `P1`: `NO-GO`.

### P2 - identite et moindre privilege

- Les comptes `m3s-backend@mon-projet-data-2sg.iam.gserviceaccount.com` et `m3s-backend-280@mon-projet-data-2sg.iam.gserviceaccount.com` disposent de `roles/bigquery.admin` au niveau projet.
- Le compte preview dispose de `roles/bigquery.jobUser` au niveau projet; cette observation ne valide pas le compte de production.
- Le dataset `m3s_2sg` accorde notamment `WRITER` a `projectWriters` et au compte `m3s-backend`, `OWNER` a `projectOwners`, et `READER` a `projectReaders` et au compte `m3s-backend`.
- Ces droits sont plus larges que le contrat cible `jobUser` borne au projet plus acces au seul dataset necessaire. Aucun droit n'a ete modifie pendant la collecte.

Verdict `P2`: `NO-GO`.

### P3 - authentification, secrets et fermeture fonctionnelle

- Service Railway observe : projet `optimistic-youth`, environnement `production`, service `web`, domaine `web-production-1e53c.up.railway.app`.
- Les noms de variables comprennent `API_REQUIRE_AUTH`, `JWT_SECRET` et `M3S_AUTH_USERS_JSON`. Les valeurs sont restees masquees et n'ont pas ete copiees.
- `FINANCE_BUDGET_DRAFTS_ENABLED` est absent de la liste de variables de production observee; le stockage Budget demeure donc desactive par defaut.
- Le 04-09-2026, `/api/health` et `/api/info` repondent HTTP 200. Un appel non authentifie a `/api/finance/budget-drafts/capabilities` repond HTTP 401 avec la politique `no-store` attendue.
- La longueur/rotation effective du secret, les comptes pilotes et le retrait immediat de droits n'ont pas ete testes sur la production.

Verdict `P3`: `NO-GO`.

### P4 - exploitation et retour arriere

- Les points de sante publics du backend et le frontend Netlify repondent HTTP 200 au moment du relevé.
- La procedure de retour arriere est documentee : retirer le flag frontend, retirer le flag backend, obtenir un redeploiement backend reussi, verifier `enabled: false`, puis verifier le refus ferme d'une ecriture.
- Aucune preuve recevable n'etablit encore des alertes 5xx/409 actives, l'absence de montants dans les journaux, un responsable nomme, une fenetre d'observation, un critere d'arret approuve ou une repetition complete du retour arriere sur la production.
- L'interface d'observabilite Railway n'a pas fourni de relevé exploitable pendant cette collecte; ce point est classe non demontre, sans tentative de creation d'alerte ni action sur un deploiement.

Verdict `P4`: `NO-GO`.

### Conclusion de collecte

Les controles confirment un etat ferme et non destructif, pas une preparation suffisante a l'activation. `P1`, `P2`, `P3` et `P4` restent `NO-GO`; `P5` reste egalement `NO-GO`. Le verdict global demeure donc `NO-GO`. Le prochain paquet de decision doit regrouper les corrections des quatre portes et l'autorisation de perimetre P5, sans fragmenter l'arbitrage en micro-validations.

## Paquet Fast Track candidat de correction P1-P4 V0.1

Ce paquet prepare les choix en une seule revue sans les executer. Son eventuelle confirmation autorise uniquement la preparation technique et les preuves en environnement isole. Elle n'autorise ni mutation IAM, ni creation de dataset/table en production, ni modification de secret, ni flag, ni activation, ni donnee reelle. `P5` reste une decision d'activation separee.

### Contraintes confirmees par le code

- Le backend utilise actuellement un client BigQuery et un `BIGQUERY_DATASET` communs aux modules Finance, Administration, Management, Intelligence et Budget.
- Au demarrage, le serveur resout les sources Finance, cree ou complete encore certains schemas Administration/Management et execute trois `ALTER TABLE` Finance. Le depot Intelligence peut aussi creer paresseusement `intelligence_dashboard_editions` pendant une publication ou une lecture si la table manque. Retirer `bigquery.admin` sans extraire tous ces chemins DDL, transition ni test pourrait donc degrader d'autres fonctions.
- Le module Budget n'execute aucun bootstrap de schema, mais ses tables utilisent le dataset commun et heriteraient de son expiration par defaut de 60 jours.
- Le middleware Budget impose toujours une identite authentifiee, relit le compte courant et ses droits, masque les erreurs de stockage et ne journalise ni corps, ni montant, ni identifiant utilisateur.
- Le journal HTTP global enregistre methode et chemin, mais pas encore le statut final, la duree ou un identifiant de correlation. Railway fournit les metriques d'infrastructure, pas les taux d'erreurs applicatifs.

### Matrice de decision groupee

| Porte | Option recommandee | Alternative acceptable | Option refusee | Decision encore requise |
| --- | --- | --- | --- | --- |
| `P1` Cible et conservation | Ajouter un dataset dedie `m3s_budget_prod` dans le meme projet et la meme region `US`, avec configuration Budget separee; ne pas appliquer l'expiration globale de 60 jours aux deux tables | Conserver `m3s_2sg` mais neutraliser explicitement l'expiration des deux tables Budget et documenter leur isolation logique | Creer les tables en heritant silencieusement de 60 jours, ou changer de region sans adaptation | Choix A/B; durees de conservation des brouillons, du journal et des sauvegardes; responsable de restauration |
| `P2` IAM | Separer l'identite de migration de l'identite d'execution; sortir tous les DDL du demarrage et des requetes Intelligence, puis donner au runtime `jobUser` au projet et les seuls droits de donnees necessaires au dataset | Transition en deux temps avec compte actuel maintenu temporairement, inventaire de permissions et retrait de `bigquery.admin` seulement apres recette complete | Retirer `bigquery.admin` directement ou conserver durablement les droits administrateur projet | Identite runtime cible, identite de migration, ordre de retrait et validateur IAM |
| `P3` Authentification | Interdire les mots de passe en clair en production, verifier secret et rotation sans les afficher, puis tester trois comptes pilotes fictifs repartis sur deux tenants, y compris retrait de droit | Conserver le magasin actuel uniquement si toutes les entrees production sont hachees et si le retrait de droit est prouve avant activation | Activer avec authentification facultative, secret par defaut, compte desactive encore utilisable ou droits portes seulement par l'ancien JWT | Responsables du secret et des comptes; fenetre de test; protocole de rotation et revocation |
| `P4` Exploitation | Ajouter des journaux Budget structures sans contenu financier, une correlation et les statuts/durees; alerter sur `5xx`, surveiller la tendance `409`, ajouter une sonde de sante de deploiement et repeter le retour arriere en preview | Metriques Railway pour infrastructure plus controle externe borne de l'API et compte rendu manuel de la premiere fenetre | Considerer un HTTP 200 ponctuel comme surveillance, alerter chaque `409` attendu ou activer sans retour arriere repete | Responsable d'astreinte, seuils, fenetre, critere d'arret, dernier deploiement sain et canal d'alerte |

Verdict candidat recommande : retenir les options recommandees pour les quatre portes, mais conserver chaque porte a `NO-GO` jusqu'a execution et preuve. La confirmation de cette matrice ne transforme aucun `NO-GO` en `GO`.

### P1 - cible, conservation et sauvegarde

1. Introduire un parametre distinct `FINANCE_BUDGET_DATASET`, ferme s'il est absent, afin que Budget ne depende plus implicitement de `BIGQUERY_DATASET`.
2. Preparer le dataset candidat `m3s_budget_prod` en `US`, sans le creer. Le nom final, la region et le projet doivent apparaitre dans le compte rendu avant toute commande.
3. Ne pas laisser les tables Budget heriter de l'expiration de 60 jours. Tant que Finance et LEGAL n'ont pas fixe les durees, aucune suppression automatique n'est autorisee.
4. Distinguer trois politiques : conservation des brouillons, conservation du journal d'evenements et sauvegardes/restauration. Une table qui expire est supprimee avec ses donnees; la recuperation courte duree ne remplace pas une sauvegarde gouvernee.
5. Preparer une strategie de snapshots et un exercice de restauration sur donnees fictives. La duree et le cout restent a arbitrer; aucun snapshot de production n'est autorise par ce paquet.

Preuve de passage future : cible exacte, DDL, absence d'expiration non voulue, politique versionnee, sauvegarde testee et restauration fictive reussie.

### P2 - transition IAM sans rupture des autres fonctions

1. Ajouter un mode de demarrage sans migration et une commande de migration explicite, separee du serveur HTTP. Y deplacer les schemas Administration/Management, les `ALTER TABLE` Finance et la creation paresseuse de `intelligence_dashboard_editions` utilisee dans les chemins de lecture/publication Intelligence. Aucun changement de schema ne doit etre necessaire au compte runtime apres stabilisation, y compris apres restauration dans un environnement vide.
2. Inventorier en preview les permissions reellement utilisees par les lectures, DML, transactions et controles de sante de tous les modules branches sur BigQuery.
3. Preparer deux identites : une identite runtime permanente au moindre privilege et une identite de migration temporaire, utilisee seulement pendant une fenetre autorisee.
4. Valider d'abord les nouveaux droits en preview, puis en production avec le stockage Budget encore desactive. Tester sante, Finance, Administration, Management, Intelligence et les capacites Budget fermees.
5. Retirer les droits administrateur seulement apres succes de ces controles. Au premier `403`, echec de migration ou regression metier, conserver/reposer l'ancien role et classer `RETOUR ARRIERE IAM`.

Preuve de passage future : matrice des permissions, comptes nommes, politiques avant/apres, controles de non-regression et retrait effectif de `bigquery.admin` sans acces direct des utilisateurs M3S.

### P3 - identite et secrets

1. Verifier hors journal que `API_REQUIRE_AUTH=true`, que le secret est non standard, suffisamment long et rotatable, et que les comptes de production n'utilisent pas le fallback de mot de passe en clair.
2. Preparer les trois comptes fictifs et revocables requis par la recette HTTP/JWT : un auteur Finance lecture/ecriture, un autre auteur du meme tenant pour l'isolation par proprietaire et un auteur d'un second tenant pour l'isolation inter-tenant. Ajouter un compte ou une variante lecture seule au protocole de retrait de droits si les trois comptes precedents conservent `finance:write`. Ne jamais inscrire leurs secrets dans le rapport.
3. Avec le stockage Budget ferme, verifier login, `/capabilities`, refus sans token, identites distinctes et retrait de `finance:write` sans attendre l'expiration du JWT. La recette d'ecriture/isolation complete reste reservee a la preview non productive ou le stockage fictif est active.
4. Repeter la rotation/revocation en preview avant toute production. Une rotation de secret de production reste une mutation separee et exige sa propre fenetre autorisee.

Preuve de passage future : rapport sans secret des controles authentifies, retrait de droit immediat, compte desactive refuse et procedure de rotation/revocation repetee.

### P4 - observabilite, seuils et retour arriere

1. Produire pour les routes Budget un journal structure limite a : horodatage, identifiant de correlation aleatoire, methode, route normalisee, statut, duree, code fonctionnel et version de deploiement. Exclure corps, montants, titres, entites, courriels, tokens, identifiants de brouillon, utilisateur et tenant.
2. Distinguer les signaux : `5xx` est une erreur d'exploitation; `409` est un conflit fonctionnel attendu. Suivre le taux de `409` et n'alerter que sur une hausse anormale, pas sur chaque conflit.
3. Ajouter ou confirmer la sonde Railway `/api/health` pour bloquer un deploiement non sain. Une sonde de deploiement n'est pas une surveillance continue.
4. Utiliser Railway pour CPU, RAM, disque et reseau. Ajouter un controle applicatif externe ou un outil de telemetrie pour disponibilite, latence et taux `5xx`, que Railway ne calcule pas nativement.
5. Nommer avant activation : responsable principal, suppleant, canal d'alerte, fenetre d'observation, seuils, critere d'arret, commit frontend/backend sain et ordre de retour arriere.
6. Repeter en preview : retrait du flag frontend, retrait du flag backend, redeploiement reussi, `enabled: false`, ecriture refusee fermee et export JSON encore disponible. Documenter ensuite la disponibilite effective du rollback Railway et du retour a un deploiement Netlify precedent.

Preuve de passage future : exemple de journal nettoye, alertes testees, sonde verifiee, responsables et seuils nommes, exercice de retour arriere complet et compte rendu sans donnee sensible.

### Sequence technique candidate apres un accord distinct

1. Lot preparatoire sans production : parametre dataset Budget, extraction des migrations de demarrage, journal structure et tests locaux/preview.
2. Revue unique du diff, des DDL, des permissions et du plan de restauration. Aucune mutation tant que cette revue n'est pas verte.
3. Lot infrastructure explicitement autorise : creer la cible, appliquer les DDL, poser IAM minimal et configurer surveillance, avec stockage Budget toujours desactive.
4. Recette fictive et retour arriere. Les quatre portes ne deviennent `GO` qu'avec leurs preuves.
5. `P5` seulement ensuite : decision humaine distincte sur le perimetre et l'activation backend, puis frontend. L'activation reste interdite si une seule porte est `NO-GO`.

Sources techniques de cadrage : [expiration des tables BigQuery](https://docs.cloud.google.com/bigquery/docs/managing-tables), [time travel et fail-safe](https://docs.cloud.google.com/bigquery/docs/time-travel), [snapshots BigQuery](https://docs.cloud.google.com/bigquery/docs/table-snapshots-intro), [roles IAM BigQuery](https://cloud.google.com/bigquery/docs/access-control?hl=fr), [observabilite Railway](https://docs.railway.com/observability), [metriques Railway](https://docs.railway.com/observability/metrics), [actions de deploiement Railway](https://docs.railway.com/deployments/deployment-actions) et [retour a un deploiement Netlify](https://docs.netlify.com/deploy/manage-deploys/manage-deploys-overview/).

### Ordre d'execution apres un GO explicite

1. Figer la cible, la fenetre, les responsables et le rapport de controle. Relever les valeurs de configuration sans copier les secrets.
2. Appliquer uniquement les deux DDL Budget relus, puis controler noms, region, politiques de conservation et acces effectifs.
3. Activer le backend seul. Verifier `/capabilities`, authentification, lecture/ecriture fictive, isolement, conflit, audit et absence de fuite dans les logs.
4. Activer ensuite le frontend. Verifier sauvegarde explicite, rechargement, bibliotheque, lecture seule, conflit sans ecrasement et export JSON de secours.
5. Observer la fenetre convenue. Au premier critere d'arret, retirer d'abord le flag frontend, puis le flag backend et obtenir un redemarrage ou redeploiement backend reussi. Verifier avec un compte pilote que `/capabilities` retourne `enabled: false` et qu'une tentative de stockage echoue fermee avant de declarer `RETOUR ARRIERE`; conserver tables et audit pour qualification.

Le compte rendu unique doit indiquer `GO`, `NO-GO` ou `RETOUR ARRIERE`, les cinq portes, les commits deployes et les controles effectues. Il ne doit contenir ni secret, montant, contenu de brouillon ou identifiant personnel.

### Conditions qui imposent NO-GO

- Cible, region, conservation, responsable ou fenetre non confirmes.
- Droit BigQuery trop large, acces utilisateur direct, authentification facultative ou secret par defaut.
- Frontend active avant le backend verifie, ou URL de preview presente dans un bundle de production.
- Absence d'export de secours, de gestion 409, de surveillance ou de retour arriere immediat.
- Demande incluant Budget personnel, donnees reelles non autorisees, approbation, realise ou partage implicite.

## Verification locale et limites

`node --test tests/financeBudgetDrafts.test.js` couvre la validation, les gardes, les requetes parametrees, les issues de concurrence et l'integration HTTP Express avec un double BigQuery en memoire.
Ces tests ne prouvent ni l'execution du SQL sur BigQuery reel, ni les IAM, sauvegardes ou performances de production. Aucune collecte de donnees financieres reelles pour ce lot.

## Recette HTTP/JWT de preview

La recette cloud valide le SQL et l'isolation avec des identites applicatives injectees. La recette HTTP distincte valide le chemin deploye complet : login, JWT, relecture du compte courant, permissions Finance, cloisonnement par auteur et tenant, ecriture et conflit de version.

Elle refuse les domaines de production connus, exige HTTPS hors localhost, une attestation `--non-production` et la confirmation exacte de l'URL. Les trois comptes doivent etre des comptes de test pre-provisionnes : un auteur, un autre auteur du meme tenant et un auteur d'un autre tenant. Les identifiants restent uniquement dans l'environnement et ne sont jamais affiches.

```powershell
$env:BUDGET_HTTP_OWNER_EMAIL='...'
$env:BUDGET_HTTP_OWNER_PASSWORD='...'
$env:BUDGET_HTTP_OTHER_OWNER_EMAIL='...'
$env:BUDGET_HTTP_OTHER_OWNER_PASSWORD='...'
$env:BUDGET_HTTP_OTHER_TENANT_EMAIL='...'
$env:BUDGET_HTTP_OTHER_TENANT_PASSWORD='...'
npm run budget:http:check -- --execute --non-production --url https://PREVIEW-BACKEND/api --confirm https://PREVIEW-BACKEND/api
```

Le scénario ne supprime rien : le brouillon synthétique créé reste dans le dataset de test pour l'audit et expire selon la politique de ce dataset. Il ne remplace pas la revue IAM du compte de service.

### Verdict IAM attendu

Pour la preview, le compte de service doit pouvoir créer les jobs de requête dans le projet et lire/écrire uniquement le dataset de test. Le candidat minimal parmi les rôles prédéfinis usuels est `roles/bigquery.jobUser` au niveau projet et `roles/bigquery.dataEditor` au niveau du seul dataset de test ; un rôle personnalisé encore plus étroit pourra ensuite retirer les opérations de structure inutiles. Le rôle Data Editor ne doit pas être accordé au niveau projet, car il permettrait aussi de créer des datasets. Refuser également les rôles de base Owner/Editor et `roles/bigquery.admin`.

Contrôler séparément la politique du projet et l'accès du dataset ; relever les autres groupes ou utilisateurs qui disposent d'un accès direct. Les utilisateurs M3S ne doivent avoir aucun droit BigQuery direct : l'isolation auteur/tenant est imposée par l'API. La revue est en lecture seule et ne modifie jamais les rôles automatiquement.

Sources officielles : [rôles IAM BigQuery](https://docs.cloud.google.com/bigquery/docs/access-control), [contrôle d'accès aux ressources](https://docs.cloud.google.com/bigquery/docs/control-access-to-resources-iam).

## Micro-lot technique isole P1-P4 V1.0

Ce micro-lot traduit le paquet Fast Track confirme le 04-09-2026 sans executer ses operations cloud. Son code est fusionne dans `main` depuis le 06-09-2026, mais cette fusion ne vaut ni migration, ni modification IAM, ni creation de dataset ou table, ni activation Budget. Les cinq portes restent `NO-GO`.

- `P1` : le runtime exige desormais `FINANCE_BUDGET_DATASET`, distinct de `BIGQUERY_DATASET`, ainsi qu'une localisation valide. En production, la cible doit aussi correspondre a `FINANCE_BUDGET_APPROVED_DATASET`; au demarrage, ses metadonnees doivent confirmer la region, le label `purpose=m3s_budget_production`, l'absence d'expiration automatique des tables et partitions, la presence des deux tables Budget puis l'absence d'expiration propre a chacune. Les colonnes, types, nullabilites, partitionnements et clusterings doivent correspondre au contrat DDL attendu. Une preview exige le label `purpose=m3s_budget_test`, une expiration par defaut des nouvelles tables comprise entre deux heures et sept jours, la presence des deux tables, le meme contrat de schema et au moins une heure d'expiration effective restante par table. Toute TTL de partition est interdite afin que l'expiration ne depende ni de la frontiere journaliere ni de dates historiques. Un flag Budget actif sans ces garanties reste ferme avec un motif non sensible. Aucun dataset n'est cree.
- `P2` : le demarrage HTTP ne lance plus les schemas Administration/Management, les trois `ALTER TABLE` Finance ou la creation paresseuse Intelligence. Ces operations sont regroupees dans `schemaMigrations.js`. Les migrations independantes Administration, Management et Intelligence s'executent avant la resolution des sources Finance, afin qu'une table Finance manquante ne bloque pas leur remise en etat. `schema:migrate:isolated` reste en plan par defaut et refuse toute cible autre qu'un dataset ephemere `m3s_migration_test_*` explicitement etiquete et confirme. Le dataset doit imposer une expiration des nouvelles tables comprise entre deux heures et sept jours ; chaque table deja presente doit conserver au moins une heure et au plus sept jours d'expiration effective. Toute TTL de partition est interdite au niveau du dataset comme des tables, car les migrations incluent des partitions datees historiquement. La voie separee `schema:migrate:application` reste aussi en plan par defaut ; son execution exige une cible applicative sans expiration automatique, un tenant sans espace peripherique et une reference d'autorisation identiques dans la commande et l'environnement, plus la confirmation exacte suffixee `:APPLY-SCHEMA`. Elle ne cree ni dataset ni droit IAM et refuse notamment la cible actuelle tant que son expiration automatique de 60 jours n'est pas arbitree.
- `P3` : `NODE_ENV` doit etre explicitement `production`, `development` ou `test`; une valeur absente ou inconnue bloque le demarrage. Toute preview demandant le stockage Budget avec authentification prete refuse deja l'absence de compte actif ou d'email, les identifiants de connexion dupliques, les couples tenant/principal invalides ou dupliques et tout secret PBKDF2 incomplet ou affaibli; le mot de passe fictif en clair reste permis uniquement pour ce repli non productif. Un environnement `production` refuse en plus l'authentification desactivee, un secret de signature faible ou par defaut, tous les mots de passe en clair et les comptes desactives. La connexion et le controle Budget resolvent la meme identite compatible avec les proprietaires deja enregistres. Les secrets PBKDF2 doivent avoir un hash canonique de 32 octets, un sel canonique de 16 octets et 120000 a 1000000 iterations entieres.
- `P4` : les routes Budget emettent un evenement structure avec horodatage, correlation, issue (`completed` ou `aborted`), methode, route normalisee, statut, duree, code fonctionnel et revision. Une fermeture client avant reponse est journalisee une seule fois avec le statut operationnel `499`. Les corps, montants, titres, courriels, tokens, identifiants de brouillon, utilisateur et tenant ne sont pas journalises; le journal HTTP global normalise aussi les routes Budget. Si l'activation demandee est refusee, la capacite expose uniquement le motif de configuration sur liste blanche.

Preuves consolidees au 06-09-2026 : PR 50 fusionnee dans `66986fb`, puis PR 51 dans `b2faa9b`. L'arbre final de `main` est identique au candidat revu `55ec14e`; le verdict Codex final ne releve aucun probleme majeur et les 63 discussions sont resolues. Les 106 tests unitaires, CORS 9/9, les controles Administration, Management, Intelligence, Finance et debug reussissent. Les plans `schema:migrate:isolated` et `schema:migrate:application` restent avec `cloudAccess:false` et `executionAuthorized:false`. Aucune commande `--execute` n'a ete lancee et aucun compte fictif, dataset, table ou droit cloud n'a ete cree par ce lot.

## BUDGET-GATES-REV-001 V0.6 - revue post-fusion P1-P5

Cette matrice est le point de controle unique apres fusion. Elle distingue une protection presente dans le code d'une preuve d'exploitation recevable. Une protection fusionnee ne transforme jamais seule une porte en `GO`. La qualification reste bornee aux brouillons Budget organisation; Budget personnel, approbation, realise et donnees reelles restent hors perimetre.

| Porte | Acquis verifies | Ecart probatoire restant | Role attendu | Verdict |
| --- | --- | --- | --- | --- |
| `P1` Schema et conservation | Dataset Budget distinct exige; cible approuvee, region, labels, schemas, partitionnement, clustering et expirations valides avant ouverture | Cible de production non decidee; conservation des brouillons et audits, sauvegarde, restauration fictive et responsable non confirmes | Responsable donnees avec validation Finance | `NO-GO` |
| `P2` Identite et moindre privilege | DDL retires du demarrage HTTP; migrations explicites fermees par defaut; contrats Intelligence, Administration et Management controles lorsque la commande de migration explicite est executee | Le runtime ne prouve ni l'execution prealable de la migration ni l'absence de derive ulterieure; identites runtime/migration non nommees, matrice IAM effective, retrait de `bigquery.admin` et non-regression de tous les modules non prouves | Responsable plateforme avec revue securite | `NO-GO` |
| `P3` Authentification et secrets | Connexions ambigues refusees; comptes desactives et secrets faibles fermes; aucune cle JWT ephemere par processus admise en production | Gestionnaire de cles persistant et partage absent; rotation multi-instance, trois identites fictives et retrait immediat de droit non testes | Responsable securite et proprietaire IAM | `NO-GO` |
| `P4` Exploitation et retour arriere | Journal Budget nettoye et correle; CORS preserve; sante HTTP 200 et refus non authentifie 401 observes; procedure de retrait des flags documentee | Version de deploiement non prouvee par la sante; seuils 5xx/409, responsables, canal, fenetre et exercice complet de retour arriere non confirmes | Responsable exploitation avec suppleant | `NO-GO` |
| `P5` Decision et perimetre | Frontieres fonctionnelles et fermeture par defaut documentees; stockage Budget non autorise par la fusion | Perimetre pilote, utilisateurs, duree, criteres d'arret et ordre backend/frontend non autorises | Direction metier avec Finance et Administration | `NO-GO` |

### Arbitrage Fast Track suivant

La prochaine revue doit rester une seule decision groupee, mais chaque porte conserve un verdict independant. Elle doit renseigner uniquement les exceptions suivantes :

1. `P1` : projet, dataset et region exacts; conservation des brouillons et audits; responsable; preuve que `assertBudgetDatasetPolicy` ou un controle de metadonnees equivalent a valide sur cette cible les deux tables, schemas, partitionnements, clusterings et expirations attendus; sauvegarde testee et preuve d'une restauration fictive reussie.
2. `P2` : identites runtime et migration; droits effectifs avant/apres; ordre de retrait de l'administrateur; preuve horodatee que la migration explicite a controle les schemas attendus; controle de derive avant ouverture et resultats de non-regression de tous les modules concernes.
3. `P3` : gestionnaire de cles persistant et partage; responsables; fenetre de rotation; preuves d'une rotation multi-instance reussie en preview; recette authentifiee reussie avec les trois identites fictives, leurs principaux distincts, l'isolation par proprietaire et tenant, puis le retrait immediat d'un droit.
4. `P4` : responsable, suppleant, canal, fenetre, seuils et critere d'arret; configuration de la telemetrie disponibilite/latence/5xx et tendance 409; preuves de test des alertes et de la sonde de deploiement; preuve reliant la reponse de sante a la revision backend approuvee effectivement deployee; commits sains et exercice complet de retour arriere.
5. `P5` : perimetre pilote, utilisateurs, duree, criteres d'arret et ordre d'activation backend/frontend; autorisation explicite et limitee, approbateurs metier/Finance/Administration et verdict P5 consignes, uniquement apres `GO` documente de `P1` a `P4`.

Une valeur inconnue reste explicitement `A DECIDER` et maintient la porte concernee a `NO-GO`. Cette revue n'autorise aucune collecte de secret, mutation IAM, DDL, migration, creation de ressource, ecriture de donnee, deploiement ou activation.

### Prochain micro-lot candidat

Preparer, sans l'executer, un paquet `BUDGET-GATES-PLAN-001` contenant les cinq fiches de preuve pre-remplies avec les acquis ci-dessus, les champs d'exception encore vides et un compte rendu GO/NO-GO unique. Aucune autre fiche intermediaire n'est requise. Le lancement d'une collecte interne ou d'une action cloud devra faire l'objet d'une autorisation explicite distincte et bornee.
