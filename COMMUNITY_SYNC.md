# Mode communauté (Cloudflare Tunnel + Node)

Par défaut, l'app utilise le stockage local du téléphone.  
Pour partager les données entre mobiles, il faut **un seul backend Node** accessible par tous.

## Configuration retenue (sans Render)

Tu n'utilises plus Render : la stack est désormais **Node + Cloudflare Tunnel**.

1. Démarrer le backend :

```bash
COMMUNITY_PORT=8787 node community-server.js
```

2. Exposer le backend :

```bash
cloudflared tunnel --url http://localhost:8787
```

3. Récupérer l'URL publique retournée par Cloudflare (ex: `https://abcde.trycloudflare.com`).

4. Ouvrir l'application avec **cette même URL** sur tous les mobiles :

```text
https://abcde.trycloudflare.com/
```

> Important : tous les appareils doivent utiliser exactement la même URL front.

## runtime-config.js

Le fichier est maintenant neutre pour le mode tunnel :

```js
window.__FWC26_CANONICAL_ORIGIN__ = "";
window.__FWC26_COMMUNITY_API__ = "";
window.__FWC26_DISABLE_CANONICAL_REDIRECT__ = "true";
```

- `CANONICAL_ORIGIN` vide => pas de redirection forcée.
- `COMMUNITY_API` vide => l'app utilise automatiquement l'origin courante.
- Redirection canonique désactivée => évite les boucles quand l'URL tunnel change.

## Vérification rapide

Depuis un navigateur mobile :

- `https://abcde.trycloudflare.com/api/health` → doit renvoyer `{"ok":true,...}`
- `https://abcde.trycloudflare.com/api/snapshot` → doit renvoyer un snapshot JSON

Test fonctionnel :
1. Mobile A modifie un pronostic.
2. Mobile B recharge.
3. La même donnée doit apparaître.

## Si ça ne synchronise toujours pas

1. Vérifier que le tunnel Cloudflare est actif (pas fermé).
2. Vérifier que `community-server.js` tourne toujours sur le port 8787.
3. Supprimer/réinstaller la PWA sur mobile (cache service worker ancien).
4. Recharger en ouvrant l'URL tunnel dans le navigateur (pas via un vieux favori).
