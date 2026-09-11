# BUDGET-T1-D-B-3-B-E4-COR-001 V0.1 - arbitrage de connexion apres NO-GO

Date de preparation : 11-09-2026.

Statut : paquet documentaire candidat. Il n'autorise ni reprise E4, ni compte, ni depense, ni secret, ni connexion, ni ressource cloud.

## Objet

Corriger l'ecart bloquant constate par `BUDGET-T1-D-B-3-B-E4-RUN-001` au controle `E4-01`, sans relancer la recette dans la fenetre arretee du 11-09-2026.

La documentation officielle Supabase distingue deux usages :

- le pooler de session IPv4 convient aux clients persistants et aux outils PostgreSQL ordinaires sur un reseau IPv4 ;
- la connexion directe est la route recommandee pour les migrations, `pg_dump`, les sauvegardes et les restaurations.

Le paquet confirme imposait le pooler de session a l'ensemble de P2 a P6. Cette route unique n'est donc pas recevable pour P5.

## Constat ferme

| Point | Valeur |
| --- | --- |
| execution E4 du 11-09-2026 | arretee a P0 avant toute ouverture |
| verdict | `NO-GO` |
| cout engage | `0 USD` |
| ressource residuelle | aucune |
| cause | route pooler non revalidee pour `pg_dump` et `pg_restore` |
| T1-E | demeure ferme |

Ce constat ne remet pas en cause les contrats, validateurs ou doubles fictifs deja livres. Il invalide uniquement la route de connexion unique prevue pour la recette PostgreSQL ephemere.

## Sources officielles revalidees

| Sujet | Source | Fait utile au cadrage |
| --- | --- | --- |
| choix de connexion | https://supabase.com/docs/guides/database/connecting-to-postgres | la connexion directe est recommandee pour migrations, dump, sauvegarde et restauration |
| connexion directe | meme source | IPv6 par defaut ; IPv4 si l'extension IPv4 est active |
| pooler de session | meme source | IPv4 sur le port 5432 ; adapte aux connexions persistantes et outils tiers |
| extension IPv4 | https://supabase.com/docs/guides/platform/manage-your-usage/ipv4 | 0,0055 USD par heure, soit environ 4 USD par mois ; non couverte par le plafond de depense Supabase |
| facturation | https://supabase.com/pricing | offre Pro a partir de 25 USD par mois ; credits de calcul et usages a revalider au moment de la decision |
| sauvegarde et restauration | https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore | la connexion directe est a utiliser si IPv6 est disponible ou si l'extension IPv4 est active |

Les prix sont des valeurs observees le 11-09-2026. Ils doivent etre revalides avant tout paiement.

## Routes candidates

### Route A - directe IPv6, recommandee sous condition

| Element | Regle candidate |
| --- | --- |
| `psql` et controles P2 a P4/P6 | pooler de session IPv4, SSL, port 5432 |
| `pg_dump` et `pg_restore` en P5 | connexion directe IPv6, SSL, port 5432 |
| precondition | compatibilite IPv6 du laptop et du reseau constatee par un resultat booleen nettoye |
| cout additionnel de connexion | aucun add-on IPv4 |
| avantage | suit la recommandation officielle et conserve la marge du plafond |
| reserve | la compatibilite IPv6 doit etre recontrolee sur le reseau effectif de la prochaine fenetre |

### Route B - directe IPv4 avec extension, repli conditionnel

| Element | Regle candidate |
| --- | --- |
| `psql` et controles P2 a P4/P6 | pooler de session IPv4, SSL, port 5432 |
| `pg_dump` et `pg_restore` en P5 | connexion directe IPv4, SSL, port 5432 |
| precondition | extension IPv4 disponible sur chaque cible concernee et facturation exacte affichee avant acceptation |
| cout officiel indicatif | 0,0055 USD par heure et par adresse configuree |
| avantage | compatible avec un reseau client sans IPv6 |
| reserves | hors plafond automatique ; cout et compatibilite avec les preview branches a verifier ; propagation DNS possible |

La route B n'est pas preautorisee. Elle reste un repli a arbitrer uniquement si la route A echoue au controle reseau et si le cout maximal complet reste inferieur ou egal a 35 USD, taxes et frais compris.

## Decision candidate

Retenir une strategie a deux chemins fermes :

1. tester uniquement la compatibilite IPv6 sous forme booleenne, sans consigner d'adresse ;
2. si le resultat est positif, retenir la route A ;
3. si le resultat est negatif, maintenir `NO-GO` tant que disponibilite et cout complet de la route B ne sont pas confirmes ;
4. ne jamais substituer automatiquement le pooler a la connexion directe pour P5 ;
5. exiger une nouvelle autorisation humaine datee apres correction de P0 et du kit operateur.

## Cinq portes correctives

| ID | Controle | Reussite attendue | Echec |
| --- | --- | --- | --- |
| `COR-01` | route officielle | separation pooler/direct inscrite pour chaque phase | `NO-GO` |
| `COR-02` | reseau client | compatibilite IPv6 booleenne verifiee dans la nouvelle fenetre | passer a l'etude bornee de la route B |
| `COR-03` | deux cibles | route directe disponible pour la source et la cible, sans journaliser les hotes | `NO-GO` |
| `COR-04` | cout maximal | offre, branches, calcul, IPv4 eventuelle, taxes et frais inferieurs ou egaux a 35 USD | `NO-GO` |
| `COR-05` | documents et autorisation | P0 et kit corriges, nouvelle date et nouvelle decision explicite | `NO-GO` |

Une porte non prouvee interdit la creation de compte, le paiement, l'installation, la connexion ou la creation d'une branche.

## Corrections documentaires requises apres confirmation

Un micro-lot documentaire distinct devra :

- passer le paquet E4 et le kit operateur en version V0.2 ;
- remplacer la route unique par la matrice phase/connexion ;
- ajouter `COR-01` a `COR-05` au prevol ;
- porter le controle reseau IPv6 avant toute depense ;
- preciser que l'extension IPv4 est hors plafond automatique du fournisseur ;
- conserver les trente-six controles existants et leur ordre ;
- exiger P7 apres toute creation effective de ressource ;
- interdire toute reprise de `RUN-001` et creer une nouvelle reference d'execution.

## Frontieres maintenues

Ce paquet n'autorise pas :

- une reprise E4 ou une nouvelle fenetre ;
- une authentification, des conditions contractuelles ou un paiement ;
- la creation d'une organisation, d'un projet ou d'une preview branch ;
- l'activation d'une extension IPv4 ;
- une connexion, un secret, une IP, un hote ou une chaine de connexion ;
- une route HTTP, IAM M3S, DDL de production, migration ou donnee reelle ;
- une recette preview applicative, le Budget personnel ou l'activation Budget ;
- l'ouverture de T1-E.

## Verdict candidat V0.1

- **Cause du NO-GO :** qualifiee et circonscrite.
- **Route recommandee :** route A, sous controle IPv6 positif.
- **Route de repli :** route B, sous double controle de disponibilite et de cout.
- **Execution :** fermee.
- **Prochaine action :** confirmer ou amender ce paquet, puis preparer les versions V0.2 de P0 et du kit sans relancer E4.

