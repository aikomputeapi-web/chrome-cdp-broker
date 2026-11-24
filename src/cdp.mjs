/**
 * Minimal CDP client + endpoint discovery. Zero dependencies (uses the Node 22 global WebSocket).
 */
import { readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Chrome writes this in the user-data-dir whenever --remote-debugging-port is used. */
export async function readDevToolsActivePort(profile) {
  try {
    const file = join(profile, "DevToolsActivePort");
    const [text, stats] = await Promise.all([readFile(file, "utf8"), stat(file)]);
    const [portLine, pathLine] = text.trim().split("\n");
    const port = Number(portLine);
    if (!Number.isFinite(port) || !pathLine?.startsWith("/devtools/")) return undefined;
    return { port, wsPath: pathLine, file, mtimeMs: stats.mtimeMs, wsUrl: `ws://127.0.0.1:${port}${pathLine}` };
  } catch {
    return undefined;
  }
}

/** GET /json/version — the authoritative "is a CDP browser listening here" probe. */
export async function probeHttp(httpEndpoint, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${httpEndpoint}/json/version`, { signal: controller.signal });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = await res.json();
    if (!body?.webSocketDebuggerUrl) return { ok: false, error: "no webSocketDebuggerUrl" };
    return { ok: true, body, wsUrl: body.webSocketDebuggerUrl, browser: body.Browser };
  } catch (error) {
    return { ok: false, error: error?.name === "AbortError" ? "timeout" : String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve the live ws endpoint for this profile: HTTP probe first, DevToolsActivePort second. */
export async function resolveEndpoint({ httpEndpoint, profile, timeoutMs }) {
  const probe = await probeHttp(httpEndpoint, timeoutMs);
  if (probe.ok) return { source: "http", wsUrl: probe.wsUrl, browser: probe.browser };
  const active = await readDevToolsActivePort(profile);
  if (active) {
    const viaFile = await probeHttp(`http://127.0.0.1:${active.port}`, timeoutMs);
    if (viaFile.ok) return { source: "DevToolsActivePort", wsUrl: viaFile.wsUrl, browser: viaFile.browser };
  }
  return { source: "none", error: probe.error };
}

export class CdpClient {
  constructor(wsUrl, { timeoutMs = 10_000 } = {}) {
    this.wsUrl = wsUrl;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
  }

  static async connect(wsUrl, options) {
    const client = new CdpClient(wsUrl, options);
    await client.open();
    return client;
  }

  open() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error(`CDP connect timeout: ${this.wsUrl}`)), this.timeoutMs);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener("error", (event) => {
        clearTimeout(timer);
        reject(new Error(`CDP connect failed (${event?.message ?? "error"})`));
      });
      ws.addEventListener("message", (event) => {
        let msg;
        try {
          msg = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: res, reject: rej } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) rej(new Error(`CDP ${msg.error.code}: ${msg.error.message}`));
          else res(msg.result);
        } else if (msg.method) {
          this.events.push(msg);
        }
      });
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.ws.send(JSON.stringify(payload));
    });
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
  }
}

/** List page targets (browser-level Target.getTargets). */
export async function listPages(client) {
  const { targetInfos } = await client.send("Target.getTargets");
  return (targetInfos ?? []).filter((t) => t.type === "page");
}

/** Evaluate an expression in the first page target and return its JSON value. */
export async function evaluateInFirstPage(client, expression) {
  const pages = await listPages(client);
  if (pages.length === 0) throw new Error("no page target available");
  const { sessionId } = await client.send("Target.attachToTarget", { targetId: pages[0].targetId, flatten: true });
  await client.send("Runtime.enable", {}, sessionId);
  const result = await client.send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  );
  if (result.exceptionDetails) {
    throw new Error(`eval threw: ${result.exceptionDetails.exception?.description ?? "unknown"}`);
  }
  return { value: result.result?.value, targetId: pages[0].targetId, url: pages[0].url };
}

/** Politely ask the browser to exit (flushes the profile), then hard-kill if needed. */
export async function requestBrowserClose(wsUrl, timeoutMs = 5_000) {
  const client = await CdpClient.connect(wsUrl, { timeoutMs });
  try {
    await client.send("Browser.close");
  } catch {
    // Browser.close often resolves by the socket dying — that is success.
  } finally {
    client.close();
  }
}

/** Browser.getBrowserCommandLine — authoritative, shell-free way to prove which profile a live browser owns. */
export async function browserCommandLine(wsUrl, timeoutMs = 4000) {
  const client = await CdpClient.connect(wsUrl, { timeoutMs });
  try {
    const { arguments: args } = await client.send("Browser.getBrowserCommandLine");
    return args ?? [];
  } finally {
    client.close();
  }
}

function normPath(value) {
  return String(value ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** Browser GUID from a ws endpoint — random per launch, so it identifies one specific browser run. */
export function wsGuid(wsUrl) {
  return String(wsUrl ?? "").split("/").pop();
}

/**
 * Chrome 147+ stopped writing DevToolsActivePort when launched with an explicit
 * --remote-debugging-port + --user-data-dir, which breaks clients that resolve the endpoint from
 * the profile dir. The broker owns the file instead, in Chrome's own two-line format.
 */
export async function writeDevToolsActivePort(profile, { port, wsPath }) {
  await writeFile(join(profile, "DevToolsActivePort"), `${port}\n${wsPath}\n`, "utf8").catch(() => undefined);
}

/** Publish the live endpoint for other agents/tools (pi-browser-cdp-extension, scripts, other CLIs). */
export async function publishEndpoint(file, payload) {
  await writeState(file, payload);
}

/** True when the live browser was launched against exactly `profile` (needs --enable-automation). */
export async function isProfileOwner(wsUrl, profile) {
  try {
    const args = await browserCommandLine(wsUrl);
    const needle = `--user-data-dir=${normPath(profile)}`;
    return args.some((arg) => normPath(arg) === needle);
  } catch {
    return false;
  }
}

/** Real root (browser-process) pid, read over CDP instead of from a possibly-stale spawn handle. */
export async function rootPid(wsUrl, timeoutMs = 4000) {
  const client = await CdpClient.connect(wsUrl, { timeoutMs });
  try {
    const { processInfo } = await client.send("SystemInfo.getProcessInfo");
    const browser = (processInfo ?? []).find((entry) => entry.type === "browser");
    return browser?.id;
  } catch {
    return undefined;
  } finally {
    client.close();
  }
}

/** Broker sidecar state, kept outside the Chrome profile. */
export async function writeState(file, state) {
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, "utf8").catch(() => undefined);
}

export async function readState(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

export async function removeFile(file) {
  await unlink(file).catch(() => undefined);
}
