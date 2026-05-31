# 🚀 Setup Instructions - M3S Backend

**Status**: ✅ **Prêt à Utiliser**  
**Files Included**: ✅ **Tous les fichiers nécessaires**  
**Dependencies**: ✅ **package.json prêt**  
**Configuration**: ✅ **.env fourni**  

---

## 📋 Étapes de Setup

### **Étape 1: Vérifier les Fichiers**

```bash
# Vous devriez avoir:
ls -la

# Fichiers requis:
✓ server.js
✓ package.json
✓ .env
✓ .gitignore
✓ config/ (dossier)
✓ SETUP-INSTRUCTIONS.md (ce fichier)
```

### **Étape 2: Installer les Dépendances**

```bash
npm install

# Cela installe:
✓ express (serveur web)
✓ cors (CORS support)
✓ dotenv (variables env)
✓ @google-cloud/bigquery (BigQuery client)
✓ body-parser (JSON parsing)
✓ helmet (sécurité)
```

### **Étape 3: Configurer les Credentials GCP** ⚠️ IMPORTANT!

**Sans cette étape, le serveur ne fonctionnera pas!**

#### Option A: Télécharger depuis GCP Console (Recommandé)

1. Allez sur: https://console.cloud.google.com/iam-admin/serviceaccounts

2. Sélectionnez le projet: **`mon-projet-data-2sg`**

3. Cliquez sur le service account:
   ```
   m3s-backend@mon-projet-data-2sg.iam.gserviceaccount.com
   ```

4. Onglet **"Clés"**

5. **"Ajouter une clé"** → **"Créer une clé JSON"**

6. Un fichier JSON va se télécharger

7. **Renommez-le en**: `credentials.json`

8. **Placez-le dans**: `./config/credentials.json`

```bash
# Vérifier:
ls -la config/
# Devrait afficher: credentials.json
```

### **Étape 4: Vérifier le .env**

```bash
# Ouvrir: .env
nano .env  # ou votre éditeur préféré

# Vérifier ces valeurs:
PROJECT_ID=mon-projet-data-2sg
DATASET_ID=m3s_data
GOOGLE_APPLICATION_CREDENTIALS=./config/credentials.json
PORT=3001

# Sauvegarder et fermer (Ctrl+O, Enter, Ctrl+X pour nano)
```

### **Étape 5: Démarrer le Serveur** 🚀

```bash
npm start

# Vous devriez voir:
# ╔════════════════════════════════════════════╗
# ║  🚀 M3S BACKEND API - RUNNING              ║
# ║  URL: http://localhost:3001               ║
# ║  ✅ API IS RUNNING!                        ║
# ╚════════════════════════════════════════════╝
```

### **Étape 6: Tester le Backend** ✅

**Dans un autre terminal:**

```bash
# Test basique
curl http://localhost:3001/api/health

# Réponse attendue:
# {"status":"ok","service":"M3S Backend",...}

# Tester les documents (5,143!)
curl http://localhost:3001/api/documents/count

# Réponse attendue:
# {"success":true,"total":5143,...}

# Voir tous les endpoints
curl http://localhost:3001/api/info
```

---

## ⚡ Troubleshooting

### ❌ "Cannot find module '@google-cloud/bigquery'"

```bash
npm install @google-cloud/bigquery
```

### ❌ "Cannot find file config/credentials.json"

```bash
# Créer le dossier s'il n'existe pas
mkdir -p config

# Télécharger les credentials depuis GCP Console
# et placer dans config/credentials.json
```

### ❌ "Permission denied" ou "Unauthorized"

```bash
# Vérifier que:
# 1. Le fichier credentials.json est au bon endroit
# 2. Le service account a les bonnes permissions:
#    - BigQuery Data Viewer
#    - BigQuery Job User
# 3. Redémarrer le serveur après ajout des permissions
```

### ❌ "Cannot connect to BigQuery"

