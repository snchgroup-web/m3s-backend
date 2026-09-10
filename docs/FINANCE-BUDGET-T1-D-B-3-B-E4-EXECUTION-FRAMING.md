# BUDGET-T1-D-B-3-B-E4-001 V0.1 - cadrage du paquet d'execution

Date de preparation : 10-09-2026.

Statut : cadrage candidat a confirmer ou amender. Il organise une future recette E4 en huit phases et trente-six controles, sans l'autoriser ni l'executer. Aucun compte, essai, abonnement, paiement, secret, cible, installation, connexion, IAM, migration ou commande PostgreSQL n'est cree ou lance par ce document.

## Configuration E3 acquise

| Champ | Valeur selectionnee pour instruire E4 |
| --- | --- |
| fournisseur | Supabase |
| offre | Pro |
| ressources | deux preview branches Micro neuves |
| region | Zurich `eu-central-2` |
| runner | laptop 2SG comme client PostgreSQL leger |
| route | pooler de session IPv4 sur le port `5432` |
| reseau | IPv4 publique active epinglee en `/32` |
| duree | huit heures maximum sur une meme journee |
| plafond | 35 USD au total |
| donnees | synthetiques uniquement |

Cette configuration est une selection decisionnelle, pas une autorisation operationnelle ou commerciale.

## Frontiere d'autorisation

La confirmation du present cadrage autorisera seulement sa fusion documentaire. L'execution restera interdite tant qu'une nouvelle decision humaine ne precisera pas explicitement :

1. la date et la fenetre de huit heures ;
2. le montant maximal et l'autorisation de depense ;
3. l'autorisation d'ouvrir ou d'utiliser un compte Supabase ;
4. l'autorisation d'installer les seuls clients PostgreSQL necessaires ;
5. l'autorisation de creer les deux branches et les roles ephemeres ;
6. l'autorisation d'executer les trente-six controles ;
7. les responsables presents pour le paiement, le controle et le nettoyage.

Une autorisation incomplete produit `NO-GO` avant toute action.

## Sequence d'execution candidate

| Phase | Objet | Sortie obligatoire | Porte de passage |
| --- | --- | --- | --- |
| P0 | autorisation finale | decision E4 horodatee et bornes confirmees | aucune action avant `GO` explicite |
| P1 | offre et acces humain | prix revalide, consentement et paiement confirmes par Cheikh | total inferieur ou egal a 35 USD |
| P2 | outils et reseau | clients compatibles, IPv4 `/32`, SSL et restriction verifies | aucun secret ou IP dans les preuves |
| P3 | cibles et roles | deux branches neuves, trois roles distincts, inventaires vides | aucun objet ou droit inattendu |
| P4 | source et transactions | schema V2, fixtures synthetiques et controles `3-A` conformes | aucune donnee reelle |
| P5 | sauvegarde et restauration | dump borne et restauration sur seconde branche | aucun schema gere ou objet additionnel |
| P6 | concordance et securite | comptes, empreintes, contraintes, isolation et refus DDL conformes | aucun ecart inexplique |
| P7 | nettoyage et rapport | branches, secrets et artefacts supprimes ; cout final consigne | aucune ressource residuelle |

Les phases sont strictement sequentielles. Un echec interdit de passer a la phase suivante, sauf pour P7 qui doit toujours etre execute afin de nettoyer apres un arret.

## Matrice consolidee des trente-six controles

Etat initial de chaque controle : `NON EXECUTE`.

| ID | Phase | Controle | Preuve nettoyee attendue |
| --- | --- | --- | --- |
| `E4-01` | P0 | revalider offre, prix, region et fonctions | date, source officielle et valeurs sans identifiant de compte |
| `E4-02` | P1 | presenter le montant total et obtenir l'autorisation de depense | montant et decision, sans moyen de paiement |
| `E4-03` | P2 | relever l'IPv4 sans la consigner | confirmation booleenne uniquement |
| `E4-04` | P2 | appliquer le `/32` avant toute connexion | restriction active, adresse masquee |
| `E4-05` | P2 | autoriser et verifier les clients PostgreSQL | noms et versions, sans chemin sensible |
| `E4-06` | P3 | creer deux environnements neufs et synthetiques | references fonctionnelles masquees et inventaires vides |
| `E4-07` | P3 | separer proprietaire, migration et runtime | matrice de droits sans secret |
| `E4-08` | P5 | borner le dump au schema et aux deux tables V2 | liste d'objets admis et empreinte du dump |
| `E4-09` | P2-P6 | verifier l'IPv4 avant chaque phase de connexion | resultat stable ou arret documente |
| `E4-10` | P7 | supprimer cibles, secrets et outils temporaires | confirmations de suppression et cout final |
| `3B-01` | P0 | autorisation distincte de l'execution | reference de decision et limites |
| `3B-02` | P0 | responsables de creation et nettoyage | identites fonctionnelles nommees |
| `3B-03` | P0 | duree de vie | debut, expiration et marge de nettoyage |
| `3B-04` | P3 | cible isolee | absence de connexion a une base M3S existante |
| `3B-05` | P3 | inventaire initial | base neuve sans objet inattendu |
| `3B-06` | P2 | exposition reseau | `/32` seule et restriction active |
| `3B-07` | P3 | proprietaire ephemere | droits de creation et suppression bornes |
| `3B-08` | P3 | identite de migration | DDL limite au plan autorise |
| `3B-09` | P3 | identite runtime | DML sur les deux tables V2 uniquement |
| `3B-10` | P3 | refus de schema au runtime | essais DDL refuses |
| `3B-11` | P3 | refus d'administration au runtime | roles, extensions et bases refuses |
| `3B-12` | P3 | absence d'acces direct utilisateur | aucun utilisateur M3S connecte |
| `3B-13` | P4 | schema source | catalogue et empreinte conformes |
| `3B-14` | P4 | fixtures | identifiants, dates et montants synthetiques |
| `3B-15` | P4 | preuve transactionnelle | vingt controles `3-A` conformes |
| `3B-16` | P5 | sauvegarde logique | artefact ephemere confine et empreinte |
| `3B-17` | P5 | instance de restauration | seconde branche neuve inventoriee |
| `3B-18` | P5 | restauration | fin sans erreur ni objet additionnel |
| `3B-19` | P6 | comptes | memes nombres de brouillons et audits |
| `3B-20` | P6 | empreintes | empreintes source et restauration identiques |
| `3B-21` | P6 | contraintes | unicite et references actives |
| `3B-22` | P6 | isolation | refus inter-tenant et inter-auteur |
| `3B-23` | P6 | refus DDL apres restauration | runtime toujours prive de DDL |
| `3B-24` | P7 | suppression de la sauvegarde | aucun dump residuel |
| `3B-25` | P7 | fermeture des cibles | deux branches supprimees |
| `3B-26` | P7 | rapport final | preuves nettoyees, limites et verdict |

