/**
 * Broker core: make exactly one warm, debug-port Chrome exist for this profile,
 * and never fight a rival instance over the profile lock.
 */
import { spawn } from "node:child_process";
import { chmod, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { chromeArgs, loadConfig } from "./config.mjs";
import {
  CdpClient,
  evaluateInFirstPage,
  isProfileOwner,
  probeHttp,
  publishEndpoint,
  readDevToolsActivePort,
  readState,
  removeFile,
  requestBrowserClose,
  resolveEndpoint,
  rootPid,
  writeDevToolsActivePort,
  writeState,
  wsGuid,
} from "./cdp.mjs";
import { findRootProcess, killPids, listBrowserProcesses, ownedProcesses, pidAlive, portOpen, sleep, waitFor } from "./proc.mjs";

/** Chrome's profile-scoped lock artefacts (Windows: lockfile; POSIX: Singleton*). */
const LOCK_FILES = ["SingletonLock", "SingletonCookie", "SingletonSocket", "lockfile"];

function config(env) {
  const loaded = loadConfig(env);
  if (!loaded.binary) {
    throw new Error(
      "No Chrome/Chromium binary found. Set CHROME_CDP_BINARY to chrome.exe (install Chrome or a Chrome for Testing build).",
    );
  }
  return loaded;
}

async function statSafe(path) {
  try {
    return await stat(path);
  } catch {
    return undefined;
  }
}

/** Remove profile locks + stale DevToolsActivePort, but only when nothing owns the profile. */
export async function cleanStaleLocks(cfg, { dryRun = false } = {}) {
  const removed = [];
  const root = await statSafe(cfg.profile);
  if (!root) return removed;
  for (const name of LOCK_FILES) {
    const file = join(cfg.profile, name);
    if (await statSafe(file)) {
      if (!dryRun) await removeFile(file);
      removed.push(file);
    }
  }
  const active = join(cfg.profile, "DevToolsActivePort");
  if (await statSafe(active)) {
    if (!dryRun) await removeFile(active);
    removed.push(active);
  }
  return removed;
}

async function ensureProfileDir(cfg) {
  const existed = Boolean(await statSafe(cfg.profile));
  await mkdir(cfg.profile, { recursive: true });
  if (process.platform !== "win32") await chmod(cfg.profile, 0o700).catch(() => undefined);
  return existed;
}

/** Inspect current reality without mutating anything. */
export async function inspect(cfg) {
  const probe = await probeHttp(cfg.httpEndpoint, 1500);
  const owned = await ownedProcesses(cfg.profile);
  const portTaken = await portOpen(cfg.port);
  const active = await readDevToolsActivePort(cfg.profile);
  const state = await readState(cfg.stateFile);

  let live = probe.ok;
  let mismatchedProfile = false;

  if (probe.ok) {
    // Verify the live port really is our browser: cmdline must match, or the browser PID must be one of ours.
    mismatchedProfile = owned.length === 0;
  }

  return {
    probe,
    owned,
    rootProcess: findRootProcess(owned),
    portTaken,
    active,
    state,
    live,
    mismatchedProfile,
    profileExists: Boolean(await statSafe(cfg.profile)),
  };
}

/** Idempotent: returns a live ws endpoint for the shared browser, launching only when needed. */
export async function ensure(env = process.env, { quiet = false, timeoutMs } = {}) {
  const cfg = config(env);
  const log = (...args) => {
    if (!quiet) console.log(...args);
  };

  // Fast path (no shell spawn): something answers on our port and we can prove it is the browser
  // we launched (recorded browser GUID), or it was launched against our profile.
  const probe = await probeHttp(cfg.httpEndpoint, 2000);
  if (probe.ok) {
    const state = await readState(cfg.stateFile);
    const ours = state?.guid === wsGuid(probe.wsUrl) || (await isProfileOwner(probe.wsUrl, cfg.profile));
    if (ours) {
      const pages = await countPages(probe.wsUrl).catch(() => undefined);
      const pid = state?.pid ?? (await rootPid(probe.wsUrl));
      await publishEndpointFor(cfg, probe.wsUrl, pid);
      log(`[chrome-cdp] already live on ${cfg.httpEndpoint} (pid ${pid ?? "?"}, pages ${pages ?? "?"})`);
      return { wsUrl: probe.wsUrl, browser: probe.browser, source: "live", port: cfg.port, profile: cfg.profile, pid, reused: true };
    }
  }

  const before = await inspect(cfg);

  if (before.live && !before.mismatchedProfile) {
    const endpoint = await resolveEndpoint(cfg);
    const pages = await countPages(endpoint.wsUrl).catch(() => undefined);
    log(`[chrome-cdp] already live on ${cfg.httpEndpoint} (pid ${before.rootProcess?.ProcessId ?? "?"}, pages ${pages ?? "?"})`);
    return { ...endpoint, port: cfg.port, profile: cfg.profile, reused: true, pid: before.rootProcess?.ProcessId };
  }

  if (before.live && before.mismatchedProfile) {
    log(`[chrome-cdp] port ${cfg.port} is owned by a different browser — relaunching on this profile`);
  }

  // Anything holding our profile must die before launch, or Chrome silently steals/duplicates state.
  if (before.owned.length > 0) {
    log(`[chrome-cdp] killing ${before.owned.length} process(es) holding the profile`);
    await killPids(before.owned.map((row) => row.ProcessId));
    await waitFor(async () => (await ownedProcesses(cfg.profile)).length === 0, { timeoutMs: 10_000 });
  }

  if (before.portTaken && !before.live) {
    log(`[chrome-cdp] port ${cfg.port} is taken but not answering CDP — waiting once more`);
    const recheck = await probeHttp(cfg.httpEndpoint, 3000);
    if (!recheck.ok) log(`[chrome-cdp] proceeding anyway (${recheck.error})`);
  }

  const removed = await cleanStaleLocks(cfg);
  if (removed.length) log(`[chrome-cdp] cleared stale lock/port files: ${removed.map(rel).join(", ")}`);

  await ensureProfileDir(cfg);

  const args = chromeArgs(cfg);
  log(`[chrome-cdp] launching ${cfg.binary}`);
  const child = spawn(cfg.binary, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
    env: { ...process.env, CHROME_CDP_PORT: String(cfg.port) },
  });
  child.unref();

  const ready = await waitFor(
    async () => {
      const probe = await probeHttp(cfg.httpEndpoint, 1000);
      return probe.ok ? probe : undefined;
    },
    { timeoutMs: timeoutMs ?? cfg.readyTimeoutMs, intervalMs: 300 },
  );

  if (!ready?.ok) {
    const owned = await ownedProcesses(cfg.profile);
    const lastError = (await probeHttp(cfg.httpEndpoint, 1000)).error;
    throw new Error(
      `Chrome never became CDP-ready on ${cfg.httpEndpoint} after ${Math.round(
        (timeoutMs ?? cfg.readyTimeoutMs) / 1000,
      )}s (${lastError ?? "timeout"}). ` +
        `Owned processes: ${owned.map((p) => p.ProcessId).join(", ") || "none"}. Run \`chrome-cdp doctor\`.`,
    );
  }

  const endpoint = await resolveEndpoint(cfg);
  const pid = (await rootPid(endpoint.wsUrl)) ?? child.pid;
  await writeState(cfg.stateFile, {
    port: cfg.port,
    http: cfg.httpEndpoint,
    ws: endpoint.wsUrl,
    guid: wsGuid(endpoint.wsUrl),
    profile: cfg.profile,
    binary: cfg.binary,
    pid,
    spawnPid: child.pid,
    startedAt: new Date().toISOString(),
  });
  await publishEndpointFor(cfg, endpoint.wsUrl, pid);

  log(`[chrome-cdp] ready: ${cfg.httpEndpoint} (${endpoint.wsUrl})`);
  return { ...endpoint, port: cfg.port, profile: cfg.profile, reused: false, pid };
}

