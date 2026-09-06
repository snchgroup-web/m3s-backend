# 🚀 M3S Backend - Setup Prêt!

## ✅ Vous Avez Tout Ce Qu'il Faut!

```
backend-setup/
├── server.js                    ← Express + BigQuery
├── package.json                 ← Dépendances npm
├── .env                         ← Configuration (À ÉDITER)
├── .gitignore                   ← Pour Git
├── config/
│   └── credentials.json         ← À TÉLÉCHARGER depuis GCP
├── SETUP-INSTRUCTIONS.md        ← Ce fichier!
└── README.md                    ← Vous lisez ça
```

---

## 🎯 3 Étapes Simples

### **1. Installer (30 secondes)**
```bash
npm install
```

### **2. Configurer (5 minutes)**
- Télécharger credentials.json depuis GCP Console
- Placer dans: `./config/credentials.json`
- Vérifier le `.env`

### **3. Démarrer (30 secondes)**
```bash
npm start

# Vous devriez voir:
# 🚀 M3S BACKEND API - RUNNING
# URL: http://localhost:3001
# ✅ API IS RUNNING!
```

---

## 📚 Documentation Complète

**Pour le setup détaillé:** → `SETUP-INSTRUCTIONS.md`

---

## 🧪 Tester Immédiatement

**Une fois que le serveur tourne (npm start):**

```bash
# Test 1: Health
curl http://localhost:3001/api/health

# Test 2: Documents (5,143!)
curl http://localhost:3001/api/documents/count

# Test 3: Finance
curl http://localhost:3001/api/finance/dashboard

# Test 4: Voir tous les endpoints
curl http://localhost:3001/api/info
```

---

## 📍 Endpoints Disponibles

- **Documents**: 4 endpoints (5,143 documents!)
- **Finance**: 2 endpoints (Dashboard + Transactions)
- **RH**: 2 endpoints (Dashboard + Employees)
- **CRM**: 2 endpoints (Dashboard + Prospects)
- **Production**: 2 endpoints (Dashboard + Inventory)
- **General**: 3 endpoints (Health, Info, Tables)

**Total: 15+ endpoints avec vraies données!**

---

## 🎓 Fichiers Importants

| Fichier | À Faire |
|---------|---------|
| **server.js** | ✅ Prêt - ne pas toucher |
| **package.json** | ✅ Prêt - ne pas toucher |
| **.env** | ⚠️ Vérifier valeurs |
| **config/credentials.json** | ❌ À TÉLÉCHARGER |
| **SETUP-INSTRUCTIONS.md** | 📖 Lire avant de commencer |

---

## ⚠️ Important

### ❌ Ne Pas Oublier Les Credentials!

Sans `config/credentials.json`, le serveur ne fonctionnera pas!

**Télécharger depuis:**
1. https://console.cloud.google.com/iam-admin/serviceaccounts
2. Projet: `mon-projet-data-2sg`
3. Service Account: `m3s-backend@...`
4. Onglet "Clés" → "Ajouter une clé" → "JSON"
5. Placer le fichier dans: `./config/credentials.json`

---

## 🚀 Prochaines Étapes

1. **Setup le backend** (15 min)
2. **Tester les endpoints** (5 min)
3. **Intégrer React** (30 min+)
4. **Déployer** (30 min)

---

## 🔐 Authentification

Le backend expose `POST /api/auth/login`. Les comptes ne doivent pas être écrits dans le code : configurez-les uniquement via les variables d'environnement du serveur.

Variables requises :

```env
# Test/developpement : sortie de npm run auth:secret.
# En production, JWT_SECRET reste compatible tant que Budget est desactive.
JWT_SECRET=<sortie_de_npm_run_auth_secret>
API_REQUIRE_AUTH=true
GOOGLE_CREDENTIALS={"type":"service_account","project_id":"...","private_key":"...","client_email":"..."}
M3S_AUTH_USERS_JSON=[{"email":"admin@example.com","name":"Admin","role":"Administrateur","passwordHash":"base64_hash","passwordSalt":"base64_salt","passwordIterations":120000}]
```

En production Railway, définir ces variables dans le tableau de bord Railway, pas dans GitHub.

`GOOGLE_CREDENTIALS` peut contenir le JSON complet du service account Google, ou ce même JSON encodé en base64. En local, si cette variable est absente, le backend utilise `config/credentials.json`.