```bash
# Vérifier:
GOOGLE_APPLICATION_CREDENTIALS=./config/credentials.json

# Et que le fichier existe:
ls -la config/credentials.json
```

### ❌ "Port 3001 already in use"

```bash
# Changer le port dans .env:
PORT=3002  # ou un autre port libre

# Puis redémarrer
npm start
```

---

## 🧪 Tests Rapides

### Test 1: Health Check
```bash
curl http://localhost:3001/api/health
```

### Test 2: Documents Count
```bash
curl http://localhost:3001/api/documents/count
```

### Test 3: Finance Dashboard
```bash
curl http://localhost:3001/api/finance/dashboard
```

### Test 4: Voir tous les endpoints
```bash
curl http://localhost:3001/api/info
```

### Test 5: Recherche (POST)
```bash
curl -X POST http://localhost:3001/api/search \
  -H "Content-Type: application/json" \
  -d '{"query":"rapport","limit":10}'
```

---

## 📊 Endpoints Disponibles

Une fois le serveur lancé, vous avez accès à:

### Documents (5,143 documents!)
```
GET  /api/documents              (liste)
GET  /api/documents/count        (5143)
GET  /api/documents/stats        (stats)
POST /api/search                 (recherche)
```

### Finance
```
GET  /api/finance/dashboard      (KPIs)
GET  /api/finance/transactions   (transactions)
```

### RH
```
GET  /api/rh/dashboard           (KPIs)
GET  /api/rh/employees           (employés)
```

### CRM
```
GET  /api/crm/dashboard          (KPIs)
GET  /api/crm/prospects          (prospects)
```

### Production
```
GET  /api/production/dashboard   (KPIs)
GET  /api/production/inventory   (inventaire)
```

### Général
```
GET  /api/health                 (santé du serveur)
GET  /api/info                   (tous les endpoints)
GET  /api/tables                 (lister tables BigQuery)
```

---

## 🎯 Prochaines Étapes

Une fois que le serveur fonctionne:

1. **Tester les endpoints** avec cURL
2. **Intégrer le React** frontend
3. **Intégrer tous les modules** (GED, Finance, RH, CRM, etc.)
4. **Déployer** en production (Cloud Run ou Railway)

---

## 📖 Documentation de Référence

- **BACKEND-README.md**: Installation détaillée et endpoints
- **INTEGRATION-GUIDE.md**: Exemples code pour React
- **GED-Integration-Example.jsx**: Code React prêt
- **VOUS_ETES_ICI.md**: Vue globale

---

## ✅ Checklist

- [ ] Fichiers présents et vérifiés
- [ ] `npm install` exécuté
- [ ] `.env` configuré
- [ ] `config/credentials.json` téléchargé et placé
- [ ] `npm start` fonctionne
- [ ] `curl /api/health` retourne 200
- [ ] `curl /api/documents/count` retourne 5143
- [ ] Prêt pour intégration React!

---

## 💡 Pro Tips

### Mode Développement (avec rechargement auto)
```bash
npm install -g nodemon  # Installer une fois
npm run dev             # Lancer en mode dev
```

### Logs Détaillés
```bash
# Dans .env:
LOG_LEVEL=debug

# Puis redémarrer
npm start
```

### Désactiver CORS (attention: sécurité!)
```javascript
// Dans server.js, remplacer:
app.use(cors({
  origin: ['*'],  // Tout le monde (⚠️ ATTENTION)
  credentials: true
}));
```

---

## 🚀 C'est Prêt!

**Vous êtes maintenant prêt à:**
- ✅ Accéder à 5,143 documents
- ✅ Voir les KPIs financiers
- ✅ Lister les employés RH
- ✅ Afficher le pipeline CRM
- ✅ Et plus encore!

**Bon développement! 💪**

---

*Setup créé: 25 mai 2026*  
*Status: ✅ Prêt*  
*Support: Voir documentation de référence*
