# BUDGET-T1-D-B-3-B-E3-EVD-001 V0.1 - preuves candidates de fermeture E3

Date de collecte : 10-09-2026.

Statut : paquet probatoire candidat a confirmer ou amender. Il prepare ensemble les quatre preuves demandees pour E3 sans les fermer automatiquement. Il ne selectionne aucun fournisseur ou offre et n'autorise ni E4, compte, essai, depense, secret, cible, installation, connexion, IAM, migration ou execution.

## Perimetre de la collecte

- Sources externes limitees aux documentations officielles actuelles de Supabase et GitHub.
- Inventaire local non intrusif limite a la presence d'outils, au type de depot et a la connectivite IPv6, sans relever ni conserver aucune adresse IP publique ou privee.
- Aucun compte cree, aucune page de paiement ouverte, aucun essai lance et aucune cible contactee.
- Aucune commande de connexion PostgreSQL ou de modification reseau executee.

## Synthese des quatre preuves

| Preuve | Resultat de collecte | Qualification candidate | Decision encore requise |
| --- | --- | --- | --- |
| PRF-01 runner et CIDR | aucun runner a IP fixe existant ; laptop disponible comme client leger avec `/32` ephemere | prete sous amendement | accepter le laptop client et le controle fail-closed de l'IP |
| PRF-02 connexion | pooler de session IPv4 officiellement documente pour migration et soumis aux restrictions reseau | prete sous reserves | remplacer l'exigence de connexion directe par une route de migration officiellement supportee |
| PRF-03 region | region specifique Zurich `eu-central-2` officiellement disponible | prete a confirmer | retenir Zurich pour les donnees synthetiques |
| PRF-04 cout | 25 USD de plan, environ 0,22 USD de branches pour huit heures, marge candidate jusqu'a 35 USD | partiellement fermee | confirmer le plafond et maintenir l'arret avant tout depassement |

Aucune preuve n'est declaree fermee par le present document. La fermeture et la selection relevent d'une decision E3 humaine distincte.

## PRF-01 - runner et CIDR

### Faits observes

- Le depot `m3s-backend` appartient a un compte GitHub de type `User`, pas a une organisation.
- Le depot ne contient aucun workflow ou runner configure pour cette recette.
- Les runners GitHub standards utilisent de nombreuses plages dynamiques que GitHub deconseille d'ajouter a une allowlist.
- Les larger runners avec IP statique exigent une organisation ou entreprise eligible ; ils ne constituent donc pas une capacite actuelle du depot.
- Le laptop ne possede actuellement ni `psql`, `pg_dump`, `pg_restore`, Docker ou Podman.
- Aucune route IPv6 globale active n'a ete observee sur le laptop.
- Aucune preuve de sortie reseau fixe existante n'a ete trouvee.

### Solution candidate

Utiliser le laptop uniquement comme client leger, sans moteur PostgreSQL local ni Docker :

1. relever l'IPv4 publique au debut de la fenetre E4 sans la consigner dans le depot ou le rapport partage ;
2. appliquer exclusivement cette adresse en `/32` aux restrictions Supabase avant toute connexion a PostgreSQL ;
3. relire les restrictions et exiger `Restrictions applied successfully: true` ;
4. verifier l'adresse avant chaque phase de connexion ;
5. si elle change, interrompre immediatement la recette sans elargir la plage ;
6. supprimer l'autorisation `/32`, les secrets et les outils temporaires lors du nettoyage.

Cette solution remplace la notion d'IP permanente par une adresse ephemere epinglee pour la seule fenetre de huit heures. Cet amendement doit etre accepte explicitement en E3.

## PRF-02 - route de connexion

### Faits officiels

- Supabase applique les restrictions CIDR aux connexions directes et aux poolers avant que le trafic atteigne PostgreSQL.
- La connexion directe exige IPv6, sauf option IPv4 payante.
- Le pooler de session sur le port `5432` utilise IPv4.
- La documentation de migration Supabase autorise le pooler de session pour les operations de migration, dont `pg_dump` et la restauration logique.

### Proposition candidate