Quand `API_REQUIRE_AUTH=true`, tous les endpoints `/api/*` demandent un token `Authorization: Bearer ...`, sauf `/api/auth/login`, `/api/health` et `/api/info`.

Pour générer l'entrée `M3S_AUTH_USERS_JSON` sans stocker le mot de passe en clair :

```bash
npm run auth:hash -- admin@example.com "mot_de_passe_fort" "Admin" "Administrateur"
```

Une activation Budget en production interdit `JWT_SECRET` et exige un trousseau partagé par toutes les instances. Sa valeur reste une variable protégée Railway et ne doit jamais être committée :

```env
M3S_AUTH_SIGNING_KEYS_JSON={"activeKeyId":"budget-AAAA-MM","keys":[{"id":"budget-AAAA-MM","secret":"<43_caracteres_base64url>"}]}
```

Le trousseau accepte au maximum trois clés fortes et distinctes. Pour une rotation sans interruption, ajouter la nouvelle clé, la désigner par `activeKeyId`, redéployer toutes les instances, puis retirer l'ancienne après expiration ou révocation des jetons concernés. Les JWT portent un `kid`; une clé retirée ou inconnue est refusée. Aucun endpoint ni journal n'expose les clés.

Copier uniquement le JSON généré dans Railway. Le mot de passe en clair ne doit pas être commité.

---

## Recette cloud Budget (avant activation)

`npm run budget:cloud:check` affiche seulement le plan : aucun acces Google,
aucun SQL, aucune activation. Le script est independant de `server.js` et ne charge
ni `.env.production`, ni le bootstrap des registres existants.

Une seule execution groupe dix controles : schema, aller-retour CHF/CFA et mois
vides/zero, lecture seule, separation auteur/organisation, version perimee,
deux ecritures concurrentes, rollback atomique, reponse incertaine et audit.
Les identites applicatives sont injectees ; le SQL utilise le vrai client Google.
Cela ne remplace pas la recette JWT/HTTP de l'environnement deploye ni une revue IAM.

Preparer uniquement dans un environnement de test explicitement autorise :

- Dataset neuf et vide, nom `m3s_budget_test_...`, label `purpose=m3s_budget_test`.
- Expiration par defaut des tables entre deux heures et sept jours, sans expiration de partition.
- Projet et localisation explicites ; pas de choix automatique depuis la production.
- Identite Google ADC limitee au test, configuree hors du code et hors du chat.
  Elle doit pouvoir consulter les metadonnees du dataset, lister/creer les tables,
  executer les jobs et lire/modifier ces seules tables. Ne pas reutiliser les cles
  de production ni ajouter de droits globaux pour faire passer un test.
- Dataset reserve a cette execution, sans autre processus concurrent.

Exemple de syntaxe uniquement, noms a remplacer par l'environnement autorise :

```powershell
npm run budget:cloud:check -- --project PROJECT_ID --dataset m3s_budget_test_RUN --location EU
npm run budget:cloud:check -- --project PROJECT_ID --dataset m3s_budget_test_RUN --location EU --execute --confirm PROJECT_ID.m3s_budget_test_RUN
```

Le mode execution cree les deux tables du module et quatre brouillons fictifs ;
aucune lecture des autres registres, creation de dataset, mutation IAM, suppression
ou activation automatique. Une nouvelle recette exige un autre dataset vide.
Les tables et six evenements attendus restent inspectables jusqu'a expiration.
En cas d'echec, ne pas relancer aveuglement : consulter l'etape et les jobs Google
`m3s_budget_test_*`, puis qualifier le resultat avant une nouvelle execution.

Chaque job est limite a 64 Mio facturables ; quarante requetes maximum par recette.
Le delai serveur demande est de 60 secondes par job, sans garantie d'annulation
immediate : un timeout ne prouve jamais l'absence d'ecriture. Aucune relance
applicative automatique. Le resultat JSON ne contient ni montants ni secrets.

Sources techniques : [transactions BigQuery](https://docs.cloud.google.com/bigquery/docs/transactions)
et [limites des jobs](https://docs.cloud.google.com/bigquery/docs/reference/rest/v2/Job).
Conserver le rapport, verifier les droits effectifs et la recette authentifiee,
puis seulement envisager l'activation conjointe backend/frontend. Le budget
personnel et le rapprochement du realise restent hors de cette recette.

**Ready? Read SETUP-INSTRUCTIONS.md and let's go! 🎉**

---

*Créé: 25 mai 2026*  
*Status: ✅ Prêt*
