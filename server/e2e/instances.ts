/**
 * The node processes the E2E suite talks to. They all share one database; each differs in the setting a test needs.
 * Ports are fixed (default 3410..3413, base overridable with E2E_PORT_BASE) so playwright.config.ts can name a baseURL.
 */
const PORT_BASE = Number(process.env["E2E_PORT_BASE"] ?? 3410);

export const REPO_URL_OVERRIDE = "https://example.org/my-fork/trafficnetwork";

export const INSTANCES = {
  /** Default node: web UI on, speed-camera namespace off. */
  main: { port: PORT_BASE, env: {} as Record<string, string> },
  /** Operator enabled the speed-camera namespace; also runs with a different project link. */
  cameras: { port: PORT_BASE + 1, env: { SPEED_CAMERA_NAMESPACE_ENABLED: "true", PROJECT_REPO_URL: REPO_URL_OVERRIDE } as Record<string, string> },
  /** One report per web session, to see the honest "limit reached" feedback. */
  limited: { port: PORT_BASE + 2, env: { WEB_REPORT_LIMIT_PER_SESSION: "1" } as Record<string, string> },
  /** Operator switched the web UI off. */
  disabled: { port: PORT_BASE + 3, env: { WEB_UI_ENABLED: "false" } as Record<string, string> },
} as const;

export type InstanceName = keyof typeof INSTANCES;

export function instanceUrl(name: InstanceName): string {
  return `http://127.0.0.1:${INSTANCES[name].port}`;
}
