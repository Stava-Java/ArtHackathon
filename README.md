# Boxing Canvas

First-person cartoon boxing match. Every step, punch, dodge, and parry paints the canvas. Beat Jack the Dripper, then save the painting you made during the fight.

Built with React, Next (vinext), and Three.js.

## Run

Needs Node.js 22.13+.

```bash
cd game
npm install
npm run dev
```

Open the URL the terminal prints (usually `http://localhost:3000`), then click **Start**.

## Controls

| Input | Action |
| --- | --- |
| WASD / arrows | Move |
| Mouse | Aim |
| Q | Jab |
| Space / E | Hook |
| R | Stretch punch (hold to charge) |
| F | Parry |
| Shift | Dash / sprint |

## What's in here

Only the playable game: `game/app`, runtime assets under `game/public`, and the vinext/Cloudflare config needed to boot it.
