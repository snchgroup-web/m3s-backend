# GED institutionnelle V0.1

Lot limite au cycle interne Organisation documentaire, version 0.1.

- Une version immuable, cinq fichiers connus, deux liens `GD-005` / `GD-006`.
- Stockage prive existant, region Zurich, namespace `ged-institutionnel/v1`.
- Aucun changement des 46 objets `ged-private`, de leur registre, ni du catalogue documentaire historique.
- Aucune route d'import, de remplacement ou de suppression. La preparation controlee est hors application.
- Aucun nouveau role SQL, secret, droit IAM ou abonnement.

## Activation

Le profil `M3S_GED_INSTITUTIONAL_PROFILE=document-cycle-v01` ne suffit pas seul.
Le manifeste `referentiels/gedInstitutionalV01.json` doit contenir les cinq generations verifiees.
Le compte Google doit correspondre a l'acteur autorise, au tenant `2sg` et a la permission existante `administration:resources:read`.
Chaque lecture exige les deux references exactes dans `management_dossiers`.

`GET /api/ged/institutional/document-cycle-v01` retourne seulement les metadonnees autorisees.
`GET /api/ged/institutional/document-cycle-v01/files/:sha256` retourne une piece jointe inerte.
Les generations, longueurs et empreintes sont controlees avant retour des octets.
HTML et JSON ne sont jamais executes dans M3S. Aucun chemin arbitraire ni URL de stockage n'est accepte.

## Repli Et Recuperation

Desactiver le profil ferme cette extension sans supprimer les fichiers ou les references.
Les dossiers conservent leur statut : une preuve de preparation n'est pas une adoption, une livraison ou une reception.
Les copies chiffrees PC/USB du lot comprennent les cinq octets sources/relus, le manifeste de generations et les snapshots des references.
Leur restauration de controle est isolee et ne modifie pas le cloud.
Une restauration reelle doit verifier les empreintes et l'etat courant, sans ecraser une generation existante.
Une nouvelle generation exige une nouvelle qualification du manifeste et une publication controlee.
Ces archives ne constituent pas une sauvegarde complete ni atomique de M3S.

## Controles Cibles

`node --test tests/gedInstitutional.test.js` : 13 controles du nouveau perimetre.
Les anciens parcours utilisateurs acquis ne sont pas rejoues pour ce lot.
