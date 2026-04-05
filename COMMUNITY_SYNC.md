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
