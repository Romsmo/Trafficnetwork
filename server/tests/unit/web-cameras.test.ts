import { describe, expect, it } from "vitest";
import { readCameraPolicy } from "../../web/public/assets/js/camera-policy.js";
import { CAMERA_TYPES, GENERAL_TYPES, anyCameraEnabled, defaultEnabled, filterReports, filterZones, selectableTypes, zoneLatLngs, zoneTypes } from "../../web/public/assets/js/filter.js";
import { initialSelection, loadFilterPrefs, markNoticeSeen, noticeSeen, saveFilterPref } from "../../web/public/assets/js/prefs.js";
import { DICTIONARIES } from "../../web/public/assets/js/i18n.js";
import { describeSubmitFailure } from "../../web/public/assets/js/report-dialog.js";

/** A stand-in for localStorage. */
function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  } as unknown as Storage;
  return Object.assign(storage, { dump: () => Object.fromEntries(data) });
}

const policy = (over: Record<string, unknown> = {}) => ({
  speedCameraNamespaceEnabled: true,
  cameraPolicy: { version: "x", namespaceEnabled: true, defaultLevel: "full", byCountry: {}, zoneResolution: 6, notice: { version: 1 }, ...over },
});

describe("what the page reads from the node's camera policy (GET /v1/config)", () => {
  it("offers the camera categories when the node delivers cameras in full", () => {
    expect(readCameraPolicy(policy())).toMatchObject({ available: true, hasZones: false });
  });

  it("offers them when only some countries are restricted, and says when areas are involved", () => {
    expect(readCameraPolicy(policy({ byCountry: { CH: "off", FR: "zones" } }))).toMatchObject({ available: true, hasZones: true });
    expect(readCameraPolicy(policy({ byCountry: { CH: "off" } }))).toMatchObject({ available: true, hasZones: false });
  });

  it("offers them when everything is areas, and knows that", () => {
    expect(readCameraPolicy(policy({ defaultLevel: "zones" }))).toMatchObject({ available: true, hasZones: true });
  });

  it("has no camera category at all when nothing is delivered: every country off, or the emergency brake", () => {
    expect(readCameraPolicy(policy({ defaultLevel: "off" })).available).toBe(false);
    expect(readCameraPolicy(policy({ defaultLevel: "off", byCountry: { DE: "off" } })).available).toBe(false);
    expect(readCameraPolicy(policy({ namespaceEnabled: false, defaultLevel: "off" })).available).toBe(false);
    expect(readCameraPolicy({ speedCameraNamespaceEnabled: false, cameraPolicy: policy().cameraPolicy }).available).toBe(false);
  });

  it("a restriction on one country does not hide the category elsewhere: it only matters where it applies", () => {
    expect(readCameraPolicy(policy({ defaultLevel: "off", byCountry: { DE: "full" } })).available).toBe(true);
  });

  it("falls back to the old flag for a node that predates the country policy, and for an unreadable policy", () => {
    expect(readCameraPolicy({ speedCameraNamespaceEnabled: true })).toMatchObject({ available: true, hasZones: false });
    expect(readCameraPolicy({ speedCameraNamespaceEnabled: false })).toMatchObject({ available: false });
    expect(readCameraPolicy({ speedCameraNamespaceEnabled: true, cameraPolicy: { defaultLevel: "everything" } }).available).toBe(true);
    expect(readCameraPolicy(undefined).available).toBe(false);
    expect(readCameraPolicy(null).available).toBe(false);
  });

  it("takes the notice version from the node, 1 when it has none", () => {
    expect(readCameraPolicy(policy({ notice: { version: 3 } })).noticeVersion).toBe(3);
    expect(readCameraPolicy(policy({ notice: undefined })).noticeVersion).toBe(1);
    expect(readCameraPolicy({ speedCameraNamespaceEnabled: true }).noticeVersion).toBe(1);
  });
});

