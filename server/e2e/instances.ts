/**
 * The node processes the E2E suite talks to. They all share one database; each differs in the setting a test needs.
 * Ports are fixed (default 3410..3413, base overridable with E2E_PORT_BASE) so playwright.config.ts can name a baseURL.
 */
const PORT_BASE = Number(process.env["E2E_PORT_BASE"] ?? 3410);

export const REPO_URL_OVERRIDE = "https://example.org/my-fork/trafficnetwork";

export interface Instance {
  port: number;
  env: Record<string, string>;
  /**
   * The exceptions of the signed `cameraPolicyByCountry` this node reads (docs/camera-country-policy.md); without it every country is
   * delivered in `full`. global-setup signs them with a throw-away root key and hands the node the file.
   */
  policy?: Record<string, "off" | "zones">;
}

export const INSTANCES = {
  /** Default node: web UI on, the camera emergency brake pulled (SPEED_CAMERA_NAMESPACE_ENABLED=false): no camera category at all. */
  main: { port: PORT_BASE, env: {} as Record<string, string> } as Instance,
  /** Brake released, no country restricted (the default level is `full`); also runs with a different project link. */
  cameras: { port: PORT_BASE + 1, env: { SPEED_CAMERA_NAMESPACE_ENABLED: "true", PROJECT_REPO_URL: REPO_URL_OVERRIDE } as Record<string, string> } as Instance,
  /** One report per web session, to see the honest "limit reached" feedback. */
  limited: { port: PORT_BASE + 2, env: { WEB_REPORT_LIMIT_PER_SESSION: "1" } as Record<string, string> } as Instance,
  /** Operator switched the web UI off. */
  disabled: { port: PORT_BASE + 3, env: { WEB_UI_ENABLED: "false" } as Record<string, string> } as Instance,
  /** No map background: the page must not talk to anyone but this node (also lets the browser cache be tested without request interception). */
  notiles: { port: PORT_BASE + 4, env: { MAP_TILE_URL: "none" } as Record<string, string> } as Instance,
  /** The signed policy takes Germany back to `zones`: the test town is shown as an area, never as a spot. */
  zones: { port: PORT_BASE + 5, env: { SPEED_CAMERA_NAMESPACE_ENABLED: "true" } as Record<string, string>, policy: { DE: "zones" } } as Instance,
  /** The signed policy takes Germany off, other countries stay `full`: the category exists, but nothing in the test town is delivered. */
  germanyOff: { port: PORT_BASE + 6, env: { SPEED_CAMERA_NAMESPACE_ENABLED: "true" } as Record<string, string>, policy: { DE: "off" } } as Instance,
  /** The operator capped every country at `off` on this node only (CAMERA_POLICY_LOCAL_CAPS): the camera category is absent entirely. */
  allOff: { port: PORT_BASE + 7, env: { SPEED_CAMERA_NAMESPACE_ENABLED: "true", CAMERA_POLICY_LOCAL_CAPS: "*=off" } as Record<string, string> } as Instance,
} satisfies Record<string, Instance>;

export type InstanceName = keyof typeof INSTANCES;

export function instanceUrl(name: InstanceName): string {
  return `http://127.0.0.1:${INSTANCES[name].port}`;
}
