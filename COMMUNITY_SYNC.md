# Mode communauté (multi-appareils)

Cette app est locale par défaut (stockage navigateur).  
Pour partager les pronostics/notifs entre tous les utilisateurs et tous les appareils :

1. Lance le serveur communautaire :

```bash
node community-server.js
```

2. Configure l’URL API côté front (`index.html`) :

```html
<meta name="fwc26-community-api" content="http://IP_DU_SERVEUR:8787" />
```

3. Recharge l’application sur chaque appareil.

## Endpoints exposés

- `GET /api/health`
- `GET /api/snapshot`
- `POST /api/snapshot`
- `GET /api/stream` (SSE temps réel)

## Notes

- Le snapshot partagé est persisté dans `data/community-sync.json` (configurable via `COMMUNITY_DB_FILE`).
- CORS est ouvert (`*`) pour simplifier un réseau interne/LAN.
