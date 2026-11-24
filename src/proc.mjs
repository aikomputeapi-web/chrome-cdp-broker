/**
 * Process discovery / control, scoped strictly to the broker's own --user-data-dir.
 * Daily Chrome and other automation browsers are never touched.
 */
import { execFile } from "node:child_process";
import { platform } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const isWin = platform() === "win32";

function normalize(value) {
  return String(value ?? "").replace(/\\/g, "/").toLowerCase();
}

/** All chrome-ish processes with their command lines. */
export async function listBrowserProcesses() {
  if (isWin) {
    const ps = [
      "$ErrorActionPreference='SilentlyContinue';",
      "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' or Name='msedge.exe'\" |",
      "Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress -Depth 3",
    ].join(" ");
    const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], {
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    return parseRows(stdout);
  }

  const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid=,comm=,args="], { maxBuffer: 16 * 1024 * 1024 });
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
      if (!match) return undefined;
      return { ProcessId: Number(match[1]), ParentProcessId: Number(match[2]), Name: match[3], CommandLine: match[4] };
    })
    .filter(Boolean);
}

function parseRows(stdout) {
  const text = stdout.trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

/** Processes launched against this exact profile dir (all child helpers + the root). */
export async function ownedProcesses(profile) {
  const needle = `--user-data-dir=${normalize(profile)}`;
  const rows = await listBrowserProcesses();
  return rows.filter((row) => normalize(row.CommandLine).includes(needle));
}

/** The root browser process (the one that does NOT have --type=). */
export function findRootProcess(rows) {
  return rows.find((row) => !/(^|\s)--type=/.test(String(row.CommandLine ?? "")));
}

/** Is a TCP port accepting connections on the loopback interface? */
export async function portOpen(port, host = "127.0.0.1", timeoutMs = 750) {
  const { createConnection } = await import("node:net");
  return new Promise((resolve) => {
    const socket = createConnection({ port, host });
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

export async function killPids(pids, { force = true } = {}) {
  const list = [...new Set(pids.filter(Boolean))];
  if (list.length === 0) return [];
  if (isWin) {
    const ps = `Stop-Process -Id ${list.join(",")} ${force ? "-Force" : ""} -ErrorAction SilentlyContinue`;
    await execFileAsync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true }).catch(
      () => undefined,
    );
  } else {
    for (const pid of list) {
      try {
        process.kill(pid, force ? "SIGKILL" : "SIGTERM");
      } catch {
        // already gone
      }
    }
  }
  return list;
}

export async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Cheap liveness check for a recorded pid (no shell spawn). */
export function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/** Poll until predicate() is truthy or the deadline passes. */
export async function waitFor(predicate, { timeoutMs = 10_000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await sleep(intervalMs);
  }
  return undefined;
}
