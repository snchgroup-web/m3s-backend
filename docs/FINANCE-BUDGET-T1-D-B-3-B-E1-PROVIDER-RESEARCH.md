# BUDGET-T1-D-B-3-B-E1-001 V0.1 - recherche officielle de deux fournisseurs

Date de recherche : 10-09-2026.

Statut actualise : recherche E1 confirmee et livree ; liste courte E2 confirmee dans `BUDGET-T1-D-B-3-B-E2-001 V0.1`. Cette recherche compare exactement deux fournisseurs a partir de sources officielles : Supabase et Neon. Elle ne selectionne aucun fournisseur, ne cree aucun compte ou essai, ne declenche aucune depense et n'autorise ni secret, cible, installation, connexion, IAM, migration ou execution.

## Autorisation bornee

E1 autorise uniquement :

1. la consultation de sources officielles actuelles ;
2. la comparaison de deux fournisseurs au maximum pour l'option C ;
3. la formulation d'une recommandation candidate pour E2.

La recherche E1 ne valait initialement ni liste courte confirmee, ni choix d'offre, ni autorisation d'executer `T1-D-B.3-B`. La liste courte a depuis ete confirmee par la decision E2 ; E3 et E4 restent fermes.

## Methode

- Sources limitees aux sites officiels des fournisseurs.
- Fonctions et tarifs verifies le 10-09-2026.
- Aucune page de comparaison tierce, avis commercial ou contenu communautaire utilise.
- Aucune inscription, simulation de paiement, essai ou collecte de donnees personnelles.
- Les prix sont indicatifs, en USD et hors taxes, change, egress, stockage et options non explicitement incluses.
- Les fonctions et tarifs devront etre revalides sur les memes sources immediatement avant toute decision E3.

## Besoin 2SG a couvrir

La cible future doit fournir un PostgreSQL serveur complet et permettre :

- deux environnements neufs et ephemeres, source et restauration ;
- des donnees exclusivement synthetiques ;
- `psql`, `pg_dump` et `pg_restore` ou un equivalent officiellement compatible ;
- trois identites distinctes : proprietaire ephemere, migration et runtime ;
- un runtime limite au DML sur les deux tables V2 ;
- une restriction reseau appliquee avant acces a PostgreSQL ;
- une duree et un cout bornes ;
- une suppression verifiable des environnements et artefacts.

## Synthese comparative

| Critere | Supabase | Neon |
| --- | --- | --- |
| PostgreSQL gere | oui, instance dediee par projet | oui, PostgreSQL serverless |
| environnements isoles | preview branches separees avec identifiants propres | branches avec bases, roles et compute propres |
| donnees de branche | sans donnees de production par defaut | herite du parent ; un parent vierge reste necessaire |
| `pg_dump` et `pg_restore` | connexion directe recommandee pour dump, sauvegarde et restauration | migration entre projets documentee avec `pg_dump` et `pg_restore` non groupes |
| roles minimaux | roles et permissions PostgreSQL configurables | roles et privileges PostgreSQL configurables |
| restriction reseau | restrictions CIDR sur connexions directes et groupees | ouvert a toutes les IP par defaut ; IP Allow et reseau prive annonces sur Scale |
| suppression | preview branch ephemere supprimee a la fermeture de la PR | branches et projets supprimables ; suppression de projet irreversible |
| cout d'entree avec branches | Pro a partir de 25 USD/mois, puis branche Micro a partir de 0,01344 USD/heure | Free a 0 USD ; Launch usage-based, depense type annoncee 15 USD/mois |
| maitrise du cout | Spend Cap du Pro, mais les branches n'y sont pas couvertes | facturation a l'usage ; branches incluses selon plan, excedent environ 0,002 USD/heure |
| adequation actuelle | candidate E2 sous reserves | candidate secondaire, ecartee en premiere intention par la porte reseau |

## Fournisseur 1 - Supabase

### Elements favorables

1. Chaque preview branch est un environnement distinct avec sa propre base et ses propres identifiants.
2. Les branches de preview sont ephemeres et peuvent etre supprimees automatiquement lors de la fermeture ou fusion de la PR.
3. Les branches demarrent sans donnees de production par defaut.
4. La documentation recommande la connexion directe pour les migrations, `pg_dump`, sauvegarde et restauration.
5. Les restrictions reseau filtrent les CIDR avant que le trafic atteigne PostgreSQL et s'appliquent aux connexions directes et groupees.
6. Les roles PostgreSQL, `GRANT`, `REVOKE` et `NOINHERIT` permettent de construire la separation migration/runtime candidate.

### Couts officiels observes

- Le plan Free ne comprend pas Branching.
- Le plan Pro debute a 25 USD par mois.
- Une preview branch Micro commence a 0,01344 USD par heure.
- Les couts de branche incluent aussi, selon usage, disque, egress et stockage.
- Les couts de branches ne sont pas couverts par le Spend Cap et les credits compute ne s'y appliquent pas.

### Reserves obligatoires

- Les restrictions reseau sont ouvertes par defaut tant qu'aucun CIDR n'est configure.
- Un Owner ou Admin doit appliquer et verifier les restrictions avant toute migration.
- La connexion directe est IPv6, sauf option IPv4 ; la compatibilite du futur poste ou runner doit etre verifiee.
- Le CLI Supabase de dump utilise Docker et exclut des schemas internes ; Docker est absent du laptop.
- Un `pg_dump` brut peut inclure des objets geres par Supabase et provoquer des erreurs de restauration. La future recette devra donc limiter explicitement le dump au schema et aux deux tables V2 autorises.
- La creation de branches depuis le tableau de bord est encore presentee comme beta ; sa documentation indique que les roles personnalises crees depuis le tableau de bord ne sont pas captures a la creation d'une branche.
- La fermeture d'une PR ne doit pas etre l'unique garantie de nettoyage : un controle explicite de suppression et de facturation reste requis.

