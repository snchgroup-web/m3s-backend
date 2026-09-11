# BUDGET-T1-D-B-3-B-E4-COR-002 V0.1 - requalification du pooler de session

Date de preparation : 11-09-2026.

Statut : paquet documentaire candidat. Il ne relance pas E4 et n'autorise ni compte, ni depense, ni secret, ni connexion, ni ressource.

## Objet

Requalifier la route de connexion de P5 apres :

- le `NO-GO` prudent de `RUN-001` ;
- le controle booleen IPv6 autorise le 11-09-2026 ;
- la lecture comparee des guides officiels Supabase generaux et specialises.

## Resultat reseau nettoye

| Controle | Resultat |
| --- | --- |
| prise en charge IPv6 par le systeme | oui |
| resolution DNS IPv6 sur le reseau courant | non |
| acces HTTPS force en IPv6 | non |
| contre-verification sur une seconde cible publique | non |

Aucune adresse IP, interface, route, hote technique ou autre donnee reseau n'est conservee. La route directe IPv6 n'est pas utilisable sur le reseau courant.

## Ecart entre les sources officielles

| Source | Indication utile |
| --- | --- |
| https://supabase.com/docs/guides/database/connecting-to-postgres | recommande la connexion directe pour migrations, `pg_dump`, sauvegarde et restauration |
| https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore | demande le pooler de session par defaut ; la connexion directe est une alternative si IPv6 ou l'extension IPv4 est disponible |
| https://supabase.com/docs/guides/platform/migrating-within-supabase/dashboard-restore | demande egalement le pooler de session par defaut pour la restauration |
| https://supabase.com/docs/guides/platform/migrating-to-supabase/postgres | utilise le pooler de session pour les operations `pg_dump` et `pg_restore` |

La source generale et les guides operatoires ne sont pas parfaitement alignes. Le `STOP` de `RUN-001` reste donc justifie : il a empeche toute depense face a une contradiction non arbitree.

## Qualification de notre P5

P5 ne migre ni une production ni une plateforme complete. Il manipule exclusivement :

- deux preview branches neuves ;
- le schema Budget V2 autorise ;
- deux tables V2 ;
- des fixtures synthetiques bornees ;
- un artefact logique ephemere supprime en P7.

Ce cas est compatible avec la voie operatoire specialisee utilisant le pooler de session IPv4.

## Route C candidate recommandee

| Element | Valeur bornee |
| --- | --- |
| mode | pooler de session IPv4 |
| port | `5432` |
| chiffrement | SSL obligatoire |
| outils | `psql`, `pg_dump`, `pg_restore` seulement |
| source | premiere preview branch synthetique |
| restauration | seconde preview branch synthetique |
| reseau | IPv4 courante limitee a un `/32`, non consignee |
| volume | schema et deux tables Budget V2 uniquement |
| concurrence | aucune restauration parallele |
| extension IPv4 | non requise, non autorisee |

Le pooler de transaction sur le port `6543` est exclu. La connexion directe IPv6 reste une alternative uniquement sur un autre reseau recontrole ; l'extension IPv4 payante n'est pas retenue.

## Portes de reprise adaptees

| ID | Controle | Critere de passage |
| --- | --- | --- |
| `COR-01` | sources officielles | contradiction consignée et guide operatoire specialise retenu |
| `COR-02` | reseau | IPv6 indisponible et route C IPv4 selectionnee sans adresse consignee |
| `COR-03` | cibles | pooler de session disponible sur les deux branches apres P3 |
| `COR-04` | cout | offre, branches, calcul, taxes et frais inferieurs ou egaux a 35 USD ; aucun add-on IPv4 |
| `COR-05` | gouvernance | P0 et kit V0.3 confirmes, nouvelle date et nouvelle autorisation explicite |

La partie documentaire de `COR-01`, `COR-02`, `COR-04` et `COR-05` precede toute depense. `COR-03` est verifiee effectivement apres la creation des branches et avant P4 ; son echec impose `STOP` puis P7.

## Criteres d'arret propres a la route C

Prononcer `STOP` si :

- le tableau de bord ne fournit pas un pooler de session sur le port 5432 pour chaque branche ;
- le client tente le port 6543 ou un mode transactionnel ;
- SSL, la restriction `/32` ou la version des clients n'est pas conforme ;
- le dump depasse le schema et les deux tables autorises ;
- la restauration exige un objet gere, une donnee reelle ou un droit supplementaire ;
- une source officielle actuelle retire la compatibilite de la route C ;
- le cout maximal ou le nettoyage ne peut plus etre garanti.

## Frontieres maintenues

Ce paquet n'autorise pas :

- une nouvelle fenetre ou une reprise E4 ;
- un compte, des conditions, un paiement ou une depense ;
- une connexion Supabase, une branche, un role ou un secret ;
- une extension IPv4 ;
- une route HTTP, IAM M3S, migration de production ou donnee reelle ;
- une recette preview applicative, le Budget personnel ou l'activation Budget ;
- l'ouverture de T1-E.

## Verdict candidat

- **Route A directe IPv6 :** indisponible sur le reseau courant.
- **Route B directe IPv4 payante :** non retenue.
- **Route C pooler de session IPv4 :** recommandee sous les controles ci-dessus.
- **Execution :** fermee.
- **Prochaine action :** confirmer ou amender `COR-002`, P0 V0.3 et le kit V0.3 dans un seul arbitrage documentaire.
