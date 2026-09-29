# Wiggle Wars

A turn-based multiplayer artillery game in the spirit of the classic *Worms* series.
Plain HTML + CSS + JavaScript (ES modules), HTML5 Canvas, no build step, no backend.
Multiplayer is peer-to-peer over WebRTC via [PeerJS](https://peerjs.com/) and its free public broker,
so the whole thing runs from static hosting such as GitHub Pages.

Works on desktop browsers and on iPhone/iPad (iOS Safari), in landscape.

## Features

- 2–4 players, one team each, 1–6 worms per team, 30/45/60 s turns, configurable starting HP.
- Procedurally generated maps (hills, water pits, pillars, floating islands, caves/overhangs) in four color themes.
- Destructible bitmap terrain: explosions carve craters, only the changed region is redrawn.
- Water and map edges are instant death; fall damage; explosion knockback.
- Weapons: Fist, Minigun (10-round burst), Shotgun (2 shots, walk in between, strong falloff), Grenade (3 per team, 3 s fuse, bounces), Bazooka (2 per team, wind-affected), Teleport (1 per team).
- Supply drops: every 2 turns a plane drops a parachute crate with health, rockets, grenades or a teleport.
- Double jump = high backflip, handy for climbing out of pits.
- Host-authoritative networking: the host simulates everything, clients send inputs and render 20 Hz snapshots with interpolation.
- Keyboard, mouse and touch share one input layer (Pointer Events, multi-touch).
- Synthesized retro sound effects (Web Audio, no audio files).
- Home Screen install (web app manifest + Apple meta tags) for full-screen play on iPhone.

## File structure

```
index.html              page, screens, HUD and touch-control markup
style.css               all styling (safe areas, touch controls, overlays)
manifest.webmanifest    PWA manifest (fullscreen, landscape)
icons/                  app icons
js/config.js            constants (world size, physics, turn timing, networking)
js/terrain.js           bitmap terrain, procedural generation, crater carving, RLE encoding
js/physics.js           bitmap collision, walking/climbing, falling, bouncing
js/weapons.js           weapon definitions, firing, projectiles, trajectory preview
js/game.js              host-side simulation: turns, damage, victory, snapshots
js/sync.js              client-side snapshot buffer and interpolation
js/net.js               PeerJS host/client wrappers (+ local BroadcastChannel test transport)
js/render.js            canvas renderer: camera, terrain, worms, effects, aim UI
js/input.js             keyboard / mouse / touch -> game actions
js/ui.js                DOM screens, lobby, HUD, weapon picker, toasts
js/audio.js             Web Audio sound effects
js/main.js              app flow and glue
```

## Deploy on GitHub Pages

1. Create a new GitHub repository (e.g. `wiggle-wars`) and push these files to the `main` branch
   (the files must be at the repository root, next to `index.html`).
2. In the repository go to **Settings → Pages**.
3. Under **Build and deployment** choose **Source: Deploy from a branch**, branch `main`, folder `/ (root)`, and save.
4. After a minute the game is live at `https://<your-user>.github.io/wiggle-wars/`.

No build step is needed. GitHub Pages serves over HTTPS, which WebRTC and the Web Audio unlock both require on phones.

## How to play

### Starting a game
1. One player opens the page and presses **Create game**, picks the settings and presses **Create room**.
2. The lobby shows a 6-character **room code** and a **Share link** button (uses the iOS/Android share sheet or copies the link).
3. Other players press **Join game** and enter the code and their name — or simply open the shared link
   (`…/?room=ABC123`), which prefills the code.
4. When at least 2 players are in the lobby the host presses **Start**. Up to 4 players.

### On your turn
1. Pick which worm to use: click/tap one of your worms (or press **Tab**) before you move or fire.
2. Walk, jump, climb and position yourself. Falls from a big height hurt.
3. Pick a weapon, aim and fire. After firing you get a **3-second retreat** to run for cover.
4. If the timer runs out, the turn passes. The next turn starts only once everything has settled.
5. The last team with living worms wins. The host can start another round from the victory screen.

### Weapons
| Key | Weapon | Notes |
|---|---|---|
| 1 | Fist | Melee, moderate damage, huge knockback — punch worms into the water |
| 2 | Minigun | 10-bullet burst, slight spread, small damage per bullet |
| 3 | Shotgun | Two shots per turn, big damage up close, weak at range |
| 4 | Grenade | Arc throw with power, bounces, 3 s fuse; 3 per team |
| 5 | Bazooka | Arc shot with power, explodes on impact, pushed by the wind; 2 per team |
| 6 | Teleport | Select it, then tap/click the destination (snaps to ground below); 1 per team; ends the turn with a retreat |

The shotgun fires twice per turn and you can walk between the two shots.

### Supply crates
Every second turn a plane flies over and drops a crate on a parachute. Walk into it (or get knocked into it) to collect:
health (+35 HP for that worm), +1 rocket, +2 grenades or +1 teleport. Explosions destroy crates.

### Stuck in a pit?
Press jump twice quickly for a **backflip** (about twice as high as a normal jump), or use the **Teleport**.

### Desktop controls
- **←/→ or A/D** walk · **W or Enter** jump (press twice quickly for a backflip) · **↑/↓** aim
- **Space**: hold to charge power, release to fire (fires instantly for weapons without power)
- **1–6** weapon · **Tab** next worm · with Teleport selected, click the destination · **C** re-center camera · **+/-** or mouse wheel zoom
- Mouse drag or pushing the cursor to a screen edge pans the camera.
- You can also drag back from your worm with the mouse, like on touch.

### Touch controls (iPhone / iPad)
- Play in landscape (a “Rotate your device” overlay appears in portrait).
- **Slingshot aiming**: touch near your worm and drag *backwards*. Direction = angle, length = power,
  a dotted line previews the flight (without wind). Let go to fire.
- Bottom-left: **◀ ▶** walk (hold), **JUMP** (double-tap = backflip).
- Bottom-right: **▲ ▼** aim (hold), weapon picker and **FIRE** (fires with the current aim and last power; for the Fist just tap it).
- Teleport: pick it in the weapon picker, then tap the destination on the map.
- One-finger drag on the map pans, pinch zooms, **◎** snaps back to your worm.
- Tip: in Safari use **Share → Add to Home Screen** to play full-screen without browser bars.

## Testing locally

ES modules need an HTTP server (opening `index.html` from disk won't work):

```bash
cd wiggle-wars
python3 -m http.server 8000
# or: npx serve .
```

**With PeerJS (real WebRTC, needs internet for the broker):** open `http://localhost:8000/` in two browser
windows, create a game in one, join with the code in the other.

**Offline mode:** add `?net=local` — `http://localhost:8000/?net=local` — to use a BroadcastChannel transport
instead of WebRTC. Both windows must be in the same browser profile. Everything else (host simulation,
snapshots, interpolation, crater events) runs exactly as in online play.

Tip: put the two windows side by side. The host keeps simulating in a background tab (a worker-driven ticker
avoids timer throttling), but it's easier to follow both views at once.

To test on a phone against your computer, the page must be served over HTTPS (e.g. push to GitHub Pages)
— mobile browsers block WebRTC and some features on plain `http://` from a LAN IP.

## Networking notes

- The host's PeerJS ID is `wiggle-wars-v1-<ROOMCODE>` on the public PeerJS cloud broker (`0.peerjs.com`).
  The broker is only used for matchmaking; game data flows directly between browsers.
- See **Connection problems** below if devices find the room but can't connect.
- The host broadcasts compact snapshots ~20×/s; terrain is sent once at game start (run-length encoded, chunked)
  and afterwards only as crater events `(x, y, r)`.
- Only the active player's inputs are accepted by the host.
- If a client disconnects, their worms stay on the map and their turns are skipped.
  If the host disconnects, everybody sees “Host left the game”.
- Keep the host's screen on: when an iPhone host locks its screen or switches apps, iOS pauses the page and the game
  stalls for everyone (the game requests a screen wake lock where supported).

## Connection problems

The joining screen shows which step is slow:

| Message | Meaning |
|---|---|
| *Cannot reach the PeerJS matchmaking server* | No internet, or `0.peerjs.com` is blocked/down. |
| *Room not found* | Wrong code, or the host closed the page / its tab was suspended. |
| *The room was found, but a direct connection … could not be opened* | The two networks block direct peer-to-peer traffic (NAT). This is the most common problem, e.g. phone on mobile data or a router without "hairpinning". |

For the last case the game needs a **TURN relay**. PeerJS's free built-in relay is often unreliable, so set up your own (free):

1. Create a free account at [Metered Open Relay](https://www.metered.ca/tools/openrelay/) and create an app.
2. Copy your *TURN credentials URL*: `https://<yourapp>.metered.live/api/v1/turn/credentials?apiKey=<key>`.
3. Paste it into `TURN_CREDENTIALS_URL` in `js/config.js`, commit and push. Everyone who opens the page then uses the relay automatically.

Alternatively list your own servers in `ICE_SERVERS` (e.g. a self-hosted coturn).

Quick check without a relay: connect both devices to the **same Wi-Fi** and try again.

## License

Do whatever you like with it. Worms is a trademark of Team17; this is an unaffiliated fan-style game.
