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
3. En test, activer avec `FINANCE_BUDGET_DRAFTS_ENABLED=true`, `API_REQUIRE_AUTH=true` et soit une `JWT_SECRET` generee par `npm run auth:secret`, soit un trousseau fictif partage. En production, tant que Budget est desactive, la configuration JWT existante reste utilisee sans rotation implicite. Une demande d'activation Budget interdit `JWT_SECRET` et exige `M3S_AUTH_SIGNING_KEYS_JSON`, trousseau persistant fourni par l'environnement et partage par toutes les instances. Le serveur ne genere aucune cle par processus et ne remplace jamais silencieusement le secret historique. La recette multi-instance reste une preuve P3 obligatoire avant GO production. La region suit la configuration existante du backend (`US`); tout autre emplacement exige son adaptation explicite avant activation.
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

## BUDGET-GATES-REV-001 V0.7 - revue post-fusion P1-P5

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

1. `P1` : projet, dataset et region exacts; politique de conservation versionnee pour brouillons et audits; responsable; preuve que `assertBudgetDatasetPolicy` ou un controle de metadonnees equivalent a valide sur cette cible les deux tables, schemas, partitionnements, clusterings et expirations attendus; sauvegarde testee et preuve d'une restauration fictive reussie.
2. `P2` : identites runtime et migration; inventaire des droits effectifs avant/apres couvrant tous les principaux, groupes et heritages; preuve qu'aucun utilisateur ou groupe M3S ne dispose d'un acces direct aux donnees BigQuery; ordre et preuve du retrait de l'administrateur; preuve horodatee que la migration explicite a controle les schemas attendus; controle de derive avant ouverture et resultats de non-regression de tous les modules concernes.
3. `P3` : gestionnaire de cles persistant et partage; responsables; fenetre de rotation; preuves d'une rotation multi-instance reussie en preview; recette authentifiee reussie avec les trois identites fictives, leurs principaux distincts, l'isolation par proprietaire et tenant, puis le retrait immediat d'un droit; preuve qu'un jeton deja emis est refuse apres desactivation de son compte.
4. `P4` : responsable, suppleant, canal, fenetre, seuils et critere d'arret; exemple de journal Budget nettoye; configuration de la telemetrie disponibilite/latence/5xx et tendance 409; preuves de test des alertes et de la sonde de deploiement; preuve reliant la reponse de sante a la revision backend approuvee effectivement deployee; commits sains et exercice complet de retour arriere.
5. `P5` : perimetre pilote, utilisateurs, duree, criteres d'arret et ordre d'activation backend/frontend; autorisation explicite et limitee, approbateurs metier/Finance/Administration et verdict P5 consignes, uniquement apres `GO` documente de `P1` a `P4`.

Une valeur inconnue reste explicitement `A DECIDER` et maintient la porte concernee a `NO-GO`. Cette revue n'autorise aucune collecte de secret, mutation IAM, DDL, migration, creation de ressource, ecriture de donnee, deploiement ou activation.

### Prochain micro-lot candidat

Preparer, sans l'executer, un paquet `BUDGET-GATES-PLAN-001` contenant les cinq fiches de preuve pre-remplies avec les acquis ci-dessus, les champs d'exception encore vides et un compte rendu GO/NO-GO unique. Aucune autre fiche intermediaire n'est requise. Le lancement d'une collecte interne ou d'une action cloud devra faire l'objet d'une autorisation explicite distincte et bornee.

## BUDGET-GATES-PLAN-001 V1.0 - plan probatoire groupe P1-P5

### Decision et portee

- Autorite : Cheikh, Direction 2SG.
- Decision du 06-09-2026 : plan autorise et valide avec ses etapes probatoires requises.
- Objet : qualifier en une seule trajectoire les cinq portes de preparation du pilote Budget organisation.
- Autorise : preparation documentaire, controles locaux, collecte interne bornee en lecture seule, consultation de metadonnees non sensibles, tests sur donnees fictives en environnement isole, revue technique et compte rendu groupe.
- Non autorise par ce plan : lecture ou copie de secrets, mutation IAM, DDL ou migration cloud, creation de dataset ou table, ecriture de donnees reelles, modification de variable, rotation de secret de production, deploiement, activation backend/frontend ou ouverture du Budget personnel.
- Regle : une autorisation de travail ne vaut pas preuve. Chaque porte reste `NO-GO` jusqu'a satisfaction de tous ses criteres et prononce explicite de son verdict.

### Parametres communs pre-remplis

| Champ | Valeur de travail | Etat |
| --- | --- | --- |
| Projet observe | `mon-projet-data-2sg` | Observe le 04-09-2026 |
| Dataset applicatif existant | `m3s_2sg`, region `US`, expiration par defaut 60 jours | Observe; non retenu comme cible Budget |
| Dataset Budget recommande | `m3s_budget_prod`, meme projet, region `US` | Candidat; non cree |
| Perimetre fonctionnel | Brouillons Budget organisation uniquement | Confirme |
| Hors perimetre | Budget personnel, approbation, realise, donnees reelles | Confirme |
| Code de reference | `main` apres `d7812d8`; micro-lot P1-P4 dans `b2faa9b` | Fusionne |
| Etat fonctionnel | Stockage Budget desactive; acces non authentifie refuse | Observe |
| Donnees de recette | Trois identites fictives sur deux tenants; aucune donnee reelle | Requis |
| Rapport final | Un seul compte rendu P1-P5, exceptions uniquement | Requis |

### Fiche P1 - schema, conservation et restauration

| Champ | Valeur pre-remplie |
| --- | --- |
| Objectif | Prouver que la cible Budget exacte protege les schemas, la conservation et la restauration attendus. |
| Acquis | `FINANCE_BUDGET_DATASET` est distinct; le runtime controle projet, region, label, schemas, partitionnement, clustering et expirations avant ouverture. |
| Cible candidate | Projet `mon-projet-data-2sg`; dataset `m3s_budget_prod`; region `US`; label `purpose=m3s_budget_production`. |
| Valeurs a decider | Conservation des brouillons; conservation du journal; retention des sauvegardes; frequence; responsable donnees; validateur Finance. |
| Methode autorisee | Relire les DDL et le plan; consulter les metadonnees de la cible si elle existe; executer localement les validateurs sur doubles fictifs; preparer un protocole de sauvegarde/restauration isole. |
| Preuves recevables | Export horodate des metadonnees; politique de conservation versionnee; sortie nettoyee du validateur; compte rendu de sauvegarde et restauration fictive reussie. |
| Critere `GO` | Cible exacte approuvee; aucune expiration non voulue; contrats conformes; politique approuvee; restauration fictive reussie; responsables nommes. |
| Etat initial | Dataset non cree, politique et exercice non confirmes. |
| Verdict initial | `NO-GO` |

