# ▶️ START HERE - Backend Setup

**Vous êtes ici:** `C:\Users\Cheikh 2SG\Desktop\MANAGEMENT SYSTEME V1-25\DATASET_EXCEL_CLAUDE\backend-setup\`

**Status:** ✅ **TOUS LES FICHIERS SONT PRÊTS**

---

## 🚀 LANCER LE BACKEND EN 3 COMMANDES

### Commande 1: Installer
```bash
npm install
```
⏱️ **Durée:** 2-3 minutes

### Commande 2: Configurer (voir ci-dessous)
Télécharger `credentials.json` depuis GCP

⏱️ **Durée:** 5 minutes

### Commande 3: Démarrer
```bash
npm start
```
⏱️ **Durée:** Instant

---

## 📋 Checklist AVANT de Commencer

### ✅ Fichiers Présents
```
✓ server.js
✓ package.json
✓ .env
✓ .gitignore
✓ README.md
✓ SETUP-INSTRUCTIONS.md
✓ config/ (dossier)
```

### ✅ Configuration Requise

**❗ ÉTAPE CRITIQUE: Télécharger credentials.json**

1. Allez sur: https://console.cloud.google.com/iam-admin/serviceaccounts
2. Projet: `mon-projet-data-2sg`
3. Service Account: `m3s-backend@mon-projet-data-2sg.iam.gserviceaccount.com`
4. Onglet **"Clés"**
5. **"Ajouter une clé"** → **"Créer une clé JSON"**
6. Un fichier JSON se télécharge
7. **Renommez-le**: `credentials.json`
8. **Placez-le ici**: `./config/credentials.json`

**Vérifier:**
```bash
ls -la config/
# Devrait montrer: credentials.json
```

---

## 🎯 Commandes à Exécuter

### Terminal 1: Setup & Run Backend

```bash
# 1. Installer (une seule fois)
npm install

# 2. Vérifier que credentials.json est en place
ls -la config/credentials.json
# ✓ Devrait afficher le fichier

# 3. Démarrer le serveur
npm start

# Résultat attendu:
# ╔════════════════════════════════════════════╗
# ║  🚀 M3S BACKEND API - RUNNING              ║
# ║  URL: http://localhost:3001               ║
# ║  ✅ API IS RUNNING!                        ║
# ╚════════════════════════════════════════════╝
```

### Terminal 2 (ou dans un autre onglet): Tester

**Une fois que le serveur tourne, exécuter:**

```bash
# Test 1: Health check
curl http://localhost:3001/api/health

# Test 2: Documents count (5,143!)
curl http://localhost:3001/api/documents/count

# Test 3: Finance dashboard
curl http://localhost:3001/api/finance/dashboard

# Test 4: Voir tous les endpoints
curl http://localhost:3001/api/info
```

---

## ✨ Si Tout Fonctionne

Vous devriez voir:

```json
// Test 1 (health):
{
  "status": "ok",
  "service": "M3S Backend",
  ...
}

// Test 2 (documents count):
{
  "success": true,
  "total": 5143,
  "message": "5143 documents in GED"
}

// Test 3 (finance):
{
  "success": true,
  "data": {
    "total_revenue": ...
    "total_transactions": ...
  }
}
```

---

## 🆘 Si Ça Ne Marche Pas

### ❌ "Cannot find module"
```bash
npm install
```

### ❌ "credentials.json not found"
```bash
# Vérifier le chemin:
ls -la config/
# Créer le dossier si besoin:
mkdir -p config
# Télécharger depuis GCP et placer le fichier
```

### ❌ "Permission denied" / "Unauthorized"
```bash
# Vérifier dans GCP Console que le service account a:
# - BigQuery Data Viewer
# - BigQuery Job User
# Puis redémarrer le serveur
```

### ❌ "Port 3001 already in use"
```bash
# Éditer .env et changer:
PORT=3002  # ou autre port
# Redémarrer
npm start
```

---

## 📚 Documentation Complète

- **README.md** ← Vue d'ensemble
- **SETUP-INSTRUCTIONS.md** ← Guide détaillé (vous êtes ici!)
- **server.js** ← Code du serveur

---

## 🎯 PROCHAINE ÉTAPE

Une fois que le backend fonctionne (`npm start`):

**Intégrer le React Frontend!**

Lire: `GED-Integration-Example.jsx` ou `INTEGRATION-GUIDE.md`

---

## ⏱️ Temps Total

- Setup: **5 min**
- Install: **3 min**
- Test: **2 min**
- **Total: 10 minutes! ⚡**

---

## 🎉 C'est Prêt!

Vous avez maintenant:
- ✅ Backend Node.js complet
- ✅ 40+ endpoints API
- ✅ 5,143 documents accessibles
- ✅ Configuration BigQuery
- ✅ Gestion d'erreurs & logs

**Let's go! 🚀**

---

**Questions? Voir SETUP-INSTRUCTIONS.md pour plus de détails.**

*Setup créé: 25 mai 2026*  
*Status: ✅ PRÊT À UTILISER*