/**
 * Publish the live endpoint twice:
 *  - endpoint.json      — for scripts / agents that want host+port+ws explicitly
 *  - DevToolsActivePort — Chrome's own format, so clients that resolve via `profileDir` work
 *                         (Chrome 147+ no longer writes it for explicit --remote-debugging-port)
 */
async function publishEndpointFor(cfg, wsUrl, pid) {
  const wsPath = `/${String(wsUrl).split("/").slice(3).join("/")}`;
  const payload = {
    port: cfg.port,
    http: cfg.httpEndpoint,
    ws: wsUrl,
    guid: wsGuid(wsUrl),
    profile: cfg.profile,
    pid,
    updatedAt: new Date().toISOString(),
  };
  await publishEndpoint(cfg.endpointFile, payload);
  await writeDevToolsActivePort(cfg.profile, { port: cfg.port, wsPath });
  return payload;
}

function rel(path) {
  return String(path).split(/[\\/]/).pop();
}

async function countPages(wsUrl) {
  const client = await CdpClient.connect(wsUrl, { timeoutMs: 5000 });
  try {
    const { targetInfos } = await client.send("Target.getTargets");
    return (targetInfos ?? []).filter((t) => t.type === "page").length;
  } finally {
    client.close();
  }
}

/** Stop the shared browser gracefully. */
export async function stop(env = process.env, { quiet = false } = {}) {
  const cfg = config(env);
  const log = (...args) => {
    if (!quiet) console.log(...args);
  };
  const info = await inspect(cfg);

  if (!info.live && info.owned.length === 0) {
    await cleanStaleLocks(cfg);
    await removeFile(cfg.stateFile);
    await removeFile(cfg.endpointFile);
    log("[chrome-cdp] not running");
    return { stopped: false };
  }

  if (info.live) {
    log("[chrome-cdp] sending Browser.close");
    await requestBrowserClose(info.probe.wsUrl).catch(() => undefined);
    const gone = await waitFor(async () => !(await probeHttp(cfg.httpEndpoint, 800)).ok, { timeoutMs: 8000 });
    if (!gone) log("[chrome-cdp] graceful close timed out, forcing");
  }

  const stillOwned = await ownedProcesses(cfg.profile);
  if (stillOwned.length) await killPids(stillOwned.map((row) => row.ProcessId));

  await cleanStaleLocks(cfg);
  await removeFile(cfg.stateFile);
  await removeFile(cfg.endpointFile);
  log("[chrome-cdp] stopped");
  return { stopped: true };
}