### Fiche P2 - identites techniques et moindre privilege

| Champ | Valeur pre-remplie |
| --- | --- |
| Objectif | Separer migration et runtime sans rupture des fonctions ni acces direct des utilisateurs M3S aux donnees BigQuery. |
| Acquis | DDL retire du demarrage HTTP; migrations explicites fermees par defaut; schemas applicatifs controles lors de la commande autorisee. |
| Identites observees | `m3s-backend@mon-projet-data-2sg.iam.gserviceaccount.com` et `m3s-backend-280@mon-projet-data-2sg.iam.gserviceaccount.com`, actuellement `bigquery.admin` au projet. |
| Valeurs a decider | Identite runtime definitive; identite de migration temporaire; validateur IAM; ordre de retrait; politique de retour arriere. |
| Methode autorisee | Inventorier en lecture seule politiques projet/dataset, principaux, groupes, appartenances et heritages; rapprocher les permissions des chemins runtime; rejouer les tests de non-regression et les plans sans execution. |
| Preuves recevables | Matrice avant/apres exhaustive; absence demontree d'acces direct pour tout utilisateur ou groupe M3S; plans horodates; controle de derive; tests Finance, Administration, Management, Intelligence, Budget et CORS. |
| Critere `GO` | Comptes nommes; runtime au moindre privilege; migration separee; aucun acces direct M3S; retrait administrateur prouve sans regression et retour arriere documente. |
| Etat initial | Droits administrateur et heritages larges encore observes; retrait non execute. |
| Verdict initial | `NO-GO` |

### Fiche P3 - authentification, cles et revocation

| Champ | Valeur pre-remplie |
| --- | --- |
| Objectif | Prouver une authentification fermee, une cle partagee durable et une revocation immediate sur plusieurs instances. |
| Acquis | Production refuse secret faible, mot de passe en clair, compte desactive et identites ambigues; aucune cle ephemere par processus n'est admise. |
| Recette requise | Auteur Finance lecture/ecriture; second auteur du meme tenant; auteur d'un second tenant; variante lecture seule ou retrait de `finance:write`. |
| Valeurs a decider | Gestionnaire de cles persistant; responsable securite; proprietaire IAM; fenetre de rotation; duree de token; mecanisme de revocation. |
| Methode autorisee | Controler la configuration sans afficher les valeurs; generer uniquement des secrets fictifs; tester localement et en environnement isole la connexion, l'isolation, la rotation multi-instance, la desactivation et le retrait de droit. |
| Preuves recevables | Rapport sans secret des trois identites et principaux distincts; isolation auteur/tenant; rotation reussie sur au moins deux instances; ancien secret refuse; jeton deja emis refuse apres desactivation; droit retire immediatement. |
| Critere `GO` | Toutes les recettes passent, responsables et fenetre sont nommes, aucune valeur sensible n'apparait dans les preuves. |
| Etat initial | Gestionnaire partage absent; rotation multi-instance et revocation apres emission non prouvees. |
| Verdict initial | `NO-GO` |

### Fiche P4 - observabilite et retour arriere

| Champ | Valeur pre-remplie |
| --- | --- |
| Objectif | Prouver la detection des incidents, la correlation avec la revision deployee et un retour arriere complet. |
| Acquis | Evenements Budget structures et nettoyes; correlation, statut, duree, code, revision et fermeture client `499`; sante HTTP 200 observee. |
| Signaux requis | Disponibilite, latence, taux `5xx`, tendance `409`, sante de deploiement, revision backend effectivement servie. |
| Valeurs a decider | Responsable et suppleant; canal; seuils; fenetre pilote; critere d'arret; commits backend/frontend de retour. |
| Methode autorisee | Inspecter le format des journaux sans contenu metier; tester localement alertes et sonde; preparer puis repeter en environnement isole le retrait frontend, le retrait backend et le refus ferme des ecritures. |
| Preuves recevables | Exemple nettoye; configuration versionnee des signaux; tests d'alerte; reponse de sante liee a la revision approuvee; chronologie complete de retour arriere et etat final ferme. |
| Critere `GO` | Responsabilites, seuils et canal approuves; alertes et sonde testees; revision prouvee; exercice complet reussi deux fois sans suppression de donnees. |
| Etat initial | Seuils, responsables, canal, revision servie et exercice complet non confirmes. |
| Verdict initial | `NO-GO` |

### Fiche P5 - decision de pilote et activation

| Champ | Valeur pre-remplie |
| --- | --- |
| Objectif | Encadrer un pilote limite apres passage de P1 a P4, sans extension implicite. |
| Perimetre candidat | Brouillons Budget organisation; creation, reprise, conflit de version et export de secours. |
| Exclusions | Budget personnel, enveloppe approuvee, realise, donnees reelles non autorisees, automatisation de paiement et acces BigQuery direct. |
| Valeurs a decider | Utilisateurs pilotes; duree; volume maximum; approbateurs metier/Finance/Administration; criteres d'arret; ordre backend puis frontend; date de revue. |
| Methode autorisee | Preparer la fiche de decision avec cases explicites; verifier les quatre verdicts precedents; ne presenter l'activation que si P1-P4 sont tous `GO`. |
| Preuves recevables | Decision datee et signee; liste bornee des utilisateurs; duree et volume; criteres d'arret; ordre d'activation et retour arriere; quatre verdicts `GO` references. |
| Critere `GO` | Autorisation explicite et limitee prononcee par les trois approbateurs apres P1-P4 `GO`. |
| Etat initial | Le travail probatoire est autorise; l'activation et ses parametres ne le sont pas. |
| Verdict initial | `NO-GO` |

### Sequence Fast Track autorisee

1. `S0 - Gel de reference` : fixer commits, cibles, date, acteurs et exclusions; verifier que Budget reste ferme.
2. `S1 - Collecte interne` : reunir en lecture seule les metadonnees P1, la matrice IAM P2, les configurations non sensibles P3 et les capacites de supervision P4.
3. `S2 - Preuves locales et isolees` : rejouer les tests, plans sans execution, validateurs, recettes fictives et simulations de retour arriere.
4. `S3 - Revue d'exceptions` : ne remonter que les champs non satisfaits, contradictions, donnees sensibles detectees ou regressions.
5. `S4 - Verdict groupe` : renseigner les cinq verdicts independants et calculer le verdict global; une seule porte `NO-GO` impose `NO-GO` global.
6. `S5 - Eventuel lot cloud` : interdit tant qu'une autorisation distincte ne nomme pas exactement cible, commandes, acteurs, fenetre et retour arriere.
7. `S6 - Eventuelle activation` : interdite avant cinq `GO`, decision P5 explicite et ordre backend puis frontend controle.

### Compte rendu GO/NO-GO unique - etat initial

