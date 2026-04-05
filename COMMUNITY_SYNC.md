# Mode communauté (multi-appareils)

Par défaut, l'application fonctionne en **stockage local** (`localStorage` + IndexedDB).  
Dans ce mode, chaque téléphone garde ses propres profils/pronostics : rien n'est partagé entre appareils.

Pour centraliser les données, il faut un **serveur communautaire unique** accessible par tout le monde.

## Fais-le maintenant (copier/coller)

Si ton domaine final est `https://pronos.mondomaine.com`, fais exactement ceci :

1. Ouvre `runtime-config.js`.
2. Remplace le contenu par :

```js
window.__FWC26_CANONICAL_ORIGIN__ = "https://pronos.mondomaine.com";
window.__FWC26_COMMUNITY_API__ = "https://pronos.mondomaine.com";
```

3. Lance le serveur :

```bash
COMMUNITY_PORT=8787 node community-server.js
```

4. Fais pointer ton domaine vers ce serveur (reverse proxy HTTPS).
5. Sur chaque téléphone : ouvre **uniquement** `https://pronos.mondomaine.com`, puis ajoute à l'écran d'accueil.

> Résultat attendu : profils séparés par utilisateur, mais notifications / bistro / classement / grilles partagés pour tout le monde.

### Configuration appliquée pour ton URL

URL front finale :
`https://pierrechalvi-alt.github.io/pronoFIFA2026/`

Valeurs configurées :

```js
window.__FWC26_CANONICAL_ORIGIN__ = "https://pierrechalvi-alt.github.io";
window.__FWC26_COMMUNITY_API__ = "https://pronofifa2026-community.onrender.com";
```

⚠️ `github.io` sert uniquement des fichiers statiques : pour avoir les fonctions communes en temps réel, il faut un backend Node séparé pour `/api/health`, `/api/snapshot`, `/api/stream`.

### Backend prêt à déployer (Render)

Le repo contient maintenant `render.yaml` avec le service :
`pronofifa2026-community` (URL attendue : `https://pronofifa2026-community.onrender.com`).

Étapes :

1. Connecte le repo sur Render.
2. Choisis **Blueprint** deploy (Render lit `render.yaml`).
3. Attends le déploiement.
4. Vérifie : `https://pronofifa2026-community.onrender.com/api/health`.

## Mise en place rapide (LAN ou internet)

1. Démarrer le serveur communautaire :

```bash
node community-server.js
```

2. Ouvrir l'app sur chaque appareil via **la même URL d'application** (même domaine/port).

3. Forcer un **hôte unique** (recommandé) dans `runtime-config.js` (ou `index.html`) :

```html
<meta name="fwc26-canonical-origin" content="https://pronos.exemple.com" />
```

> Si un utilisateur ouvre un autre domaine/port, l'app le redirige automatiquement vers cet hôte canonique.

4. Configurer l'endpoint API communautaire (si besoin) dans `runtime-config.js` (ou `index.html`) :

```html
<meta name="fwc26-community-api" content="https://votre-domaine-ou-ip" />
```

5. Recharger l'application sur tous les appareils.

> Si aucun endpoint n'est configuré, le front utilise automatiquement `window.location.origin`.

## Hébergement recommandé (pour des amis hors LAN)

- Héberger **le front + `community-server.js`** sur le même hôte (ex : VPS).
- Exposer le serveur en HTTPS (reverse proxy Nginx/Caddy conseillé).
- Faire pointer tous les téléphones vers la même URL publique (ex : `https://pronos.exemple.com`).
- En PWA, après changement d'URL/API, forcer un rechargement complet ou réinstaller l'app écran d'accueil pour vider le cache service worker.

## Vérification de la synchro

- Vérifier que `GET /api/health` répond `ok: true`.
- Vérifier que `GET /api/snapshot` renvoie un snapshot commun.
- S'assurer que les deux téléphones affichent le même endpoint (bannière "Synchronisation communauté" dans l'app).

### Checklist ultra-simple (à faire en 3 minutes)

1. **Même URL front pour tout le monde**
   - Demander à chaque personne d'ouvrir l'app puis d'afficher l'URL complète dans le navigateur.
   - L'URL doit être strictement identique (même domaine + même chemin), par ex :
     `https://pierrechalvi-alt.github.io/pronoFIFA2026/`
   - Si une personne ouvre une autre URL (ex: autre domaine, autre chemin, ancien favori), elle sera isolée.

2. **Même endpoint API dans la bannière**
   - Dans l'app, regarder la carte **Synchronisation communauté**.
   - La ligne `Endpoint API : ...` doit afficher exactement la même valeur sur tous les appareils.
   - Valeur attendue pour votre config actuelle :
     `https://pronofifa2026-community.onrender.com`

3. **Backend disponible (attention: c'est `/api/health`, pas `/api/healt`)**
   - Depuis n'importe quel navigateur :
     `https://pronofifa2026-community.onrender.com/api/health`
   - Réponse attendue (JSON) : `{"ok":true,...}`
   - En terminal :
     ```bash
     curl -i https://pronofifa2026-community.onrender.com/api/health
     ```
   - Tu dois voir un statut HTTP `200`.

4. **Test réel de partage**
   - Téléphone A : modifier un pronostic.
   - Téléphone B : recharger la page.
   - Le changement doit apparaître.

## Si les utilisateurs restent "isolés" (cas fréquent)

Le cas le plus courant est un **cache PWA ancien** sur les téléphones (ancien `runtime-config.js`), ce qui fait que l'app continue à utiliser le mode local même si la config a été changée.

Procédure rapide sur chaque téléphone :

1. Ouvrir l'app dans le navigateur (pas l'icône écran d'accueil).
2. Faire un rechargement forcé.
3. Vérifier dans la bannière que l'endpoint affiché est bien celui attendu.
4. Si besoin, supprimer l'app installée de l'écran d'accueil puis la réinstaller.

Ensuite, refaire un test :
- Téléphone A crée/modifie un pronostic.
- Téléphone B recharge : la modification doit apparaître.

## Endpoints exposés

- `GET /api/health`
- `GET /api/snapshot`
- `POST /api/snapshot`
- `GET /api/stream` (SSE temps réel)

## Variables utiles

- `COMMUNITY_PORT` : port du serveur (défaut `8787`).
- `COMMUNITY_DB_FILE` : chemin du snapshot partagé (défaut `data/community-sync.json`).
- `COMMUNITY_WEB_ROOT` : dossier des fichiers statiques (défaut racine du projet).

## Notes

- Snapshot partagé persistant dans `data/community-sync.json`.
- CORS ouvert (`*`) pour simplifier LAN/tests.

## Oui/non : qu'est-ce qui est partagé entre amis ?

**Oui, théoriquement et pratiquement ça fonctionne**, si les prérequis ci-dessus sont respectés (même URL front + même endpoint API + backend `ok`).

Quand c'est bien configuré :

- ✅ Tu crées ton profil → ton ami te voit dans le **classement**.
- ✅ Ton ami peut ouvrir ta **grille** (lecture) depuis l'onglet classement.
- ✅ Vous échangez tous les deux dans le **Bistro / 3e mi-temps** (messages communs).

Ce qui ferait croire que "ça ne marche pas" :

- ❌ Un téléphone utilise une autre URL front.
- ❌ Un téléphone pointe vers un autre endpoint API.
- ❌ Le backend n'est pas accessible (`/api/health` KO).
- ❌ Une vieille PWA garde un ancien cache (forcer reload / réinstaller).