/** Restart in one step. */
export async function restart(env = process.env, opts = {}) {
  await stop(env, { quiet: true });
  await sleep(400);
  return ensure(env, opts);
}

/** Full diagnostic report; mutates nothing. */
export async function doctor(env = process.env) {
  let cfg;
  const checks = [];
  const add = (id, status, detail) => checks.push({ id, status, detail });

  try {
    cfg = config(env);
  } catch (error) {
    return { ok: false, checks: [{ id: "config", status: "fail", detail: String(error.message) }], cfg: undefined };
  }

  add("node", Number(process.versions.node.split(".")[0]) >= 22 ? "pass" : "fail", `node ${process.versions.node} (>=22 required)`);
  add("binary", cfg.binary ? "pass" : "fail", cfg.binary ?? "no chrome.exe found — set CHROME_CDP_BINARY");

  const profileStat = await statSafe(cfg.profile);
  add(
    "profile",
    profileStat ? "pass" : "warn",
    profileStat ? `${cfg.profile} (created ${profileStat.birthtime.toISOString().slice(0, 10)})` : `${cfg.profile} missing (will be created)`,
  );

  const info = await inspect(cfg);

  if (info.live) {
    add("cdp-endpoint", "pass", `${cfg.httpEndpoint} -> ${info.probe.body?.Browser ?? "browser"}`);
    add("profile-owner", info.mismatchedProfile ? "warn" : "pass", info.mismatchedProfile ? "live port is NOT this profile's browser" : "owned by this profile");
    try {
      const client = await CdpClient.connect(info.probe.wsUrl, { timeoutMs: 4000 });
      const { targetInfos } = await client.send("Target.getTargets");
      const pages = (targetInfos ?? []).filter((t) => t.type === "page");
      const probeEval = await evaluateInFirstPage(client, "1+1").catch(() => undefined);
      add("cdp-handshake", "pass", `Target.getTargets ok (${pages.length} page target(s))`);
      add("js-eval", probeEval?.value === 2 ? "pass" : "fail", `Runtime.evaluate -> ${JSON.stringify(probeEval?.value)}`);
      client.close();
    } catch (error) {
      add("cdp-handshake", "fail", String(error.message));
    }
  } else {
    add("cdp-endpoint", "warn", `${cfg.httpEndpoint} not answering (${info.probe.error}) — run \`chrome-cdp ensure\``);
  }

  add("port", info.portTaken ? (info.live ? "pass" : "warn") : "pass", info.portTaken ? `port ${cfg.port} occupied` : `port ${cfg.port} free`);
  if (info.active && !info.live) add("stale-locks", "warn", "DevToolsActivePort present but no live browser — `ensure` will clear it");

  const otherAutomation = (await listBrowserProcesses()).filter(
    (row) => /--remote-debugging-port=\d+/.test(String(row.CommandLine ?? "")) && !String(row.CommandLine).includes(cfg.profile.replace(/\\/g, "\\")),
  );
  const otherPorts = [
    ...new Set(
      otherAutomation
        .map((row) => String(row.CommandLine).match(/--remote-debugging-port=(\d+)/)?.[1])
        .filter((port) => port && port !== String(cfg.port)),
    ),
  ];
  add(
    "rival-browsers",
    "pass",
    otherPorts.length ? `other CDP browsers on port(s) ${otherPorts.join(", ")} (expected for project scripts)` : "none",
  );

  const rivalOwners = info.owned.filter((row) => !info.live);
  add("orphan-profile-procs", rivalOwners.length === 0 ? "pass" : "warn", rivalOwners.length ? `${rivalOwners.length} process(es) hold the profile with no live port` : "clean");

  const state = await readState(cfg.stateFile);
  add("state-file", state ? "pass" : "warn", state ? `${cfg.stateFile} (started ${state.startedAt})` : "no state file (never launched by broker)");

  const published = await readState(cfg.endpointFile);
  const guideline = published?.guid;
  if (info.live) {
    const liveGuid = wsGuid(info.probe.wsUrl);
    add(
      "endpoint-published",
      published ? (guideline === liveGuid ? "pass" : "warn") : "warn",
      published ? `${cfg.endpointFile} -> ${published.ws}` : "endpoint.json missing — run `chrome-cdp ensure`",
    );
    add(
      "devtools-active-port",
      info.active ? (info.active.port === cfg.port ? "pass" : "fail") : "warn",
      info.active ? `${info.active.file} -> port ${info.active.port}` : "broker-written file missing — run `chrome-cdp ensure`",
    );
  }

  const failed = checks.filter((c) => c.status === "fail").length;
  return { ok: failed === 0, cfg, checks, live: info.live, ws: info.live ? info.probe.wsUrl : undefined };
}