| Porte | Preuves disponibles | Exceptions ouvertes | Verdict |
| --- | --- | --- | --- |
| `P1` | Garde-fous code, cible candidate et contrat de validation | Politique, cible approuvee, sauvegarde/restauration, responsables | `NO-GO` |
| `P2` | Migrations explicites et tests de schema | Identites, matrice effective, absence d'acces M3S direct, retrait admin, non-regression executee | `NO-GO` |
| `P3` | Fermeture auth et validations de secrets/comptes | Gestionnaire partage, rotation multi-instance, trois identites, revocation de token | `NO-GO` |
| `P4` | Journal nettoye, sante et procedure de retour | Seuils, acteurs, canal, revision deployee, alertes et exercice repete | `NO-GO` |
| `P5` | Perimetre et exclusions documentes | Utilisateurs, duree, volume, approbateurs, arret et autorisation d'activation | `NO-GO` |
| **Global** | Plan autorise et pre-rempli | Les cinq portes contiennent encore des exceptions probatoires | **`NO-GO`** |

### Regle de cloture

Le plan passe en statut `EXECUTE` seulement lorsque les sorties de `S1` a `S4` sont jointes au meme paquet et que chaque valeur inconnue est remplacee par une preuve, une decision ou un ajournement motive. Aucun silence, succes de test local ou fusion de code ne vaut autorisation cloud ou `GO` de porte.

### Releve d'execution S0-S4 V0.1 du 06-09-2026

Statut du plan : `EN COURS`. La collecte ci-dessous est en lecture seule et ne contient ni secret, ni contenu de table, ni donnee Budget.

#### S0 - gel de reference

- Reference backend : `origin/main` au commit `d7812d8` apres fusion de `BUDGET-GATES-REV-001 V0.7`.
- Structure documentaire et relevé initial du plan : commit immuable `cb1326d`, parent du correctif de traçabilité dans la PR backend 54.
- Etat de depart : stockage Budget ferme, aucune table Budget dans le dataset applicatif observe et aucune activation autorisee.

#### S1 - collecte interne bornee

- Une identite Google Cloud active permet la lecture des metadonnees; son nom et ses jetons ne sont pas consignes.
- Projet configure : `mon-projet-data-2sg`.
- Dataset applicatif `m3s_2sg` : region `US`; expiration par defaut des tables et partitions `5184000000` ms; 23 tables ou vues; aucune table `finance_budget_*`; aucun label de finalite observe.
- Dataset candidat `m3s_budget_prod` : inexistant au moment du controle. Aucune tentative de creation n'a ete faite.
- Empreinte SHA-256 de la politique IAM projet lue : `a64132531181d7ff48b4ed9b130a364f44303cd153f3d0a3580e601e00d12a32`.
- Roles pertinents observes au projet : deux principaux de type compte de service avec `roles/bigquery.admin`; un compte de service avec `roles/bigquery.jobUser`; un compte de service avec `roles/editor`; un utilisateur avec `roles/owner`.
- Acces du dataset : groupes speciaux `projectWriters`, `projectOwners` et `projectReaders`; un compte backend explicitement lecteur et redacteur; un proprietaire utilisateur explicite. L'appartenance aux groupes speciaux et la qualification du proprietaire comme utilisateur M3S ne sont pas demontrees par cette interface; l'absence d'acces direct M3S ne peut donc pas etre prononcee.
- Sante backend : `/api/health` et `/api/info` repondent `200`; `/api/finance/budget-drafts/capabilities` sans authentification repond `401` avec `Cache-Control: no-store`.
- Les reponses de sante n'exposent aucune revision de deploiement. Aucun outil Railway local n'est disponible pour prouver les alertes, seuils ou canaux pendant ce relevé.

#### S2 - preuves locales et isolees

- Plan de migration isolee : succes, `targetMode: isolated`, `cloudAccess:false`, `executionAuthorized:false`.
- Plan de migration applicative : succes, `targetMode: application`, `cloudAccess:false`, `executionAuthorized:false`.
- DDL Budget imprime pour la cible candidate sans connexion cloud : 12 lignes, empreinte SHA-256 `98975824ded97d7436f840b65a3e02175536eae3f8cf38346c971de2315640b6`.
- Tests cibles Budget et preparation de production : 99/99 reussis.
- Suite backend complete : 106/106 reussie; `git diff --check` propre.

#### S3 - exceptions uniquement

| Porte | Exception apres collecte |
| --- | --- |
| `P1` | La cible recommandee n'existe pas; politique de conservation, responsables, sauvegarde et restauration fictive non fournis. |
| `P2` | Deux comptes restent administrateurs BigQuery; groupes speciaux et proprietaire ont un acces effectif; appartenance M3S non resolue; aucune politique apres retrait ni non-regression cloud. |
| `P3` | Aucun gestionnaire de cles partage, responsable, rotation multi-instance ou essai de revocation sur environnement reel isole n'est disponible. |
| `P4` | Sante sans revision; seuils, responsables, canal, alertes, sonde de deploiement et double exercice de retour arriere non prouves. |
| `P5` | Utilisateurs, duree, volume, approbateurs, criteres d'arret et decision d'activation restent a decider apres P1-P4. |

#### S4 - verdict groupe V0.1

| Porte | Verdict | Motif court |
| --- | --- | --- |
| `P1` | `NO-GO` | Cible et politique probatoire incompletes |
| `P2` | `NO-GO` | Moindre privilege et absence d'acces direct non prouves |
| `P3` | `NO-GO` | Cles partagees et revocation non prouvees |
| `P4` | `NO-GO` | Exploitation et retour arriere non prouves |
| `P5` | `NO-GO` | Activation non instruite et conditionnee par P1-P4 |
| **Global** | **`NO-GO`** | Cinq portes encore ouvertes |

Prochaine action utile : faire revoir ce paquet unique, puis transformer les exceptions P1-P4 en un lot d'execution isole et explicitement cible. La preparation de ce lot reste autorisee; sa mutation cloud demeure soumise a une autorisation distincte nommant les ressources, commandes et fenetre exactes.

## BUDGET-GATES-EXEC-001 V0.1 - micro-lot technique isole P3-P4

Ce candidat traite uniquement les ecarts techniques encore reproductibles localement. Il n'ajoute aucune cle reelle, ne modifie aucune variable, ne contacte aucun gestionnaire de secrets et ne deploie rien.

### P3 - trousseau de signature partage

