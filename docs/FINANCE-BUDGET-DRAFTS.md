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
3. Activer uniquement dans cet environnement avec `FINANCE_BUDGET_DRAFTS_ENABLED=true`, `API_REQUIRE_AUTH=true` et une `JWT_SECRET` configuree de 32 caracteres minimum. Ne pas tourner la cle de production implicitement pour satisfaire ce prerequis. La region suit la configuration existante du backend (`US`); tout autre emplacement exige son adaptation explicite avant activation.
4. Verifier sur BigQuery reel: create/read/update, atomicite de l'audit, deux PUT concurrents (un seul succes), version obsolete, isolation entre deux auteurs et deux tenants, droits retires, reponse perdue, table absente, absence de montants dans les logs.
5. Brancher le frontend avec choix explicite du brouillon, statut de sauvegarde, gestion du conflit sans ecrasement et export de secours. Puis activation de production dans le meme lot verifie.

Retour arriere non destructif: retirer les flags frontend puis backend, obtenir les redeploiements reussis et verifier la capacite desactivee ainsi que le refus ferme des ecritures. Conserver les tables et le journal; ne supprimer aucune donnee pour desactiver la fonction.

## Paquet unique de decision production

Une seule revue GO/NO-GO doit couvrir les cinq portes ci-dessous. Chaque porte recoit explicitement le verdict `GO` ou `NO-GO`, avec sa preuve. Une porte non documentee vaut `NO-GO`; le verdict global reste `NO-GO` tant que les cinq portes ne sont pas toutes `GO`. Les acquis de preview ne sont pas automatiquement transposes a la production.

| Porte | Preuve attendue | Verdict candidat au 04-09-2026 |
| --- | --- | --- |
| `P1` Schema et conservation | DDL relus pour la cible exacte, region confirmee, expiration/conservation et sauvegarde decidees | `NO-GO` - cible, region et conservation de production non confirmees |
| `P2` Identite et moindre privilege | Compte de service de production identifie, `jobUser` borne et acces dataset sans droit direct des utilisateurs M3S | `NO-GO` - IAM valide uniquement en preview |
| `P3` Authentification et secrets | `API_REQUIRE_AUTH=true`, secret JWT conforme, comptes pilotes et retrait de droits testes sans exposer de secret | `NO-GO` - recette authentifiee valide uniquement en preview |
| `P4` Exploitation et retour arriere | Alertes 5xx/409, journal sans montants, responsable, fenetre, critere d'arret et retrait des deux flags repetes | `NO-GO` - surveillance et retour arriere non repetes sur la cible de production |
| `P5` Decision et perimetre | Autorisation explicite limitee aux brouillons Budget organisation, sans personnel, approbation ni realise | `NO-GO` - aucune autorisation d'activation |

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