/** Print a doctor report. */
export async function doctorReport(env = process.env) {
  const report = await doctor(env);
  const icon = { pass: "PASS", warn: "WARN", fail: "FAIL" };
  console.log(`chrome-cdp doctor — ${report.ok ? "OK" : "PROBLEMS"}`);
  for (const check of report.checks) console.log(`  [${icon[check.status]}] ${check.id}: ${check.detail}`);
  if (report.cfg) {
    console.log(`\nendpoint : ${report.cfg.httpEndpoint}`);
    console.log(`profile  : ${report.cfg.profile}`);
    console.log(`binary   : ${report.cfg.binary ?? "(none)"}`);
    console.log(`state    : ${report.cfg.stateFile}`);
  }
  return report;
}

/** Evaluate JS in the first page of the shared browser (launching it if needed). */
export async function evaluate(expression, env = process.env) {
  const endpoint = await ensure(env, { quiet: true });
  const client = await CdpClient.connect(endpoint.wsUrl, { timeoutMs: 10_000 });
  try {
    return await evaluateInFirstPage(client, expression);
  } finally {
    client.close();
  }
}

/** Open a URL in the shared browser as a new tab. */
export async function openUrl(url, env = process.env) {
  const endpoint = await ensure(env, { quiet: true });
  const client = await CdpClient.connect(endpoint.wsUrl, { timeoutMs: 10_000 });
  try {
    await client.send("Target.createTarget", { url });
    return endpoint;
  } finally {
    client.close();
  }
}