describe("the first visit: camera categories exist but are off", () => {
  it("switches the general categories on and every camera category off", () => {
    const types = selectableTypes(true);
    const selection = initialSelection(types);
    for (const type of GENERAL_TYPES) expect(selection.has(type), type).toBe(true);
    for (const type of CAMERA_TYPES) expect(selection.has(type), type).toBe(false);
    expect(anyCameraEnabled(selection)).toBe(false);
    expect(defaultEnabled("mobileSpeedCamera")).toBe(false);
    expect(defaultEnabled("traffic")).toBe(true);
  });

  it("shows no camera on the first visit, whatever the node delivers", () => {
    const selection = initialSelection(selectableTypes(true));
    const reports = [
      { id: "1", type: "traffic" },
      { id: "2", type: "mobileSpeedCamera" },
      { id: "3", type: "fixedSpeedCamera" },
    ];
    expect(filterReports(reports, selection, true).map((r: { id: string }) => r.id)).toEqual(["1"]);
  });

  it("follows what the visitor chose: ticked cameras on, unticked general categories off, the rest by default", () => {
    const selection = initialSelection(selectableTypes(true), { mobileSpeedCamera: true, ice: false, redLightCamera: false });
    expect(selection.has("mobileSpeedCamera")).toBe(true);
    expect(selection.has("ice")).toBe(false);
    expect(selection.has("redLightCamera")).toBe(false);
    expect(selection.has("traffic")).toBe(true);
    expect(selection.has("fixedSpeedCamera")).toBe(false);
  });

  it("ignores a remembered camera choice when the node offers no camera category", () => {
    const selection = initialSelection(selectableTypes(false), { mobileSpeedCamera: true });
    expect(selection.has("mobileSpeedCamera")).toBe(false);
  });
});

describe("remembering the visitor's choices in the browser", () => {
  it("stores a choice and reads it back; types never touched stay absent", () => {
    const store = memoryStorage();
    expect(loadFilterPrefs(store)).toEqual({});
    saveFilterPref("mobileSpeedCamera", true, store);
    saveFilterPref("ice", false, store);
    saveFilterPref("mobileSpeedCamera", false, store);
    expect(loadFilterPrefs(store)).toEqual({ mobileSpeedCamera: false, ice: false });
  });

  it("starts from the defaults when storage is empty, holds rubbish, or does not exist or throws", () => {
    expect(loadFilterPrefs(memoryStorage({ "tn.filters.v1": "not json" }))).toEqual({});
    expect(loadFilterPrefs(memoryStorage({ "tn.filters.v1": "[1,2]" }))).toEqual({});
    expect(loadFilterPrefs(memoryStorage({ "tn.filters.v1": '{"ice":"yes","traffic":false}' }))).toEqual({ traffic: false });
    expect(loadFilterPrefs(null)).toEqual({});
    const blocked = () => {
      throw new Error("blocked");
    };
    const broken = { getItem: blocked, setItem: blocked } as unknown as Storage;
    expect(loadFilterPrefs(broken)).toEqual({});
    expect(() => saveFilterPref("ice", true, broken)).not.toThrow();
    expect(() => markNoticeSeen(1, broken)).not.toThrow();
    expect(noticeSeen(1, broken)).toBe(false);
  });

  it("remembers that the notice was shown - for its version and older ones only", () => {
    const store = memoryStorage();
    expect(noticeSeen(1, store)).toBe(false);
    markNoticeSeen(1, store);
    expect(noticeSeen(1, store)).toBe(true);
    expect(noticeSeen(2, store)).toBe(false); // a changed wording is shown again
    markNoticeSeen(2, store);
    expect(noticeSeen(2, store)).toBe(true);
  });

  it("stores nothing but those two keys, and never anything about a position or a report", () => {
    const store = memoryStorage();
    saveFilterPref("fixedSpeedCamera", true, store);
    markNoticeSeen(1, store);
    expect(Object.keys(store.dump()).sort()).toEqual(["tn.cameraNotice.v1", "tn.filters.v1"]);
  });
});

