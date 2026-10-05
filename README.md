# Vestiaire — hub de news sportives

Appli web (installable sur l'écran d'accueil du téléphone) qui regroupe les news de mes équipes.
Tout tourne gratuitement sur GitHub : aucune IA, aucun compte payant.

- **Toutes les 30 minutes** (de 6h à minuit environ), GitHub lance `scripts/update.mjs` :
  il lit les flux RSS des sites listés dans `sources.json`, range chaque article sous la bonne équipe,
  récupère les résultats, calendriers et classements (MLB, ESPN, Sofascore) et publie le tout dans `data.json`.
- L'appli (`site/index.html`) affiche ces données : Inbox, À lire, Agenda, Équipes, Sources.
  Chaque article ouvre le site d'origine.

## Modifier les équipes ou les sites
Ouvre `sources.json` sur GitHub, clique sur le crayon, modifie, puis **Commit changes**.
La mise à jour se relance aussitôt.

- `teams` : une équipe = `key` (court, sans espace), `name`, `sport`, `keywords` (mots qui permettent de reconnaître l'équipe dans un titre).
- `sources` : `scope` = la clé d'une équipe, ou `sport:Basket` pour un site généraliste.
  - `keep: "mine"` = ne garder que les articles sur mes équipes ; `keep: "all"` = tout garder.
  - `filter: true` = sur un site qui parle de plein d'équipes, ne garder que ceux qui citent l'équipe.
  - `feeds` = adresse(s) du flux RSS. Si elle ne marche pas, le programme cherche le flux sur la page `site`.
  - `"on": false` = mettre une source en pause.

## Logos
Dépose des images PNG dans `site/logos/`, nommées avec la clé de l'équipe (`nan.png`, `phi.png`, `om.png`…).

## Lancer une mise à jour à la main
Onglet **Actions** › **Mettre à jour le hub** › **Run workflow**.
Le journal de chaque passage indique les sources en erreur.
