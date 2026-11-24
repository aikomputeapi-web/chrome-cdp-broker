/**
 * Broker test battery. Offline checks always run; live checks run against a real Chrome
 * (the broker launches one on a throwaway port/profile, so the daily browser is untouched).
 *
 *   node tests/run.mjs          offline + live
 *   node tests/run.mjs --offline
 */
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const offlineOnly = process.argv.includes("--offline");
const results = [];
let testProfileDir;
let testStateDir;

function check(name, fn) {
  return { name, fn };
}

async function run(test) {
  try {
    const detail = await test.fn();
    results.push({ name: test.name, ok: true, detail: detail ?? "" });
  } catch (error) {
    results.push({ name: test.name, ok: false, detail: error?.message ?? String(error) });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const config = await import("../src/config.mjs");
const cdp = await import("../src/cdp.mjs");
const proc = await import("../src/proc.mjs");
const broker = await import("../src/broker.mjs");

const tests = [
  check("config: defaults are sane", () => {
    const cfg = config.loadConfig({});
    assert(cfg.port === 9333, `unexpected default port ${cfg.port}`);
    assert(cfg.profile.endsWith(".chrome-dev-tools\\profile") || cfg.profile.endsWith(".chrome-dev-tools/profile"), cfg.profile);
    assert(cfg.httpEndpoint === "http://127.0.0.1:9333", cfg.httpEndpoint);
    assert(cfg.endpointFile.endsWith("endpoint.json"), cfg.endpointFile);
    return cfg.profile;
  }),

  check("config: env overrides win", () => {
    const cfg = config.loadConfig({ CHROME_CDP_PORT: "9999", CHROME_CDP_PROFILE: "C:\\tmp\\p", CHROME_CDP_HEADLESS: "1" });
    assert(cfg.port === 9999, "port override ignored");
    assert(cfg.profile === "C:\\tmp\\p", "profile override ignored");
    assert(cfg.headless === true, "headless override ignored");
    return `port ${cfg.port}`;
  }),

  check("config: binary resolves on this machine", () => {
    const binary = config.resolveBinary({});
    assert(binary, "no chrome binary found");
    return binary;
  }),

  check("flags: stealth baseline present, automation opt-in", () => {
    const cfg = config.loadConfig({});
    const args = config.chromeArgs(cfg);
    const joined = args.join(" ");
    for (const flag of [
      `--user-data-dir=${cfg.profile}`,
      `--remote-debugging-port=${cfg.port}`,
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--remote-allow-origins=*",
    ]) {
      assert(joined.includes(flag), `missing ${flag}`);
    }
    assert(!joined.includes("--enable-automation"), "--enable-automation should be off by default");
    assert(joined.includes("--headless=new") === false, "headless should be off by default");
    const auto = config.chromeArgs(config.loadConfig({ CHROME_CDP_ENABLE_AUTOMATION: "1", CHROME_CDP_HEADLESS: "1" }));
    assert(auto.join(" ").includes("--enable-automation"), "automation flag not opt-in-able");
    assert(auto.join(" ").includes("--headless=new"), "headless flag not opt-in-able");
    return `${args.length} args`;
  }),

  check("cdp: wsGuid extracts the browser guid", () => {
    assert(cdp.wsGuid("ws://127.0.0.1:9333/devtools/browser/abc-123") === "abc-123", "guid extraction wrong");
    assert(cdp.wsGuid(undefined) === "", "guid of undefined should be empty");
    return "abc-123";
  }),

  check("cdp: readState tolerates a missing file", async () => {
    const state = await cdp.readState(join(tmpdir(), "definitely-missing-chrome-cdp-state.json"));
    assert(state === undefined, "expected undefined");
    return "undefined";
  }),

  check("proc: process listing parses", async () => {
    const rows = await proc.listBrowserProcesses();
    assert(Array.isArray(rows), "not an array");
    assert(rows.every((row) => Number.isFinite(row.ProcessId)), "rows missing ProcessId");
    return `${rows.length} browser processes seen`;
  }),

  check("proc: ownedProcesses is scoped to the profile", async () => {
    const rows = await proc.ownedProcesses("C:\\definitely-not-a-real-profile-dir");
    assert(rows.length === 0, `expected 0, got ${rows.length}`);
    return "0 unrelated";
  }),
];

if (!offlineOnly) {
  const port = 9377 + Math.floor(Math.random() * 40);
  const profileDir = await mkdtemp(join(tmpdir(), "chrome-cdp-test-"));
  const stateDir = await mkdtemp(join(tmpdir(), "chrome-cdp-state-"));
  testProfileDir = profileDir;
  testStateDir = stateDir;
  const env = {
    ...process.env,
    CHROME_CDP_PORT: String(port),
    CHROME_CDP_PROFILE: profileDir,
    CHROME_CDP_STATE_DIR: stateDir,
    CHROME_CDP_START_URL: "about:blank",
  };

  tests.push(
    check("live: ensure launches a browser on the throwaway profile", async () => {
      const endpoint = await broker.ensure(env, { quiet: true });
      assert(endpoint.wsUrl.startsWith(`ws://127.0.0.1:${port}/devtools/browser/`), endpoint.wsUrl);
      assert(endpoint.reused === false, "first ensure should launch, not reuse");
      return endpoint.wsUrl;
    }),

    check("live: ensure is idempotent (same guid, reused)", async () => {
      const first = await broker.ensure(env, { quiet: true });
      const second = await broker.ensure(env, { quiet: true });
      assert(second.reused === true, "second ensure should reuse");
      assert(first.wsUrl === second.wsUrl, "guid changed between idempotent ensures");
      return `reused ${second.wsUrl.split("/").pop()}`;
    }),

    check("live: JS evaluates with webdriver=false", async () => {
      const result = await broker.evaluate("({ sum: 1 + 1, webdriver: navigator.webdriver, ua: navigator.userAgent })", env);
      assert(result.value?.sum === 2, `eval returned ${JSON.stringify(result.value)}`);
      assert(result.value?.webdriver === false, "navigator.webdriver must be false");
      return `webdriver=${result.value.webdriver}`;
    }),

    check("live: endpoint.json and DevToolsActivePort are published consistently", async () => {
      const published = await cdp.readState(join(stateDir, "endpoint.json"));
      assert(published?.ws, "endpoint.json not published");
      assert(cdp.wsGuid(published.ws) === cdp.wsGuid((await cdp.probeHttp(`http://127.0.0.1:${port}`, 1500)).wsUrl), "endpoint.json guid mismatch");
      const active = await cdp.readDevToolsActivePort(profileDir);
      assert(active?.port === port, `DevToolsActivePort port ${active?.port} != ${port}`);
      assert(active?.wsUrl?.startsWith("ws://"), "DevToolsActivePort ws path malformed");
      const live = await cdp.probeHttp(`http://127.0.0.1:${port}`, 1500);
      assert(live.ok, "live probe failed");
      assert(cdp.wsGuid(live.wsUrl) === cdp.wsGuid(active.wsUrl), "published guid does not match live browser");
      return published ? "endpoint.json + DevToolsActivePort agree with live browser" : "DevToolsActivePort agrees with live browser";
    }),

    check("live: openUrl adds a page target", async () => {
      await broker.openUrl("about:blank#broker-test", env);
      const client = await cdp.CdpClient.connect((await cdp.probeHttp(`http://127.0.0.1:${port}`)).wsUrl, { timeoutMs: 5000 });
      const pages = await cdp.listPages(client);
      client.close();
      assert(pages.length >= 2, `expected >=2 pages, got ${pages.length}`);
      return `${pages.length} pages`;
    }),

    check("live: recover from a hard-killed browser (stale lock self-heal)", async () => {
      await broker.stop(env, { quiet: true });
      const first = await broker.ensure(env, { quiet: true });
      const owned = await proc.ownedProcesses(profileDir);
      const root = proc.findRootProcess(owned);
      // SIGKILL the root so Chrome leaves lockfile/DevToolsActivePort behind.
      process.kill(root.ProcessId, "SIGKILL");
      await proc.sleep(700);
      const second = await broker.ensure(env, { quiet: true });
      assert(second.wsUrl !== first.wsUrl, "expected a freshly launched browser");
      const probe = await cdp.probeHttp(`http://127.0.0.1:${port}`, 2000);
      assert(probe.ok, "browser not healthy after self-heal");
      return "relaunched and healthy";
    }),

    check("live: doctor passes on a healthy broker", async () => {
      const report = await broker.doctor(env);
      const failures = report.checks.filter((c) => c.status === "fail").map((c) => `${c.id}: ${c.detail}`);
      assert(failures.length === 0, failures.join(" | "));
      return `${report.checks.length} checks, 0 failures`;
    }),

    check("live: stop is clean and idempotent", async () => {
      const first = await broker.stop(env, { quiet: true });
      assert(first.stopped === true, "first stop should stop");
      const second = await broker.stop(env, { quiet: true });
      assert(second.stopped === false, "second stop should report not running");
      const probe = await cdp.probeHttp(`http://127.0.0.1:${port}`, 1000);
      assert(!probe.ok, "port still answering after stop");
      return "stopped cleanly";
    }),
  );
}

for (const test of tests) await run(test);

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);

if (!offlineOnly) {
  const profileDir = results.length ? undefined : undefined;
  await rm(join(tmpdir(), "chrome-cdp-test-"), { recursive: true, force: true }).catch(() => undefined);
}

console.log(`\n${results.length - failed.length}/${results.length} passed${offlineOnly ? " (offline)" : ""}`);
if (failed.length) {
  const leftover = await readFile.join?.length ? "" : "";
  process.exit(1);
}
process.exit(0);
