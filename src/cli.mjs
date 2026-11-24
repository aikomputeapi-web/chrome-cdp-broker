/**
 * chrome-cdp — one shared, self-healing Chrome CDP endpoint for every browser agent.
 *
 *   chrome-cdp ensure     idempotent: make the shared browser live, print its ws endpoint
 *   chrome-cdp status     what is live right now (json)
 *   chrome-cdp doctor     full diagnostic, mutates nothing
 *   chrome-cdp endpoint   print the ws endpoint (ensure first)
 *   chrome-cdp open URL   open a tab in the shared browser
 *   chrome-cdp eval EXPR  evaluate JS in the first page of the shared browser
 *   chrome-cdp restart    graceful stop + ensure
 *   chrome-cdp stop       graceful stop (Browser.close, then force)
 */
import { ensure, evaluate, doctorReport, inspect as inspectBroker, openUrl, restart, stop } from "../src/broker.mjs";
import { loadConfig } from "../src/config.mjs";

function usage() {
  console.log(
    [
      "chrome-cdp <command>",
      "",
      "  ensure            make the shared browser live (idempotent), print endpoint",
      "  status [--json]   report current state",
      "  doctor            full diagnostic report",
      "  endpoint          print the CDP ws endpoint",
      "  profile           print the shared profile dir (for connect({ profileDir }))",
      "  open <url>        open a tab in the shared browser",
      "  eval <expr>       evaluate JS in the first page",
      "  restart           graceful stop + ensure",
      "  stop              graceful stop",
      "",
      "env: CHROME_CDP_PORT (9333) · CHROME_CDP_PROFILE · CHROME_CDP_BINARY · CHROME_CDP_HEADLESS=1",
    ].join("\n"),
  );
}

async function status({ json }) {
  const cfg = loadConfig();
  const info = await inspectBroker(cfg);
  const payload = {
    live: info.live,
    port: cfg.port,
    http: cfg.httpEndpoint,
    ws: info.live ? info.probe.wsUrl : undefined,
    browser: info.probe.body?.Browser,
    profile: cfg.profile,
    pid: info.rootProcess?.ProcessId,
    ownedProcesses: info.owned.length,
    mismatch: info.mismatchedProfile,
    pages: undefined,
  };
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return info.live ? 0 : 1;
  }
  console.log(`live      : ${payload.live ? "yes" : "no"}`);
  console.log(`endpoint  : ${payload.live ? payload.ws : `${payload.http} (down)`}`);
  console.log(`browser   : ${payload.browser ?? "-"}`);
  console.log(`profile   : ${payload.profile}`);
  console.log(`pid       : ${payload.pid ?? "-"}`);
  console.log(`procs     : ${payload.ownedProcesses} holding profile`);
  return info.live ? 0 : 1;
}

const [command, ...rest] = process.argv.slice(2);

try {
  switch (command) {
    case "ensure": {
      const endpoint = await ensure();
      console.log(`ws=${endpoint.wsUrl}`);
      process.exit(0);
    }
    case "endpoint": {
      const endpoint = await ensure(process.env, { quiet: true });
      console.log(endpoint.wsUrl);
      process.exit(0);
    }
    case "profile": {
      console.log(loadConfig().profile);
      process.exit(0);
    }
    case "status": {
      process.exit(await status({ json: rest.includes("--json") }));
    }
    case "doctor": {
      const report = await doctorReport();
      process.exit(report.ok ? 0 : 1);
    }
    case "open": {
      if (!rest[0]) throw new Error("usage: chrome-cdp open <url>");
      const endpoint = await openUrl(rest[0]);
      console.log(`opened in ${endpoint.wsUrl}`);
      process.exit(0);
    }
    case "eval": {
      if (!rest[0]) throw new Error("usage: chrome-cdp eval <expression>");
      const result = await evaluate(rest.join(" "));
      console.log(JSON.stringify(result.value, null, 2));
      process.exit(0);
    }
    case "restart": {
      const endpoint = await restart();
      console.log(`ws=${endpoint.wsUrl}`);
      process.exit(0);
    }
    case "stop": {
      await stop();
      process.exit(0);
    }
    default: {
      usage();
      process.exit(command ? 1 : 0);
    }
  }
} catch (error) {
  console.error(`chrome-cdp: ${error?.message ?? error}`);
  process.exit(1);
}
