# chrome-cdp-broker

One shared, self-healing Chrome DevTools Protocol endpoint for every browser agent on this machine.

Owns exactly **one** warm Chrome with a dedicated automation profile and a fixed CDP port, so
nothing ever fights over the profile lock, and every client — pi's `chrome_*` tools,
`browser_execute`, nodriver/patchright scripts, raw CDP probes — attaches to the same browser with
the same logins.

```
~/.chrome-dev-tools/profile      Chrome user-data-dir (long-lived identity, do not delete)
http://127.0.0.1:9333            CDP endpoint (loopback only)
<stateDir>/endpoint.json         live ws endpoint + guid + pid
<stateDir>/broker-state.json     broker-owned launch state
<profile>/DevToolsActivePort     Chrome-format port file (see "why" below)
```

`<stateDir>` defaults to `<dirname(profile)>/.chrome-cdp`, overridable with `CHROME_CDP_STATE_DIR`.

## Why this exists

| Problem without a broker | What the broker does |
|---|---|
| Second agent/session launches a rival Chrome → `ProcessSingleton` / profile-lock failure | one owner; everyone else attaches over CDP |
| Crashed Chrome leaves `lockfile` + `DevToolsActivePort` → next launch dies | detects orphans, kills only its own profile processes, clears stale locks |
| Chrome 147+ stopped writing `DevToolsActivePort` for an explicit debug port → clients that resolve by profile dir break | broker writes that file itself, in Chrome's own format |
| Cold start + re-login every session | browser stays warm across sessions; clients detach instead of closing |
| No way to tell "is the browser healthy?" | `doctor` / `status`, plus a readiness probe before every launch |
| Port taken by a foreign browser | verifies ownership (recorded browser GUID, then `Browser.getBrowserCommandLine`) before reusing |

## Commands

```
chrome-cdp ensure            # idempotent: make it live, print the ws endpoint
chrome-cdp status [--json]   # what is live right now
chrome-cdp doctor            # full diagnostic report (never mutates)
chrome-cdp endpoint          # ws endpoint (ensures first)
chrome-cdp profile           # shared profile dir, for connect({ profileDir })
chrome-cdp open <url>        # open a tab in the shared browser
chrome-cdp eval <expr>       # evaluate JS in the first page
chrome-cdp restart           # graceful stop + ensure
chrome-cdp stop              # graceful Browser.close, then force
```

Exit codes: `0` ok / live, `1` failure (or "not live" for `status`/`doctor`).

`ensure` is the only command agents normally need: it is safe to call unconditionally and returns
in ~0.3 s when the browser is already up.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `CHROME_CDP_PORT` | `9333` | CDP port |
| `CHROME_CDP_PROFILE` | `~/.chrome-dev-tools/profile` | Chrome user-data-dir |
| `CHROME_CDP_BINARY` | auto-detect (system Chrome first) | chrome.exe path |
| `CHROME_CDP_STATE_DIR` | `<dirname(profile)>/.chrome-cdp` | sidecar state dir |
| `CHROME_CDP_START_URL` | `about:blank` | initial page |
| `CHROME_CDP_WINDOW_SIZE` | `1440,900` | window size |
| `CHROME_CDP_HEADLESS` | `0` | `1` = `--headless=new` |
| `CHROME_CDP_NO_SANDBOX` | `0` | `1` = add `--no-sandbox` |
| `CHROME_CDP_ENABLE_AUTOMATION` | `0` | `1` = add `--enable-automation` (enables `Browser.getBrowserCommandLine`, sets `navigator.webdriver=true`) |
| `CHROME_CDP_READY_TIMEOUT` | `30000` | ms to wait for CDP readiness |

Anti-detect baseline flags are always applied: `--disable-blink-features=AutomationControlled`,
`--remote-allow-origins=*`, `--no-first-run`, `--no-default-browser-check`, `--password-store=basic`.
`navigator.webdriver` stays `false` unless `CHROME_CDP_ENABLE_AUTOMATION=1`.

## Use from code

```js
import { ensure, evaluate, stop } from "C:/Users/Administrator/coding/chrome-cdp-broker/src/index.mjs";

const { wsUrl } = await ensure();          // idempotent
await evaluate("document.title");
```

Playwright / raw CDP clients:

```js
// Playwright
const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
const context = browser.contexts()[0];

// Raw CDP
const ws = new WebSocket((await (await fetch("http://127.0.0.1:9333/json/version")).json()).webSocketDebuggerUrl);

// Clients that resolve from a profile dir (DevToolsActivePort is broker-written)
await session.connect({ profileDir: process.env.CHROME_CDP_PROFILE });
```

## Client integration

- **pi `chrome_*` tools** — `aikomputeapi-web/pi-chrome-dev-tools` fork attaches automatically,
  auto-starts the broker when down, and detaches (does not close) on session shutdown.
- **pi `browser_execute`** — `aikomputeapi-web/pi-browser-cdp-extension` fork probes this endpoint
  first, so `await session.connect()` needs no arguments.
- **nodriver / patchright scripts** — point them at port 9333, or keep their own browser for
  stealth-critical flows (the broker uses system Chrome).

## Tests

```bash
node tests/run.mjs             # 16 checks: config, flags, process scoping + full live cycle
node tests/run.mjs --offline   # 8 checks, no Chrome needed
```

The live battery uses a throwaway port and temp profile, so the daily browser and the shared
broker are untouched. It covers launch, idempotent reuse, `webdriver=false`, endpoint publishing,
recovery from a hard-killed browser, `doctor`, and clean stop.

## Notes

- Windows-first (PowerShell for process listing); POSIX paths are handled but less exercised.
- Only processes whose command line contains this exact `--user-data-dir` are ever killed.
- `stop` is graceful (`Browser.close` over CDP) so Chrome flushes the profile before any force-kill.
