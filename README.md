# BusyKiosk

[![CI](https://github.com/aboidard/busykiosk/actions/workflows/ci.yml/badge.svg)](https://github.com/aboidard/busykiosk/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Tableau de bord Home Assistant pour la [BUSY Bar](https://busy.app), **en mode « pull »** : c'est
l'app JavaScript qui tourne sur la barre qui va chercher les données dans Home Assistant (HA), et
plus HA qui pousse des `draw` vers la barre.

```
 BUSY Bar (app JS)                                   Home Assistant (custom component)
 ─────────────────                                   ─────────────────────────────────
 page 1  ── GET  /api/busykiosk/weather  ─────────▶  weather.* + weather.get_forecasts
 page 2  ── GET  /api/busykiosk/heating  ─────────▶  climate.* + sondes salon / chambre
         ── POST /api/busykiosk/heating  ─────────▶  climate.set_hvac_mode / set_temperature
 page 3  ── GET  /api/busykiosk/waste    ─────────▶  calendar.get_events (collectes)
```

## Sommaire

- [Ce qui s'affiche](#ce-qui-saffiche)
- [Commandes](#commandes)
- [Installation](#installation)
- [Intégration Home Assistant](#intégration-home-assistant)
- [App BUSY Bar](#app-busy-bar)
- [Structure du dépôt](#structure-du-dépôt)
- [Contribuer](#contribuer)

## Ce qui s'affiche

Les pages défilent toutes les 60 s (réglable), en repartant de la page 1.

1. **Météo + heure** : petite animation pixel art du temps (soleil, lune, nuages, pluie, orage,
   neige, brouillard, vent), max (orange) / min (bleu) du jour, et `31 Oct, 14:32`.
2. **Chauffage** : consigne du thermostat en grand, flamme (animée quand la chaudière chauffe,
   sombre en veille, grise quand c'est éteint) avec `ON`/`OFF`, et en petit la température du
   salon (canapé) et de la chambre (lit, la clim).
3. **Poubelles** : les 5 icônes pixel art (ordures ménagères, emballages, verre, déchets verts,
   encombrants), triées de la plus proche à la plus lointaine, avec sous chacune le texte renvoyé
   par HA (nombre de jours). Aujourd'hui = rouge, demain = orange, et l'icône sautille.

Un point rouge en haut à droite signale que HA ne répond plus (les dernières données restent
affichées) ; un point orange, qu'un réglage est en cours d'envoi.

## Commandes

| Action | Effet |
|---|---|
| Tourner la molette | page précédente / suivante (relance le minuteur de 60 s) |
| Clic molette (page 2) | met la consigne en surbrillance : mode réglage |
| — molette | consigne ± pas du thermostat (0,5 °C en général) |
| — START | bascule `ON` / `OFF` |
| — clic molette | **envoie** le POST à HA (`Set 21.0` / `Heating off` s'affiche, LED verte) |
| — BACK | annule (annulé aussi tout seul après 20 s sans action) |
| Clic molette (pages 1 et 3) | rafraîchit tout de suite |
| BACK | quitte l'app |

L'écran arrière rappelle la page, l'état de la connexion à HA et les commandes.

## Installation

1. **Home Assistant** : copier `custom_components/busykiosk` dans le dossier
   `config/custom_components/` de HA (Samba, File editor, Studio Code Server ou `scp`), ajouter la
   section `busykiosk:` dans `configuration.yaml` (voir
   [`configuration.example.yaml`](configuration.example.yaml)) puis redémarrer HA
   (*Paramètres → Système → Redémarrer*). Le journal affiche
   `BusyKiosk endpoints ready under /api/busykiosk`.
2. **Jeton** : dans HA, *Profil → Sécurité → Jetons d'accès longue durée → Créer un jeton*.
3. **BUSY Bar** : télécharger `app.arnaud.busykiosk-<version>.tgz` depuis les
   [Releases](../../releases) (ou le construire, voir [App BUSY Bar](#app-busy-bar)), l'installer
   (interface web de la barre → *Apps → Add app*), puis dans les réglages de l'app renseigner :
   - **Home Assistant URL** : `http://192.168.x.y:8123` (une IP est plus sûre qu'un nom `.local`) ;
   - **Long-lived access token** : le jeton de l'étape 2 ;
   - **Seconds per page** : 60 par défaut.

Vérifier côté HA : `curl -H "Authorization: Bearer $TOKEN" http://<ha>:8123/api/busykiosk` renvoie
la configuration lue.

## Intégration Home Assistant

L'intégration `busykiosk` (dans [`custom_components/busykiosk/`](custom_components/busykiosk/))
expose des endpoints JSON, un par type de données. Ils passent par l'authentification normale de
Home Assistant : `Authorization: Bearer <jeton d'accès longue durée>`. Sans jeton : `401`.

### `GET /api/busykiosk/weather`

```json
{"condition": "partlycloudy", "icon": "partly", "temp": 11.2, "temp_min": 7.6, "temp_max": 14.4, "utc_offset": 3600}
```

- `icon` : nom de l'animation sur la barre (`sun`, `night`, `partly`, `partly_night`, `cloudy`, `rain`,
  `pouring`, `storm`, `snow`, `fog`, `wind`). La nuit (`sun.sun` sous l'horizon), `sunny` devient
  `night` et `partlycloudy` devient `partly_night`.
- `temp_min` / `temp_max` : prévision du jour via `weather.get_forecasts` (daily, sinon twice_daily,
  sinon hourly).
- `utc_offset` : décalage horaire de HA, utilisé par la barre seulement si elle ne connaît pas le sien.

### `GET /api/busykiosk/heating`

```json
{"setpoint": 20.5, "on": true, "heating": true, "mode": "heat", "min": 7, "max": 30, "step": 0.5, "living": 19.8, "bedroom": 22.1}
```

- `on` : le mode du thermostat n'est pas `off` ; `heating` : `hvac_action == "heating"`.
- `living` : `living_temperature` (sinon la température mesurée par le thermostat) ;
  `bedroom` : `bedroom_temperature`. Un `sensor.*` donne son état, un `climate.*` (la clim) son
  `current_temperature`.
- Si le thermostat n'expose pas de consigne quand il est éteint, la dernière consigne vue (ou
  `default_setpoint`) est renvoyée pour que la barre puisse quand même la régler.

### `POST /api/busykiosk/heating`

Corps : `{"setpoint": 21.0, "on": true}` (les deux champs sont facultatifs).

- `on: false` → `climate.set_hvac_mode` `off` (la consigne est mémorisée pour le prochain allumage).
- `on: true` alors que le thermostat est éteint → `climate.set_hvac_mode` `heat_mode` (par défaut
  `heat`, sinon le premier mode disponible autre que `off`), puis `climate.set_temperature`.
- La consigne est arrondie au pas du thermostat et bornée entre `min_temp` et `max_temp`.
- Réponse : le même document que le `GET`, avec les valeurs demandées (certains thermostats mettent
  à jour leur état un peu plus tard). Erreur du thermostat → `502` `{"error": "..."}`.

### `GET /api/busykiosk/waste`

```json
{"items": [{"type": "verre", "days": 0, "text": "0"}, {"type": "emballages", "days": 1, "text": "1"},
           {"type": "menagers", "days": 3, "text": "3"}, {"type": "verts", "days": 12, "text": "12"},
           {"type": "encombrants", "days": null, "text": "-"}]}
```

Pour chaque type, la prochaine collecte du calendrier sur `waste_days` jours (30 par défaut) dont le
titre contient `match` (casse et accents ignorés), triée de la plus proche à la plus lointaine.
`text` est ce que la barre affiche sous l'icône : modifiez `next_collections()` dans
[`logic.py`](custom_components/busykiosk/logic.py) pour afficher autre chose.

### Tester les endpoints sans la barre

```bash
curl -H "Authorization: Bearer $TOKEN" http://192.168.x.y:8123/api/busykiosk/weather
```

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"setpoint": 20.5, "on": true}' http://192.168.x.y:8123/api/busykiosk/heating
```

### En-tête `Server` (important pour la barre)

Home Assistant ajoute `Server: ` **vide** à toutes ses réponses. Le client HTTP de la BUSY Bar
(firmware 27.14.0) ne sait pas le lire : la connexion s'établit, HA répond `200`, mais l'app affiche
`HA offline: inactivity timeout`. Les réponses de `/api/busykiosk/*` portent donc `Server: busykiosk`,
posé de façon à ne pas être réécrasé par le traitement de HA (`_with_server_header` dans
[`__init__.py`](custom_components/busykiosk/__init__.py)).

- Ajouter un traitement de réponse sur `hass.http.app` ne marche pas : HA démarre et fige son
  serveur avant le chargement des intégrations personnalisées.
- Les erreurs produites par HA lui-même (par exemple un `401` à cause d'un mauvais jeton) gardent le
  `Server` vide : la barre peut alors afficher un timeout au lieu de « Bad token ».
- En cas de doute, vérifier l'en-tête `Server` d'une réponse (Bruno, ou `curl -i`) : il doit valoir `busykiosk`.

## App BUSY Bar

App JavaScript (`app.arnaud.busykiosk`) qui interroge l'intégration et affiche les 3 pages sur
l'écran avant 72×16. Elle tourne dans le runtime JerryScript du firmware (ni Node.js, ni navigateur) ;
conventions détaillées dans [`AGENTS.md`](AGENTS.md).

### Développement

Node 24 recommandé (`.nvmrc`) ; Node 22 fonctionne aussi pour ce projet.

```bash
npm install          # applique aussi le correctif Windows de busy-cli
npm run assets       # après avoir modifié sprites.ts ou gen-assets.mjs
npm run check        # aperçu ASCII des pages + vérification des bornes
npm run typecheck
npm run build        # → dist/app.arnaud.busykiosk.tgz
```

Sous Windows, lancez `npm run build` depuis **PowerShell** ou cmd : depuis Git Bash, le `tar` GNU
prend `C:` pour un hôte distant et l'empaquetage du `.tgz` échoue.

Pour revoir les sprites : ouvrir `tools/preview.html` dans un navigateur (agrandi ×12, rendu LED).

### Installation sur la barre depuis les sources

- **Interface web** : `http://<barre>.local` (ou `http://10.0.4.20` en USB) → *Apps* → *Add app* →
  choisir `dist/app.arnaud.busykiosk.tgz`.
- **En ligne de commande** (USB) : `npm run app:install` puis `npm run app:run` ;
  en Wi-Fi : `npm run app:install -- --addr <ip> --password <mot de passe HTTP>`.

### Notes techniques

- Les animations sont des fichiers `.anim` joués par le firmware à 6–10 i/s : aucune requête de
  l'app pour les faire tourner. Seul le texte de l'heure est renvoyé, une fois par minute.
- Diff-drawing : seuls les éléments modifiés sont renvoyés ; un changement de page renvoie tout
  (ce qui restaure l'écran si une notification l'a effacé).
- Rafraîchissement de la page visible : chauffage toutes les 30 s, météo toutes les 10 min,
  poubelles toutes les 30 min ; recul exponentiel (30 s → 5 min) si HA ne répond pas, 10 min si le
  jeton est refusé.
- L'heure locale vient du fuseau de la barre (`GET /api/time`), à défaut de celui de HA.
- `heap_size_kib: 256` : le script fait ~46 Ko.

## Structure du dépôt

| Chemin | Rôle |
|---|---|
| `custom_components/busykiosk/` | intégration Home Assistant (endpoints, logique pure dans `logic.py`) |
| `configuration.example.yaml` | exemple de section `busykiosk:` pour `configuration.yaml` |
| `tests/` | tests pytest de l'intégration |
| `src/main.ts` | app : cycle de vie, rotation des pages, minuteries, molette/boutons, envoi du thermostat, diff-drawing |
| `src/ha.ts` | app : client HTTP des endpoints `/api/busykiosk/*` (jeton, erreurs typées par `kind`) |
| `src/views.ts` | app : construction des 3 pages (fonctions pures : données → éléments `DisplayDraw`) |
| `src/sprites.ts` | sprites pixel art (poubelles, flamme, canapé, lit) en grilles de caractères |
| `src/animations/*.anim` | animations jouées par le firmware — **générées** |
| `src/appmeta/` | manifest, réglages (`settings.json`), icônes du menu APPS — icônes **générées** |
| `shared/`, `types/` | helpers et déclarations de types de l'app |
| `tools/gen-assets.mjs` | génère les `.anim`, les icônes et `tools/preview.html` |
| `tools/check-layout.mjs` | rend chaque page en ASCII et vérifie que tout tient dans 72×16 |
| `tools/patch-busy-cli.mjs` | corrige un bug Windows de `@busy-app/cli` 0.6 (lancé par `postinstall`) |
| `.github/workflows/` | CI (typecheck, build, tests Python) et release (archive `.tgz` jointe au tag) |

## Contribuer

Tests de l'intégration :

```bash
pip install pytest-homeassistant-custom-component
pytest
```

`tests/test_logic.py` (fonctions pures) tourne aussi sans Home Assistant : `python tests/test_logic.py`.

Publier une version : aligner `version` dans `src/appmeta/manifest.json`, puis pousser le tag
correspondant (`git tag 0.1.0 && git push --tags`) : le workflow *Release* joint l'archive `.tgz`.

## Licence

[MIT](LICENSE)
