/**
 * Config resolution for the chrome-cdp broker.
 *
 * Everything is env-overridable so the broker can be reused as a block by other
 * projects without editing source:
 *   CHROME_CDP_PORT            CDP port                   (default 9333)
 *   CHROME_CDP_PROFILE         user-data-dir              (default ~/.chrome-dev-tools/profile)
 *   CHROME_CDP_BINARY          chrome.exe path            (default: auto-detect, system Chrome first)
 *   CHROME_CDP_START_URL       initial page               (default about:blank)
 *   CHROME_CDP_WINDOW_SIZE     WxH                        (default 1440,900)
 *   CHROME_CDP_HEADLESS        1 = new headless           (default 0 = headful)
 *   CHROME_CDP_NO_SANDBOX      1 = add --no-sandbox        (default 0)
 *   CHROME_CDP_READY_TIMEOUT   ms to wait for readiness   (default 30000)
 */
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

export const HOST = "127.0.0.1";

const isWin = platform() === "win32";
const isMac = platform() === "darwin";

/** Dedicated automation profile — deliberately NOT the daily Chrome profile. */
export const DEFAULT_PROFILE = join(homedir(), ".chrome-dev-tools", "profile");

/**
 * Broker-owned sidecar dir (never inside the Chrome profile itself).
 * Defaults next to the profile so a custom CHROME_CDP_PROFILE gets its own isolated state.
 */
export function stateDir(profile = DEFAULT_PROFILE, env = process.env) {
  return env.CHROME_CDP_STATE_DIR?.trim() || join(dirname(profile), ".chrome-cdp");
}

export function stateFile(profile, env) {
  return join(stateDir(profile, env), "broker-state.json");
}

export function endpointFile(profile, env) {
  return join(stateDir(profile, env), "endpoint.json");
}

/**
 * Chrome/Chromium binary candidates, best-first.
 * System Chrome matches the profile pi-chrome-dev-tools already warms.
 */
export function binaryCandidates(env = process.env) {
  const list = [];
  if (env.CHROME_CDP_BINARY) list.push(env.CHROME_CDP_BINARY);

  if (isWin) {
    const local = env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    const pf = env.ProgramFiles ?? "C:\\Program Files";
    const pf86 = env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    list.push(
      join(pf, "Google", "Chrome", "Application", "chrome.exe"),
      join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
      join(local, "Google", "Chrome", "Application", "chrome.exe"),
      // Dedicated Chrome for Testing build used by the nodriver stealth stack.
      join(homedir(), "coding", "agent-tools", "chrome-nodriver", "chrome-win64", "chrome.exe"),
      join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
    );
  } else if (isMac) {
    list.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    );
  } else {
    list.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/snap/bin/chromium",
    );
  }

  if (env.CHROME_CDP_BINARY_EXCLUDE) {
    const excluded = new Set(env.CHROME_CDP_BINARY_EXCLUDE.split(/[;,]/).map((s) => s.trim()).filter(Boolean));
    return list.filter((p) => !excluded.has(p));
  }
  return list;
}

export function resolveBinary(env = process.env) {
  for (const candidate of binaryCandidates(env)) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function num(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(env = process.env) {
  const port = num(env.CHROME_CDP_PORT, 9333);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`CHROME_CDP_PORT out of range: ${env.CHROME_CDP_PORT}`);
  }
  const profile = env.CHROME_CDP_PROFILE?.trim() || DEFAULT_PROFILE;
  const binary = resolveBinary(env);

  return {
    port,
    host: HOST,
    profile,
    binary,
    startUrl: env.CHROME_CDP_START_URL?.trim() || "about:blank",
    windowSize: env.CHROME_CDP_WINDOW_SIZE?.trim() || "1440,900",
    headless: env.CHROME_CDP_HEADLESS === "1",
    noSandbox: env.CHROME_CDP_NO_SANDBOX === "1",
    readyTimeoutMs: num(env.CHROME_CDP_READY_TIMEOUT, 30_000),
    enableAutomation: env.CHROME_CDP_ENABLE_AUTOMATION === "1",
    httpEndpoint: `http://${HOST}:${port}`,
    stateFile: stateFile(profile, env),
    endpointFile: endpointFile(profile, env),
  };
}

/** Chrome flags for a warmed, non-obvious automation browser (see browser-automation-config-notes). */
export function chromeArgs(config) {
  const args = [
    `--user-data-dir=${config.profile}`,
    `--remote-debugging-port=${config.port}`,
    `--remote-debugging-address=${config.host}`,
    // Let CDP clients that send an Origin header (browser page scripts, some MCP bridges) attach.
    "--remote-allow-origins=*",
    // Anti-detect baseline: removes the automation banner/flag surface.
    "--disable-blink-features=AutomationControlled",
    "--no-first-run",
    "--no-default-browser-check",
    "--no-service-autorun",
    "--password-store=basic",
    "--use-mock-keychain",
    "--disable-search-engine-choice-screen",
    "--disable-infobars",
    "--disable-session-crashed-bubble",
    `--window-size=${config.windowSize}`,
    config.startUrl,
  ];
  if (config.headless) args.splice(args.length - 1, 0, "--headless=new");
  if (config.noSandbox) args.splice(args.length - 1, 0, "--no-sandbox");
  // --enable-automation makes Browser.getBrowserCommandLine available (and sets navigator.webdriver).
  if (config.enableAutomation) args.splice(args.length - 1, 0, "--enable-automation");
  return args;
}
