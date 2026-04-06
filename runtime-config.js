// Configuration de production actuelle.
// URL publique de l'application (GitHub Pages) :
// https://pierrechalvi-alt.github.io/pronoFIFA2026/
//
// IMPORTANT :
// L'infra communautaire est maintenant pilotée côté Cloudflare + Node.
// Le front lit uniquement `__FWC26_COMMUNITY_API__` pour cibler le backend /api/*.
// Cette URL doit donc être maintenue ici (source de vérité unique côté client).

window.__FWC26_CANONICAL_ORIGIN__ = "https://pierrechalvi-alt.github.io";
window.__FWC26_COMMUNITY_API__ = "https://pronofifa2026-community.onrender.com";
// Optionnel (tests locaux / tunnel) : "true" pour désactiver la redirection canonique.
// window.__FWC26_DISABLE_CANONICAL_REDIRECT__ = "true";