describe("camera areas (level zones)", () => {
  const ring = [
    [11.5, 48.1],
    [11.6, 48.1],
    [11.6, 48.2],
    [11.5, 48.2],
    [11.5, 48.1],
  ];
  const zone = { id: "z1", cell: "861f1d48fffffff", resolution: 6, boundary: { type: "Polygon", coordinates: [ring] }, cameraTypes: ["fixedSpeedCamera", "mobileSpeedCamera"], status: "active" };

  it("turns the zone's outline into an area for the map: [lat, lng], without the closing repeat", () => {
    expect(zoneLatLngs(zone)).toEqual([
      [48.1, 11.5],
      [48.1, 11.6],
      [48.2, 11.6],
      [48.2, 11.5],
    ]);
    expect(zoneLatLngs({ id: "x" })).toBeNull();
    expect(zoneLatLngs({ boundary: { coordinates: [[]] } })).toBeNull();
  });

  it("shows an area only while one of its camera kinds is switched on, and only the kinds that are", () => {
    expect(filterZones([zone], new Set(), true)).toEqual([]);
    expect(filterZones([zone], new Set(["traffic"]), true)).toEqual([]);
    expect(filterZones([zone], new Set(["mobileSpeedCamera"]), true)).toEqual([zone]);
    expect(zoneTypes(zone, new Set(["mobileSpeedCamera", "ice"]))).toEqual(["mobileSpeedCamera"]);
  });

  it("shows no area at all when the node offers no camera category", () => {
    expect(filterZones([zone], new Set(CAMERA_TYPES), false)).toEqual([]);
  });

  it("a zone carries nothing of a single camera: only its cell, its outline and the kinds in it", () => {
    expect(Object.keys(zone).sort()).toEqual(["boundary", "cameraTypes", "cell", "id", "resolution", "status"]);
  });
});

describe("the notice and its wording", () => {
  const keys = ["cameraNotice.title", "cameraNotice.body", "cameraNotice.region", "cameraNotice.close", "cameraNotice.link", "about.cameras.title", "about.cameras.body", "about.cameras.region"] as const;

  it("exists in both languages, and says what the operator asked it to say", () => {
    for (const key of keys) {
      expect(DICTIONARIES.de[key], `de ${key}`).toBeTruthy();
      expect(DICTIONARIES.en[key], `en ${key}`).toBeTruthy();
    }
    for (const text of [DICTIONARIES.de["cameraNotice.body"], DICTIONARIES.de["about.cameras.body"]]) {
      expect(text).toMatch(/mehreren Ländern verboten/);
      expect(text).toMatch(/Deutschland auch für Beifahrer/);
      expect(text).toMatch(/Schweiz.*Hinweise unzulässig/);
    }
    for (const text of [DICTIONARIES.en["cameraNotice.body"], DICTIONARIES.en["about.cameras.body"]]) {
      expect(text).toMatch(/prohibited in several countries/);
      expect(text).toMatch(/Germany also for passengers/);
      expect(text).toMatch(/Switzerland.*hints are unlawful/);
    }
  });

  it("informs and does not ask: the only action is to close, and no wording asks for agreement", () => {
    for (const dictionary of [DICTIONARIES.de, DICTIONARIES.en]) {
      expect(dictionary["cameraNotice.close"]).toMatch(/^(Schließen|Close)$/);
      for (const key of keys) expect(dictionary[key], key).not.toMatch(/zustimm|einverstanden|akzeptier|accept|agree|consent/i);
    }
  });

  it("the privacy text on the About page names what is remembered now", () => {
    expect(DICTIONARIES.de["about.privacy.noAccount"]).toMatch(/Spracheinstellung/);
    expect(DICTIONARIES.de["about.privacy.noAccount"]).toMatch(/Kategorien/);
    expect(DICTIONARIES.de["about.privacy.noAccount"]).toMatch(/Blitzer-Hinweis/);
    expect(DICTIONARIES.en["about.privacy.noAccount"]).toMatch(/language/);
    expect(DICTIONARIES.en["about.privacy.noAccount"]).toMatch(/categories/);
  });

  it("the report dialog tells honestly what happened to a report that is not shown as a pin", () => {
    for (const lang of [DICTIONARIES.de, DICTIONARIES.en]) {
      expect(lang["reportDialog.result.acceptedZone"]).toBeTruthy();
      expect(lang["reportDialog.result.acceptedHidden"]).toBeTruthy();
      expect(lang["reportDialog.result.filterOff"]).toContain("{type}");
      // nothing that would tell whether the camera was new or merged
      for (const key of ["reportDialog.result.acceptedZone", "reportDialog.result.acceptedHidden"] as const) expect(lang[key]).not.toMatch(/Bestätigung gezählt|counted as a confirmation|gleiche Meldung|identical/);
    }
    expect(describeSubmitFailure({ status: 500 })).toEqual({ kind: "error" });
  });
});
