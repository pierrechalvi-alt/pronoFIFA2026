// Configuration runtime (Cloudflare Tunnel + Node).
//
// Mode recommandé pour ton usage actuel :
// - lancer `node community-server.js` en local/VPS
// - exposer ce serveur via une URL HTTPS Cloudflare Tunnel
// - ouvrir l'app via CETTE MÊME URL sur tous les téléphones
//
// Laisse vide pour utiliser automatiquement l'origin courante.
window.__FWC26_CANONICAL_ORIGIN__ = "";
window.__FWC26_COMMUNITY_API__ = "";

// En tunnel Cloudflare l'URL peut changer : on évite les redirections forcées.
window.__FWC26_DISABLE_CANONICAL_REDIRECT__ = "true";