- Nouvelle variable candidate `M3S_AUTH_SIGNING_KEYS_JSON` : objet strict contenant `activeKeyId` et une liste de une a trois cles `{id, secret}`.
- Les identifiants sont bornes et uniques; les secrets doivent etre des valeurs aleatoires canoniques de 32 octets en base64url, fortes et distinctes.
- Les cles restent non enumerables dans l'objet fournisseur afin d'eviter leur serialisation accidentelle. Aucun secret n'est journalise ou renvoye par une API.
- Les JWT emis avec le fournisseur portent `alg=HS256`, `typ=JWT` et un `kid`. Une signature inconnue, une cle retiree, un en-tete non canonique, une duree hors de 60 secondes a 24 heures ou un jeton expire est refuse.
- Une rotation sans interruption separe la diffusion et l'activation : premier deploiement avec les deux cles et l'ancienne encore active; deuxieme deploiement avec la nouvelle active apres diffusion complete; retrait de l'ancienne seulement apres expiration ou revocation des jetons concernes.
- En production avec Budget demande, `JWT_SECRET` reste interdit et le trousseau partage est obligatoire. En test, le trousseau ou le secret fort historique sont acceptes.
- La migration depuis `JWT_SECRET` utilise un mode explicite : trousseau distribue avec mode `legacy`, puis `M3S_AUTH_SIGNING_MODE=shared` avec double verification, puis retrait de `JWT_SECRET` apres expiration ou revocation. Les anciennes et nouvelles instances restent ainsi compatibles pendant chaque deploiement progressif. Un mode `shared` sans fournisseur valide bloque le demarrage au lieu d'emettre silencieusement un JWT historique.
- Le middleware Budget relit le compte courant apres validation du JWT : un jeton deja emis est refuse en `401` des que le compte est desactive ou ne correspond plus au tenant/principal.

### P4 - revision de sante

- `/api/health` expose maintenant `revision`, issue de `RAILWAY_GIT_COMMIT_SHA`, puis `APP_REVISION`, avec `local` uniquement comme repli non probatoire.
- La revision figure dans les reponses de succes et d'erreur, ce qui permet de relier la sonde a l'artefact backend effectivement servi.
- Cette exposition ne remplace ni la configuration des alertes, ni leur test, ni le double exercice de retour arriere.

### Preuves locales candidates

- Rotation simulee entre deux instances partageant le meme trousseau : ancien et nouveau jetons verifies pendant la transition, ancien jeton refuse apres retrait de l'ancienne cle.
- Trousseaux malformes, cle active absente, doublons, plus de trois cles, secret faible et `kid` inconnu refuses.
- Jeton deja emis puis compte desactive : acces Budget refuse en `401`.
- Suite backend : 110/110 tests; CORS : 9/9; `git diff --check` propre.

Verdicts inchanges : `P3 NO-GO` jusqu'a recette sur deux instances isolees avec responsables et fenetre; `P4 NO-GO` jusqu'aux alertes, seuils, canal et double retour arriere. `P1`, `P2`, `P5` et le verdict global restent egalement `NO-GO`.

## BUDGET-GATES-REV-002 V0.1 - qualification post-fusion P3-P4

### Reference et portee

- Autorisation de fusion : Cheikh, Direction 2SG, le 06-09-2026.
- Candidat revu : `2834c44dfac666c9d4ba42b696344ff52bcd92af`.
- Fusion par squash : PR backend 55, commit `52876c59a82b2073bcda28fc6211725bbc28c46b`.
- Controle d'integrite : arbre du commit fusionne identique a l'arbre du candidat revu; worktree de controle propre.
- Portee : qualification des preuves nouvelles P3-P4 uniquement. Aucune cle, variable, IAM, DDL, migration, ressource, donnee ou activation Budget n'est autorisee par ce relevé.

### Preuves qualifiees en une fois

| Porte | Preuve recevable apres fusion | Limite | Qualification |
| --- | --- | --- | --- |
| `P3` | 110/110 tests couvrent trousseau borne, rotation simulee entre deux instances, double verification pendant la transition, retrait de l'ancienne cle et refus d'un jeton deja emis apres desactivation du compte; CORS 9/9; cinq remarques de revue corrigees et resolues; revue finale sans nouveau constat; GitGuardian vert | Simulation locale uniquement; aucun trousseau partage configure, aucune recette sur deux instances isolees effectivement deployees, aucun responsable ou proprietaire IAM nomme et aucune fenetre de rotation approuvee | Preuve technique partielle; `NO-GO` maintenu |
| `P4` | Railway sert exactement la revision `52876c59a82b2073bcda28fc6211725bbc28c46b`; `/api/health` repond `200` avec BigQuery connecte; les capacites Budget sans authentification restent refusees `401` avec `Cache-Control: no-store` | Seule la preuve de correlation sante/revision est fermee; responsables, suppleant, canal, seuils 5xx/409, fenetre, critere d'arret, tests d'alertes et deux exercices complets de retour arriere restent absents | Ecart revision ferme; `NO-GO` maintenu |

### Exceptions restantes

1. `P3` : nommer responsable securite et proprietaire IAM; fixer une fenetre; executer en preview une recette multi-instance sur identites fictives avec rotation, retrait de cle, desactivation et retrait immediat de droit, sans exposer de secret.
2. `P4` : nommer responsable et suppleant; choisir le canal; fixer fenetre, seuils et critere d'arret; tester alertes et telemetrie; repeter deux fois le retour arriere frontend puis backend jusqu'au refus ferme des ecritures et a la disponibilite de l'export JSON.

### Verdict groupe

| Porte | Verdict | Evolution |
| --- | --- | --- |
| `P3` | `NO-GO` | Capacites de code et simulations locales acceptees comme preuves partielles; exploitation partagee non prouvee |
| `P4` | `NO-GO` | Correlation de la revision deployee prouvee; exploitation, alertes et retour arriere non prouves |
| `P1` | `NO-GO` | Inchange |
| `P2` | `NO-GO` | Inchange |
| `P5` | `NO-GO` | Inchange et toujours conditionne par P1-P4 |
| **Global** | **`NO-GO`** | Aucune activation autorisee |

Prochaine etape Fast Track : preparer un seul paquet d'autorisation ciblee pour la recette preview P3-P4, en nommant environnement, acteurs, fenetre, commandes, valeurs non sensibles, controles et retour arriere. Cette preparation n'autorise ni configuration de production ni execution implicite.

## BUDGET-GATES-AUT-001 V0.1 - paquet candidat de recette preview P3-P4

### Decision actuelle

- Autorite : Cheikh, Direction 2SG.
- Decision : preparation du paquet autorisee le 06-09-2026; aucune execution implicite.
- Statut : `PRET A ARBITRER`, `EXECUTION NO-GO`.
- Objet unique : produire les preuves P3-P4 manquantes dans une preview isolee, avec des identites et donnees fictives seulement.

### Cible bornee

