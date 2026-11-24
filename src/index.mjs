/**
 * Library entry point for the chrome-cdp broker block.
 * Import from other projects/tools instead of shelling out when you want programmatic control.
 */
export {
  cleanStaleLocks,
  doctor,
  doctorReport,
  ensure,
  evaluate,
  inspect,
  openUrl,
  restart,
  stop,
} from "./broker.mjs";

export {
  browserCommandLine,
  isProfileOwner,
  listPages,
  probeHttp,
  readDevToolsActivePort,
  readState,
  resolveEndpoint,
  rootPid,
  wsGuid,
} from "./cdp.mjs";

export { chromeArgs, loadConfig, resolveBinary } from "./config.mjs";
export { ownedProcesses, pidAlive, portOpen } from "./proc.mjs";

/** Convenience: the live ws endpoint, or undefined when the browser is down. */
export async function wsEndpoint(env = process.env) {
  const { loadConfig } = await import("./config.mjs");
  const { probeHttp } = await import("./cdp.mjs");
  const { ok, wsUrl } = await probeHttp(loadConfig(env).httpEndpoint, 1500);
  return ok ? wsUrl : undefined;
}
