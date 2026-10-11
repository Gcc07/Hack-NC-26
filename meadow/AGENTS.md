# meadow — agent instructions

This is a [Spectrum](https://photon.codes/docs/spectrum-ts) app, pinned to `spectrum-ts@^12.10.1`. The entry point is `src/index.ts`: Spectrum iMessage loop + HTTP bridge for the browser.

## Working in this project

- Run Flask (`python app.py`) and the bridge (`cd meadow && npm run start`).
- Local tests (no texts): `npm run check`.
- Dewey SMS: keywords → Gemini NLU (`/api/ai/sms-intent`) → freeform chat (`/api/ai/chat`); copy via `/api/ai/sms-copy`.
- Structured demos still work: `REMINDER`, `TIME`, `FOOD`. Frontend hits the bridge (`/reminders`, `/surveys`, …).
- Persist bridge-only state in `data/` (gitignored). Sync plans / time / food into Flask when `BACKEND_URL` is set.
- Gemini key: repo-root `GEMINI_API_KEY` only. Never put keys in frontend code.

## Environment

Reads `meadow/.env` (gitignored). **Do not read, write, or echo `.env`.**

- Photon: `PROJECT_ID`, `PROJECT_SECRET`
- Flask: `BACKEND_URL` (e.g. `http://127.0.0.1:5000`)
- Bridge: `BRIDGE_PORT` (default `5055`), `BRIDGE_MODE`=`dry`|`live`

If Spectrum auth fails, verify credentials at the [Photon dashboard](https://app.photon.codes).

## Spectrum SDK reference

This project includes the `spectrum` skill from [`photon-hq/skills`](https://github.com/photon-hq/skills). Your agent should auto-discover it. If it doesn't, or if you switch agents, install for your agent with:

```sh
npx skills add photon-hq/skills --skill spectrum --agent <your-agent>
```

(Use `--agent '*'` to install for all supported agents.)

## Managing the Spectrum Cloud project (CLI)

If this app uses a platform provider, the `PROJECT_ID` / `PROJECT_SECRET` in `.env` belong to a **Spectrum Cloud** project. To manage that project from the terminal — authenticate, rotate the secret, list the line(s) you send from, manage platforms/users, or create more projects — use the `photon-cli` skill (the `photon` CLI) from [`photon-hq/skills`](https://github.com/photon-hq/skills):

```sh
npx skills add photon-hq/skills --skill photon-cli --agent <your-agent>
```

(Use `--agent '*'` to install for all supported agents.)

Common tasks once it's installed:

- `photon whoami` — confirm you're authenticated (run `photon login` if not).
- `photon projects regenerate-secret` — rotate the Spectrum API secret (then update `PROJECT_SECRET` in `.env`).
- `photon spectrum lines list` — see the line(s) your app sends from.
- `photon projects show` — inspect the active project (set `PHOTON_PROJECT_ID`, or pass `--project <id>`).

## See also

- [Spectrum docs](https://photon.codes/docs/spectrum-ts)
- [`spectrum-ts` on GitHub](https://github.com/photon-hq/spectrum-ts)
