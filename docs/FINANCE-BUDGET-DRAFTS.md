# Registre des brouillons Budget organisation

Lot du 03-09-2026. API preparee, desactivee par defaut, sans migration ni activation de production.
Le frontend PR326 conserve son fonctionnement en session avec export/import JSON. Il n'appelle pas encore ce registre.

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

Ne jamais afficher "enregistre" sur erreur. Le futur client devra conserver le brouillon local tant qu'un succes n'a pas ete confirme. Sur une ecriture au resultat incertain, la reponse contient `draftId` et `reconcileRequired: true`: relire cet ID avant toute nouvelle creation, puis comparer le contenu. Ne pas relancer aveuglement un POST. Aucun retry automatique d'ecriture dans ce module.

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

Retour arriere non destructif: retirer le flag, conserver les tables et le journal. Ne supprimer aucune donnee pour desactiver la fonction.

## Verification locale et limites

`node --test tests/financeBudgetDrafts.test.js` couvre la validation, les gardes, les requetes parametrees, les issues de concurrence et l'integration HTTP Express avec un double BigQuery en memoire.
Ces tests ne prouvent ni l'execution du SQL sur BigQuery reel, ni les IAM, sauvegardes ou performances de production. Aucune collecte de donnees financieres reelles pour ce lot.