Retenir le pooler de session IPv4 sur le port `5432` pour `psql`, `pg_dump` et `pg_restore`, avec SSL impose et restriction `/32` prealablement verifiee. La connexion directe reste exclue tant que le runner ne possede pas IPv6 ou qu'aucune option IPv4 distincte n'est autorisee.

Cette route evite l'option IPv4 payante et retire le blocage IPv6 sans relacher la restriction reseau.

## PRF-03 - region

### Fait officiel

Supabase publie `Central Europe (Zurich)` comme region specifique `eu-central-2`. Une region specifique fixe mieux la localisation qu'une region generale Europe, laquelle peut inclure plusieurs juridictions.

### Proposition candidate

Retenir `eu-central-2`, Zurich, pour la recette synthetique :

- proximite avec le pilotage suisse de 2SG ;
- localisation exacte plutot qu'un regroupement regional ;
- aucune donnee personnelle ou reelle autorisee ;
- aucune affirmation de conformite deduite de la seule region.

La region reste non selectionnee tant que la decision E3 n'est pas prononcee.

## PRF-04 - cout plafond

### Revalidation officielle

- Plan Pro : 25 USD par mois.
- Branching absent du plan Free.
- Preview branch : 0,01344 USD par branche et par heure.
- Deux branches pendant huit heures : `2 x 8 x 0,01344 = 0,21504 USD`.
- Les credits compute ne couvrent pas les branches.
- Les branches peuvent aussi produire des frais de stockage et d'egress.

### Proposition candidate

| Poste | Borne |
| --- | ---: |
| plan Pro | 25,00 USD |
| deux branches Micro pendant huit heures | 0,22 USD |
| stockage, egress, taxes et marge | 9,78 USD maximum |
| plafond absolu | 35,00 USD |

Le plafond vaut pour la recette complete et non par branche. Aucun add-on, renouvellement volontaire, ressource persistante ou depassement n'est autorise. Une verification du montant affiche devra preceder toute confirmation de paiement en E4.

## Matrice de fermeture candidate

| Condition E3 | Valeur a confirmer en une fois | Effet de la confirmation |
| --- | --- | --- |
| runner et reseau | laptop client leger, IPv4 `/32` ephemere, controle fail-closed | ferme le choix de methode, pas sa preuve d'execution |
| connexion | pooler de session IPv4 `5432`, SSL et CIDR verifies | amende la connexion directe sans ouvrir la base |
| region | Zurich `eu-central-2` | fixe la region candidate |
| cout | plafond absolu 35 USD | fixe une borne, sans autoriser la depense |

Si ces quatre valeurs sont confirmees, E3 pourra selectionner explicitement Supabase Pro et les deux preview branches Micro dans une decision separee ou groupee. Cette selection ne vaudra jamais ouverture E4.

## Sources officielles consultees

### Supabase

- Tarifs : https://supabase.com/pricing
- Cout des branches : https://supabase.com/docs/guides/platform/manage-your-usage/branching
- Regions disponibles : https://supabase.com/docs/guides/platform/regions
- Restrictions reseau : https://supabase.com/docs/guides/platform/network-restrictions
- Connexions et limites : https://supabase.com/docs/guides/database/connecting-to-postgres/pooling-and-limits
- Migration PostgreSQL : https://supabase.com/docs/guides/platform/migrating-to-supabase/postgres
- Sauvegarde et restauration : https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore
- IPv4 dediee : https://supabase.com/docs/guides/platform/ipv4-address

### GitHub

- Runners heberges : https://docs.github.com/en/actions/reference/runners/github-hosted-runners
- Larger runners : https://docs.github.com/en/actions/reference/runners/larger-runners
- Gestion des larger runners : https://docs.github.com/en/actions/how-tos/manage-runners/larger-runners/manage-larger-runners

## Verdict probatoire V0.1

- **Quatre preuves :** preparees en une matrice unique.
- **Route recommandee :** laptop client leger, pooler de session IPv4 et `/32` ephemere.
- **Region candidate :** Zurich `eu-central-2`.
- **Plafond candidat :** 35 USD au total.
- **Installation ou connexion realisee :** aucune.
- **Selection E3 :** non prononcee.
- **E4 :** fermee.
- **Etat operationnel :** `NO-GO` maintenu.
