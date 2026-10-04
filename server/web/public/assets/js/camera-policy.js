/**
 * What this node says about camera data, reduced to what the page needs (GET /v1/config; server/docs/camera-country-policy.md).
 *
 * `available` — the camera categories exist in the page at all (filter, report category): the node delivers camera data in some
 * country. With the emergency brake pulled, or every country at `off`, there is no such category anywhere in the page.
 * `hasZones` — somewhere this node shows only approximate areas instead of single spots, which the filter explains.
 *
 * A node that predates the country policy has no `cameraPolicy`; then its old flag decides.
 */
export function readCameraPolicy(config) {
  const flag = config?.speedCameraNamespaceEnabled === true;
  const policy = config?.cameraPolicy;
  const known = (level) => level === "off" || level === "zones" || level === "full";
  if (!policy || typeof policy !== "object" || !known(policy.defaultLevel)) return { available: flag, hasZones: false, noticeVersion: 1 };

  const exceptions = Object.values(policy.byCountry ?? {}).filter(known);
  const levels = [policy.defaultLevel, ...exceptions];
  const delivers = policy.namespaceEnabled !== false && levels.some((level) => level === "zones" || level === "full");
  const noticeVersion = Number.isInteger(policy.notice?.version) && policy.notice.version > 0 ? policy.notice.version : 1;
  return { available: flag && delivers, hasZones: delivers && levels.includes("zones"), noticeVersion };
}
