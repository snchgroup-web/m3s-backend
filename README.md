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

**Ready? Read SETUP-INSTRUCTIONS.md and let's go! 🎉**

---

*Créé: 25 mai 2026*  
*Status: ✅ Prêt*