### Verdict candidat E1

`ADMIS POUR E2 SOUS RESERVES`, sans selection. Supabase satisfait le plus directement les exigences reseau, roles, branches et outils, sous reserve d'un acces CIDR fixe, d'une strategie de dump bornee et d'un plafond de cout explicite.

## Fournisseur 2 - Neon

### Elements favorables

1. Le plan Free annonce des branches, 100 CU-heures mensuelles par projet, 0,5 Go de stockage et aucune carte bancaire requise.
2. Les branches possedent leurs propres bases, roles et ressources de calcul.
3. La migration entre deux projets Neon avec `pg_dump` et `pg_restore` est documentee ; la connexion non groupee est exigee pour le dump.
4. Le plan Launch annonce une depense type de 15 USD par mois, une facturation a l'usage et des branches supplementaires a environ 0,002 USD par heure.
5. Les projets et branches peuvent etre supprimes apres la recette.

### Reserves obligatoires

- Neon accepte par defaut les connexions depuis toutes les adresses IP.
- La page tarifaire rattache IP Allow et Private Networking au plan Scale, dont la depense type affichee est 701 USD par mois.
- Les plans Free et Launch ne satisfont donc pas la porte 2SG d'inaccessibilite reseau sans assouplissement explicite de cette porte.
- Une branche herite de son parent ; le parent devrait etre strictement vierge et synthetique.
- Les outils PostgreSQL clients restent necessaires sur un runner autorise ; ils sont absents du laptop.
- La suppression doit etre prouvee separement et aucune branche protegee ne doit etre employee pour cette recette ephemere.

### Verdict candidat E1

`AJOURNE POUR E2 EN PREMIERE INTENTION`. Neon reste un bon candidat technique et economique de repli, mais ne franchit pas la porte reseau actuelle sur ses offres economiques. Il ne redevient candidat principal que si IP Allow est disponible dans une offre acceptable ou si la regle reseau est formellement amendee, ce que ce rapport ne recommande pas.

## Classement candidat pour E2

| Rang | Fournisseur | Qualification E1 | Condition avant E3 |
| ---: | --- | --- | --- |
| 1 | Supabase | admis sous reserves | confirmer CIDR fixe, dump borne, roles, region, cout et nettoyage |
| 2 | Neon | ajourne en premiere intention | resoudre la porte reseau sans adopter un cout disproportionne |

Ce classement ne selectionne ni fournisseur ni offre. Il a ete confirme avec ses reserves par `BUDGET-T1-D-B-3-B-E2-001 V0.1`.

## Questions a fermer avant E3

1. Quel runner autorise disposera de `psql`, `pg_dump` et `pg_restore` sans charger le laptop ?
2. Ce runner possede-t-il une adresse IPv4 ou IPv6 fixe compatible avec les restrictions CIDR ?
3. Quelle region officielle est acceptable pour des donnees strictement fictives ?
4. Quel plafond total en USD, taxes et egress compris, est autorise ?
5. Quelle duree maximale couvre creation, recette, restauration et nettoyage ?
6. Comment prouver la suppression des deux branches, secrets et artefacts sans conserver de contenu sensible ?
7. Comment limiter le dump au schema et aux tables V2 sans inclure les schemas geres du fournisseur ?
8. Qui assume les roles de creation, controle independant et nettoyage ?

## Sources officielles consultees

### Supabase

- Tarifs : https://supabase.com/pricing
- Cout des branches : https://supabase.com/docs/guides/platform/manage-your-usage/branching
- Fonctionnement des branches : https://supabase.com/docs/guides/deployment/branching
- Limites du branchement par tableau de bord : https://supabase.com/docs/guides/deployment/branching/dashboard
- Restrictions reseau : https://supabase.com/docs/guides/platform/network-restrictions
- Connexions et outils PostgreSQL : https://supabase.com/docs/guides/database/connecting-to-postgres
- Roles PostgreSQL : https://supabase.com/docs/guides/database/postgres/roles
- Limites du dump gere : https://supabase.com/docs/guides/self-hosting/restore-from-platform

### Neon

- Tarifs : https://neon.com/pricing
- Migration `pg_dump` / `pg_restore` : https://neon.com/docs/import/migrate-from-neon
- Projets, branches, reseau et suppression : https://neon.com/docs/manage/projects
- Branches protegees et IP Allow : https://neon.com/docs/guides/protected-branches
- Roles PostgreSQL : https://neon.com/docs/manage/roles

## Verdict E1 V0.1

- **Recherche externe bornee :** terminee, deux fournisseurs exactement.
- **Fournisseur prioritaire candidat :** Supabase, sous reserves.
- **Fournisseur secondaire candidat :** Neon, ajourne par la porte reseau.
- **Liste courte E2 :** confirmee par `BUDGET-T1-D-B-3-B-E2-001 V0.1` ; Supabase prioritaire sous reserves, Neon secondaire ajourne par la porte reseau.
- **Compte, essai, depense, secret, cible ou execution :** aucun.
- **Etat operationnel :** `NO-GO` maintenu.