| Element | Valeur candidate |
| --- | --- |
| Projet Railway | `m3s-budget-preview-20260904` uniquement |
| Service principal | `m3s-backend-preview` |
| URL | `https://m3s-backend-preview-production.up.railway.app` |
| Revision backend | `5abd8df142065a11a631490c440328c752fe8cdd` |
| Branche backend epinglee candidate | `codex/budget-p3-p4-authorized-revision-20260906`, creee exactement sur `5abd8df` pendant la fenetre autorisee puis supprimee au nettoyage |
| Environnement applicatif preview | `NODE_ENV=development` obligatoire pendant la recette; `production` est interdit avec le secret historique et le stockage Budget ouvert |
| Projet Google | `mon-projet-data-2sg` |
| Dataset | `m3s_budget_test_20260903`, region `US`, usage test uniquement |
| Tables autorisees | `finance_budget_drafts_v1`, `finance_budget_draft_events_v1` existantes |
| Donnees | Trois identites et brouillons fictifs; aucune donnee reelle ou personnelle |
| Duree candidate | 90 minutes maximum a compter de l'heure de debut consignee |
| Site frontend | Netlify `m3s-frontend-v2`, source `snchgroup-web/m3s-frontend-v2` au commit `e2141df74a38739fb72ae0902f9cce62894f0a0a` |
| Frontend actif de reference | Deploy Preview 327, `https://deploy-preview-327--m3s-frontend-v2.netlify.app` |
| Branche de retour candidate | `codex/budget-p3-p4-preview-rollback-20260906`, issue exactement de `e2141df`; URL Deploy Preview attribuee par Netlify a consigner avant le premier test |

### Acteurs candidats a confirmer en une fois

| Role | Candidat | Responsabilite |
| --- | --- | --- |
| Autorite et critere d'arret | Cheikh | GO/STOP, perimetre et fermeture de la fenetre |
| Operateur technique | Codex | Configuration preview, recette, preuves nettoyees et retour arriere |
| Responsable securite preview | Cheikh | Validation des resultats P3 et absence de secret dans les preuves |
| Proprietaire IAM preview | Cheikh | Confirmation que les droits existants restent limites au dataset test |
| Suppleante proposee | Chantal | Recevoir le signal STOP et confirmer que Cheikh ou Codex reste joignable; a confirmer par Cheikh |
| Canal d'alerte propose | Tache Codex courante | Alerte horodatee dans cette conversation, sans Telegram ni donnee sensible; a confirmer par Cheikh |

### Mutations preview soumises au prochain GO

1. Deployer la revision exacte `5abd8df142065a11a631490c440328c752fe8cdd` sur le seul projet Railway isole.
2. Conserver les variables BigQuery, CORS, Budget et comptes fictifs existantes; relever puis remplacer temporairement `NODE_ENV` par `development`, sans afficher de valeur sensible.
3. Generer hors journal un trousseau fictif borne, puis ajouter uniquement `M3S_AUTH_SIGNING_KEYS_JSON` et `M3S_AUTH_SIGNING_MODE` dans la preview.
4. Creer temporairement, si Railway ne permet pas deux replicas isoles et observables du service principal, un second service `m3s-backend-preview-b` dans le meme projet, sur la meme revision et le meme dataset test. Aucun domaine, service ou replica de production n'est concerne.
5. Modifier uniquement les comptes fictifs de la preview pour tester successivement retrait de `finance:write` et desactivation; restaurer ensuite leur configuration fictive initiale ou fermer les services.
6. Supprimer le service temporaire, retirer le trousseau fictif et remettre le stockage preview a l'etat ferme a la fin de la fenetre, succes ou echec.

### Recette P3 groupee

1. Pre-vol : verifier revision, sante, trois connexions fictives, capacites et refus sans authentification.
2. Coexistence : distribuer le meme trousseau aux deux instances en mode `legacy`; confirmer qu'un jeton historique reste accepte.
3. Bascule : passer une instance en mode `shared`, puis l'autre; verifier sur chaque instance les jetons avec et sans `kid` pendant la transition.
4. Rotation : distribuer ancienne et nouvelle cles avec l'ancienne active; activer la nouvelle apres propagation; retirer l'ancienne et verifier son refus immediat.
5. Revocation : avec un jeton encore valide, retirer `finance:write`, puis desactiver le compte fictif; verifier respectivement le refus d'ecriture et le refus `401` sans attendre l'expiration.
6. Isolation : rejouer auteur, tenant et conflit de version avec les trois identites fictives, sans conserver de contenu metier dans le rapport.

### Recette P4 groupee

1. Verifier `/api/health` sur chaque instance et rapprocher chaque reponse de la revision autorisee.
2. Produire des reponses controlees `401`, `403`, `409` et nominales; verifier les evenements structures sans corps, montant, titre, email, token, brouillon, utilisateur ou tenant.
3. Relever disponibilite, latence, taux `5xx` et tendance `409` selon les seuils fixes ci-dessous. Aucun `5xx` artificiel n'est provoque contre la production.
4. Tester le canal d'alerte confirme et consigner responsable, suppleante, critere d'arret et heure de reception.
5. Executer deux fois le retour arriere : fermer frontend preview, fermer backend preview, redeployer avec succes, verifier `enabled:false`, absence d'action d'ecriture exposee et export JSON disponible. Aucune requete d'ecriture n'est provoquee lorsque le stockage est ferme, afin de ne pas produire artificiellement un `503` incompatible avec le seuil zero `5xx`.

### Seuils et fenetres proposes avant execution

- Fenetre totale : 90 minutes maximum, heure de debut et heure de fin cible consignees avant la premiere mutation.
- Observation : un controle toutes les 15 secondes pendant cinq minutes apres chacune des dix phases groupees `LEGACY_BASELINE`, `PRIMARY_SHARED`, `SECONDARY_SHARED`, `NEW_ACTIVE_BOTH`, `OLD_REMOVED_BOTH`, `WRITE_REMOVED_BOTH`, `OWNER_DISABLED_BOTH`, `ROLLBACK_1_CLOSED`, `ROLLBACK_2_CLOSED` et `FINAL_CLEANUP`. Les deux deploiements d'une meme phase partagent la meme fenetre; aucune observation supplementaire n'est exigee entre eux.
- Disponibilite : 100 % des controles `/api/health`; un seul echec ou statut autre que `200` impose `STOP`.
- Latence : sur au moins 20 requetes controlees par phase, p95 inferieur ou egal a 1 500 ms et maximum inferieur ou egal a 3 000 ms; tout depassement impose `STOP`.
- Erreurs `5xx` : zero pendant toute la fenetre; le premier `5xx` non attendu impose `STOP` et retour arriere.
- Conflits `409` : exactement un conflit provoque par phase de recette et aucun conflit spontane; plus d'un `409` ou plus de 5 % des requetes impose `STOP`.
- Refus `401`/`403` : admis seulement dans les cas negatifs nommes; tout refus nominal impose `STOP`.
- Canal : alerte test envoyee dans la tache Codex courante avant la premiere mutation; absence d'accuse de Cheikh ou de la suppleante signifie `EXECUTION NO-GO`.