## Gestion des acces, secrets et paiement

- Cheikh realise toute authentification humaine, validation de conditions et confirmation de paiement.
- Aucun numero de carte, code de verification ou facteur d'authentification n'est transmis a Codex, au depot ou au journal.
- Les mots de passe PostgreSQL restent hors des commandes, rapports et captures partagees.
- Une variable de processus ephemere peut etre utilisee seulement pendant E4, puis supprimee avant P7.
- Les noms d'hote, references de projet, adresses IP et chaines de connexion sont masques dans les preuves.
- Aucun secret n'est ajoute a GitHub, Netlify, Railway ou M3S pour cette recette.
- Toute demande d'integration GitHub ou d'autorisation large du depot impose `STOP` et nouvel arbitrage.

## Outils candidats

La future decision E4 devra retenir une methode officielle et bornee pour disposer de :

- `psql` ;
- `pg_dump` ;
- `pg_restore` ;
- un outil de calcul d'empreinte deja present sur Windows.

Sont exclus : moteur PostgreSQL local, Docker, Podman, service resident et installation systeme non bornee. L'installation des seuls clients reste interdite avant autorisation E4 explicite.

## Donnees et objets autorises

- schema Budget V2 deja valide ;
- tables V2 strictement necessaires a la preuve ;
- tenants et acteurs `synthetic-*` ;
- UUID, dates, libelles et montants artificiels ;
- roles ephemeres dedies a la recette.

Sont interdits : budget existant, donnees Finance, identite reelle, justificatif, taux reel, secret M3S, export de production, schema gere Supabase et toute autre table.

## Preuves et livrables attendus

Le rapport final doit contenir uniquement :

1. les versions des outils et du serveur ;
2. les trente-six controles avec `REUSSI`, `ECHEC`, `ARRETE` ou `NON EXECUTE` ;
3. les comptes et empreintes non reversibles ;
4. les heures de debut, arret et nettoyage ;
5. le cout final en USD ;
6. les ecarts, reserves et le verdict technique ;
7. la confirmation de suppression de toutes les ressources.

Ne sont jamais joints : dump, journal brut, adresse IP, chaine de connexion, nom d'hote, reference de projet, mot de passe, capture de paiement ou contenu de table.

## Criteres d'arret

Avant P4, `STOP` immediat si :

- l'autorisation E4 est incomplete ;
- le montant peut depasser 35 USD ;
- Zurich `eu-central-2` n'est pas disponible ;
- une integration GitHub ou un droit large est exige ;
- la restriction `/32` n'est pas verifiable ;
- les clients exigent Docker ou un serveur local ;
- une cible n'est pas neuve ou contient un objet inattendu.

Apres P4, `STOP` controle puis passage direct a P7 si :

- une donnee reelle apparait ;
- un droit runtime est excessif ;
- l'IPv4 change ;
- une sauvegarde sort de l'espace ephemere ;
- une restauration diverge ;
- l'isolation, les contraintes ou l'audit echouent.

## Responsabilites candidates

| Role | Responsable | Action |
| --- | --- | --- |
| autorisation et depense | Cheikh | prononce E4 et confirme le montant |
| authentification et paiement | Cheikh | saisit directement les elements sensibles |
| execution technique | Codex | execute seulement le paquet autorise |
| controle intermediaire | Codex | arrete au premier ecart et rapporte |
| validation du verdict | Cheikh | accepte, reserve ou refuse le resultat |
| nettoyage technique | Codex | supprime les ressources autorisees |
| confirmation finale | Cheikh | constate le nettoyage et la cloture |

## Verdict du cadrage E4

- **Phases :** huit, de P0 a P7.
- **Controles :** trente-six, soit dix controles E4 et vingt-six controles `3-B`.
- **Execution autorisee :** non.
- **Compte, depense, secret ou cible cree :** aucun.
- **E4 :** fermee en attente d'une autorisation distincte.
- **Etat operationnel :** `NO-GO` maintenu.