### Matrice fermee des evenements Budget attendus

Les comptes ci-dessous sont verifies exactement, service par service et uniquement dans la fenetre horodatee de la phase. Tout statut absent, excedentaire ou inattendu impose `STOP`.

| Phase | Statuts exacts attendus par service |
| --- | --- |
| `HTTP_ACCEPTANCE` | `200:3,201:1,401:1,404:2,409:1` |
| `LEGACY_BASELINE` | `200:1` |
| `PRIMARY_SHARED` | `200:2` |
| `SECONDARY_SHARED` | `200:2` |
| `NEW_ACTIVE_BOTH` | `200:2` |
| `OLD_REMOVED_BOTH` | `200:1,401:2` |
| `WRITE_REMOVED_BOTH` | `200:1,403:1` |
| `OWNER_DISABLED_BOTH` | `401:1` |
| `ROLLBACK_1_CLOSED` | `200:1` |
| `ROLLBACK_2_CLOSED` | `200:1` |
| `FINAL_CLEANUP` | `200:1` sur le seul service principal encore vivant |

### Operations exactes soumises au prochain GO

1. Depuis le worktree backend propre, verifier le plan sans reseau : `npm run budget:http:check -- --plan`.
2. Controler les deux cibles avant mutation avec `Invoke-WebRequest` sur `https://m3s-backend-preview-production.up.railway.app/api/health` et `https://deploy-preview-327--m3s-frontend-v2.netlify.app`; exiger `200`. Relever sans valeur sensible le depot, la branche source, l'identifiant du deploiement, la revision et la valeur `NODE_ENV` initiaux du service principal dans `$originalSourceRepo`, `$originalSourceBranch`, `$originalDeploymentId`, `$originalRevision` et `$originalNodeEnv`; toute valeur absente interdit la suite. Consigner ensuite `$runStartUtc` immediatement avant l'operation 3; cette borne ouvre la fenetre maximale de 90 minutes. Dans une console dediee, enchainer sans pause des blocs `npm run budget:preview:health -- --execute --non-production --phase RUN_GUARD --url https://m3s-backend-preview-production.up.railway.app/api --confirm https://m3s-backend-preview-production.up.railway.app/api` jusqu'au nettoyage final. Chaque bloc dure exactement cinq minutes; ne pas en commencer un dont la fin depasserait `$runStartUtc + 90 minutes`.
3. Avant toute mutation, authentifier une fois la CLI Railway avec `npx @railway/cli login`, puis lier uniquement la cible avec `npx @railway/cli link --project m3s-budget-preview-20260904 --environment production --service m3s-backend-preview`. Executer `npm run budget:preview:logs -- --self-test-alert`; le code retour `2` et le marqueur `BUDGET_PREVIEW_STOP` doivent etre relayes dans la tache Codex courante et acquittes par Cheikh ou Chantal. Sans cet acquittement, ne pas commencer.
4. Dans une console PowerShell locale sans journalisation, capturer deux secrets fictifs distincts deja valides par `hasStrongSigningSecret`, construire le format strict attendu, puis placer seulement le JSON final dans le presse-papiers : `$old = (& node scripts/generate-jwt-secret.js).Trim(); $new = (& node scripts/generate-jwt-secret.js).Trim(); if ($old -eq $new) { throw 'BUDGET_PREVIEW_KEYS_NOT_DISTINCT' }; $keys = @{ activeKeyId = 'preview-old'; keys = @(@{ id = 'preview-old'; secret = $old }, @{ id = 'preview-new'; secret = $new }) } | ConvertTo-Json -Depth 4 -Compress; Set-Clipboard -Value $keys`. Le generateur boucle jusqu'a ce que chaque valeur respecte exactement le validateur du backend; toute erreur ou egalite interdit la suite. Coller immediatement la valeur dans Railway sans la journaliser; apres enregistrement, executer `Set-Clipboard -Value ''; Remove-Variable old,new,keys` et fermer la console. Ne jamais committer ni inclure ces valeurs dans le rapport.
5. Depuis un clone propre de `snchgroup-web/m3s-backend`, verifier que `git rev-parse 5abd8df142065a11a631490c440328c752fe8cdd^{commit}` retourne exactement ce SHA, puis creer la branche distante temporaire epinglee avec `git push origin 5abd8df142065a11a631490c440328c752fe8cdd:refs/heads/codex/budget-p3-p4-authorized-revision-20260906`. Dans Railway, ouvrir uniquement le projet `m3s-budget-preview-20260904`, service `m3s-backend-preview`; sous `Settings > Source`, selectionner `snchgroup-web/m3s-backend` et cette branche temporaire. Sous `Deployments`, exiger le commit complet `5abd8df142065a11a631490c440328c752fe8cdd` avant de poursuivre; toute autre revision impose `STOP`.
6. Dans `Variables`, utiliser l'editeur du service pour mettre `NODE_ENV=development`, ajouter `M3S_AUTH_SIGNING_KEYS_JSON` et `M3S_AUTH_SIGNING_MODE=legacy`, sans modifier les autres noms. Refuser `NODE_ENV=production` ou toute autre valeur. Sous `Deployments`, lancer `Deploy` et attendre `/api/health = 200` avec la revision exacte.
7. Pour la seconde instance, utiliser `New > GitHub Repo`, choisir le meme depot et exactement la branche epinglee `codex/budget-p3-p4-authorized-revision-20260906`, nommer le service `m3s-backend-preview-b`, recopier par l'interface Railway les seules variables du service preview, generer un domaine Railway et consigner son URL. Exiger sur les deux services le SHA complet `5abd8df142065a11a631490c440328c752fe8cdd`; stopper si la revision, le dataset ou une variable non sensible differe. Des que sa sante vaut `200`, consigner `$secondaryStartUtc` et enchainer pour ce service, dans une autre console, les memes blocs `RUN_GUARD` sans pause jusqu'a sa suppression.
8. Apres avoir consigne le domaine du second service dans `$secondary`, ouvrir une fenetre `HTTP_ACCEPTANCE` par service. Dans une premiere console, lancer sa sonde fixe avec `npm run budget:preview:health -- --execute --non-production --phase HTTP_ACCEPTANCE --url <URL-SERVICE>/api --confirm <URL-SERVICE>/api`; sans attendre sa fin, executer dans une seconde console et pendant les cinq minutes bornees la recette HTTP avec les six variables `BUDGET_HTTP_*` chargees dans le processus courant : `npm run budget:http:check -- --execute --non-production --url https://m3s-backend-preview-production.up.railway.app/api --confirm https://m3s-backend-preview-production.up.railway.app/api`, puis la meme paire de commandes en remplacant les URL par `$secondary/api`. Le rapport de la sonde fournit directement `startUtc` et `endUtc`; conserver uniquement les rapports nettoyes. Chaque instance doit produire exactement la matrice `200:3,201:1,401:1,404:2,409:1` et un seul `409` controle.
9. Dans une console persistante distincte, charger seulement `BUDGET_HTTP_OWNER_EMAIL` et `BUDGET_HTTP_OWNER_PASSWORD`, puis lancer `npm run budget:preview:transitions -- --execute --non-production --primary-url https://m3s-backend-preview-production.up.railway.app/api --secondary-url $secondary/api --confirm "https://m3s-backend-preview-production.up.railway.app/api|$secondary/api"`. Cette commande conserve les trois jetons uniquement en memoire, refuse les hotes de production, attend les six confirmations exactes ci-dessous et emet pour chaque phase son `startUtc` et son `endUtc` apres les cinq minutes completes.
10. A l'invite `PRIMARY_SHARED`, modifier uniquement le service principal en `M3S_AUTH_SIGNING_MODE=shared`, conserver les deux cles et `JWT_SECRET`, redeployer et exiger la sante `200`; saisir ensuite `CONFIRM PRIMARY_SHARED`. A l'invite `SECONDARY_SHARED`, appliquer la meme modification au second service, redeployer et saisir `CONFIRM SECONDARY_SHARED`. Le jeton historique sans `kid` et le jeton `preview-old` doivent rester utilisables sur les deux instances.
11. A l'invite `NEW_ACTIVE_BOTH`, remplacer uniquement `activeKeyId` par `preview-new` dans le meme trousseau sur les deux services, redeployer chacun et saisir `CONFIRM NEW_ACTIVE_BOTH`. A l'invite `OLD_REMOVED_BOTH`, retirer la cle `preview-old` et renommer uniquement la variable protegee `JWT_SECRET` en `JWT_SECRET_PREVIEW_ROLLBACK` sur les deux services sans afficher ni changer sa valeur; redeployer puis saisir `CONFIRM OLD_REMOVED_BOTH`. Le script doit alors refuser sur les deux instances le jeton historique et le jeton `preview-old`, tout en acceptant le jeton `preview-new`.
12. A l'invite `WRITE_REMOVED_BOTH`, modifier dans `M3S_AUTH_USERS_JSON` uniquement le compte proprietaire fictif en conservant `finance:read` mais en retirant `finance:write`; ne modifier ni identite, ni tenant, ni credential, appliquer exactement le meme JSON aux deux services, redeployer et saisir `CONFIRM WRITE_REMOVED_BOTH`. A l'invite `OWNER_DISABLED_BOTH`, changer seulement `active` en `false` pour ce compte sur les deux services, redeployer et saisir `CONFIRM OWNER_DISABLED_BOTH`. Le script doit verifier respectivement le refus `403` d'ecriture puis le refus `401` du jeton encore valide.
13. Pour chacune des dix phases groupees nommees ci-dessus, reprendre exclusivement les bornes `startUtc` et `endUtc` emises pendant son execution par le runner de transitions ou le sondeur autonome; ne jamais les reconstruire apres coup. Sans enregistrer les journaux bruts, analyser chaque service encore vivant avec `npx @railway/cli logs --http --service m3s-backend-preview --environment production --since $startUtc --until $endUtc --json | npm run budget:preview:logs -- --http --expected-409 0 --start-utc $startUtc --end-utc $endUtc` et, lorsqu'il existe, la meme commande avec `--service m3s-backend-preview-b`. Chaque ligne HTTP doit contenir `timestamp`, `httpStatus`, `totalDuration` et `path`; chaque analyse doit contenir au moins vingt sondes `/health`, couvrir les deux bornes a trente secondes pres et ne presenter aucun intervalle de sante superieur a trente secondes. Pour les deux fenetres `HTTP_ACCEPTANCE` de l'operation 8, utiliser `--expected-409 1`. Ces controles de phase ne remplacent pas le controle HTTP integral de l'operation 18. Tout code retour `2` impose `STOP`, retour arriere et relais immediat du marqueur dans le canal confirme.
14. Pour chaque phase contenant une requete Budget, verifier aussi le contrat et le compte exact des statuts avec `npx @railway/cli logs --service m3s-backend-preview --environment production --since $startUtc --until $endUtc --filter '@event:budget_request' --json | npm run budget:preview:logs -- --application --expected-revision 5abd8df142065a11a631490c440328c752fe8cdd --expected-statuses <MATRICE-DE-LA-PHASE>`, puis la meme commande pour `m3s-backend-preview-b` lorsqu'il existe. Remplacer `<MATRICE-DE-LA-PHASE>` par la valeur exacte de la matrice fermee ci-dessus, sans espace. L'analyse doit retrouver les dix champs autorises, la route normalisee, la revision autorisee et exactement chaque statut attendu; aucune sortie brute n'est conservee.
15. Avant les retours arriere, restaurer sur les deux backends le `M3S_AUTH_USERS_JSON` fictif initial et verifier une connexion puis les capacites authentifiees. Pour le frontend, creer dans `snchgroup-web/m3s-frontend-v2` la branche exacte `codex/budget-p3-p4-preview-rollback-20260906` depuis `e2141df`; ouvrir une PR vers `main` afin d'obtenir une seule URL Deploy Preview. Le premier commit ne change que le commentaire de cadrage et conserve `REACT_APP_BUDGET_STORAGE_ENABLED=true`; consigner le SHA et l'URL avant test.
16. Cycle de retour arriere 1 : modifier uniquement `netlify.toml` en remplacant `REACT_APP_BUDGET_STORAGE_ENABLED = "true"` par `"false"`, pousser sur la meme branche et attendre le meme Deploy Preview en `200`; mettre ensuite uniquement `FINANCE_BUDGET_DRAFTS_ENABLED=false` sur les deux services backend preview et redeployer. Avec frontend et backend simultanement fermes, verifier l'absence des actions d'ecriture frontend et l'export JSON disponible, sans provoquer de requete d'ecriture backend. Dans une premiere console par backend, lancer `npm run budget:preview:health -- --execute --non-production --phase ROLLBACK_1_CLOSED --url <URL-SERVICE>/api --confirm <URL-SERVICE>/api`; pendant cette fenetre et depuis une seconde console, verifier une seule fois les capacites authentifiees `enabled:false`. Utiliser les bornes du sondeur pour controler journaux HTTP et matrice applicative `200:1`. Seulement apres ce constat complet, remettre le backend a `true`, puis le frontend a `true`, redeployer les trois cibles et verifier leur etat actif avant le cycle 2. Ne jamais publier le frontend comme production.
17. Cycle de retour arriere 2 : repeter dans le meme ordre la fermeture du frontend preview, puis de chacun des deux backends preview. Pendant que les trois cibles sont simultanement fermees, verifier de nouveau l'absence des actions d'ecriture frontend et l'export JSON disponible, sans provoquer de requete d'ecriture backend. Dans une premiere console par backend, lancer `npm run budget:preview:health -- --execute --non-production --phase ROLLBACK_2_CLOSED --url <URL-SERVICE>/api --confirm <URL-SERVICE>/api`; pendant cette fenetre et depuis une seconde console, verifier une seule fois les capacites authentifiees `enabled:false`. Utiliser les bornes du sondeur pour controler journaux HTTP et matrice applicative `200:1`. Ne rien rouvrir apres cette seconde preuve : le frontend temporaire reste ferme jusqu'a la fermeture de sa PR et les deux backends restent obligatoirement avec `FINANCE_BUDGET_DRAFTS_ENABLED=false` pour l'operation 18.
18. Fin de fenetre : conserver d'abord `FINANCE_BUDGET_DRAFTS_ENABLED=false`; restaurer sur le service principal le `M3S_AUTH_USERS_JSON` fictif initial. Si `JWT_SECRET_PREVIEW_ROLLBACK` existe, le renommer en `JWT_SECRET` sans afficher ni changer sa valeur; sinon exiger que `JWT_SECRET` existe deja. Mettre `M3S_AUTH_SIGNING_MODE=legacy`, redeployer et exiger sante `200`; retirer ensuite `M3S_AUTH_SIGNING_KEYS_JSON` et `M3S_AUTH_SIGNING_MODE`, restaurer `$originalNodeEnv`, redeployer et exiger encore sante `200`. Dans une premiere console, lancer sur le service principal `npm run budget:preview:health -- --execute --non-production --phase FINAL_CLEANUP --url https://m3s-backend-preview-production.up.railway.app/api --confirm https://m3s-backend-preview-production.up.railway.app/api`; pendant cette fenetre et dans une seconde console, verifier une seule fois les capacites authentifiees `enabled:false`. Utiliser les bornes du sondeur pour controler la matrice applicative `200:1`. Attendre ensuite la fin du bloc `RUN_GUARD` secondaire courant sans en relancer, prendre son `endUtc` comme `$secondaryEndUtc`, puis analyser toute sa vie avec `npx @railway/cli logs --http --service m3s-backend-preview-b --environment production --since $secondaryStartUtc --until $secondaryEndUtc --json | npm run budget:preview:logs -- --http --expected-409 1 --start-utc $secondaryStartUtc --end-utc $secondaryEndUtc`. Supprimer alors `m3s-backend-preview-b` et fermer sans fusion la PR frontend temporaire. Sur le service principal, restaurer exactement `$originalSourceRepo` et `$originalSourceBranch`, redeployer `$originalDeploymentId`, verifier `$originalRevision`, `$originalNodeEnv`, sante `200` et stockage toujours ferme; seulement apres ces controles, supprimer la branche backend epinglee avec `git push origin --delete codex/budget-p3-p4-authorized-revision-20260906`. Attendre la fin du bloc `RUN_GUARD` principal courant sans en relancer et prendre son `endUtc` comme `$runEndUtc`; analyser toute la fenetre avec `npx @railway/cli logs --http --service m3s-backend-preview --environment production --since $runStartUtc --until $runEndUtc --json | npm run budget:preview:logs -- --http --expected-409 1 --start-utc $runStartUtc --end-utc $runEndUtc`. Les deux rapports doivent confirmer zero `5xx`, aucun enregistrement incomplet, aucune rupture de sondes superieure a trente secondes, sante sans echec et seuils de latence. Tout ecart impose `ECHEC`. Exiger enfin source et `NODE_ENV` initiaux restaures, secret de developpement absent, production inchangee et duree totale inferieure ou egale a 90 minutes.

### Criteres d'arret immediat

- Mauvais projet, environnement, service, dataset ou revision.
- Valeur sensible affichee, copiee dans un journal ou ajoutee au depot.
- Acces a une donnee reelle, personnelle, a un dataset non autorise ou a la production.
- Regression de sante, `5xx` non controle, isolation rompue ou refus de fermeture.
- Depassement de 90 minutes, absence du responsable, de la suppleante ou du canal confirme, ou franchissement d'un seuil ci-dessus.

### Preuves attendues et retour arriere

- Un rapport nettoye unique avec horodatages, revisions, statuts, latences, resultats P3-P4 et aucun secret.
- Deux chronologies de rotation et deux chronologies de retour arriere, chaque etape marquee `SUCCES`, `ECHEC` ou `NON EXECUTEE`.
- Etat final obligatoire : service temporaire absent, variables fictives retirees, stockage preview ferme, production inchangee, donnees fictives seulement.
- Au premier critere d'arret : cesser les tests et mettre `FINANCE_BUDGET_DRAFTS_ENABLED=false`. Si `JWT_SECRET_PREVIEW_ROLLBACK` existe sur le service principal, le renommer en `JWT_SECRET` sans lire ni changer sa valeur; sinon verifier que `JWT_SECRET` est encore present, notamment lors d'un `STOP` entre `PRIMARY_SHARED` et `OLD_REMOVED_BOTH`. Dans les deux cas, passer `M3S_AUTH_SIGNING_MODE=legacy`, redeployer et exiger sante `200`; retirer seulement ensuite `M3S_AUTH_SIGNING_KEYS_JSON` et `M3S_AUTH_SIGNING_MODE`, restaurer `$originalNodeEnv`, redeployer et exiger encore sante `200`. Restaurer le compte fictif initial, supprimer le service temporaire, puis restaurer `$originalSourceRepo`, `$originalSourceBranch` et `$originalDeploymentId` sur le service principal et verifier `$originalRevision` et `$originalNodeEnv` avant de supprimer la branche epinglee. Verifier stockage ferme et absence du secret de developpement, puis classer `RETOUR ARRIERE`. Si aucune des deux variables protegees n'existe, si la source ou `NODE_ENV` initiaux sont inconnus ou si cette restauration echoue, arreter le service principal au lieu de retirer le trousseau ou la branche.

### Arbitrage unique requis avant execution

L'execution reste interdite tant qu'une confirmation unique ne valide pas simultanement : Cheikh comme autorite, responsable securite et proprietaire IAM preview; Codex comme operateur; Chantal comme suppleante; la tache Codex courante comme canal; les seuils, les dix phases groupees et la fenetre de 90 minutes; la revision `5abd8df`; le projet, les deux services Railway, le site Netlify, la branche frontend, le dataset test; les dix-huit operations exactes ci-dessus et le retour arriere. L'URL Netlify attribuee et le domaine du second service sont des sorties de creation a consigner avant test; toute autre cible impose `STOP`. Cette confirmation ne vaudra jamais autorisation de production, P5 ou ouverture du Budget personnel.
