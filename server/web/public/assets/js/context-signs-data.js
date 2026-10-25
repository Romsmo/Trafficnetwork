// The signs of the context-sign catalogue (docs/context-signs.md D1): the 58 signs of the display, in the node's catalogue order.
// [number, kind, German name, English name]. `kind`: "hazard" (warning signs) or "prohibition" (commands and prohibitions).
// Must agree with server/src/modules/context-signs/catalog.ts (tests/unit/context-signs-web.test.ts checks it).
const SIGNS = [
  ["101", "hazard", "Gefahrstelle", "Danger"],
  ["101-10", "hazard", "Flugbetrieb", "Low-flying aircraft"],
  ["101-11", "hazard", "Fußgängerüberweg", "Pedestrian crossing"],
  ["101-12", "hazard", "Viehtrieb", "Cattle crossing"],
  ["101-13", "hazard", "Reiter", "Horse riders"],
  ["101-14", "hazard", "Amphibienwanderung", "Amphibian migration"],
  ["101-15", "hazard", "Steinschlag", "Falling rocks"],
  ["101-51", "hazard", "Schnee- oder Eisglätte", "Snow or ice"],
  ["101-52", "hazard", "Splitt, Schotter", "Loose chippings"],
  ["101-53", "hazard", "Ufer", "Quayside or riverbank"],
  ["101-54", "hazard", "Unzureichendes Lichtraumprofil", "Insufficient clearance"],
  ["101-55", "hazard", "Bewegliche Brücke", "Movable bridge"],
  ["102", "hazard", "Kreuzung oder Einmündung, Vorfahrt von rechts", "Junction, priority from the right"],
  ["103-10", "hazard", "Kurve (links)", "Bend (left)"],
  ["105-10", "hazard", "Doppelkurve (zunächst links)", "Double bend (first left)"],
  ["108-4", "hazard", "Gefälle", "Steep descent"],
  ["110-4", "hazard", "Steigung", "Steep ascent"],
  ["112", "hazard", "Unebene Fahrbahn", "Uneven road"],
  ["114", "hazard", "Schleuder- oder Rutschgefahr", "Slippery road"],
  ["117-10", "hazard", "Seitenwind von rechts", "Crosswind from the right"],
  ["120", "hazard", "Verengte Fahrbahn", "Road narrows"],
  ["121-10", "hazard", "Einseitig (rechts) verengte Fahrbahn", "Road narrows on the right"],
  ["123", "hazard", "Arbeitsstelle", "Roadworks"],
  ["124", "hazard", "Stau", "Traffic jam"],
  ["125", "hazard", "Gegenverkehr", "Two-way traffic"],
  ["131", "hazard", "Lichtzeichenanlage", "Traffic lights"],
  ["133-10", "hazard", "Fußgänger", "Pedestrians"],
  ["136-10", "hazard", "Kinder", "Children"],
  ["138-10", "hazard", "Radverkehr", "Cyclists"],
  ["142-10", "hazard", "Wildwechsel", "Wild animals"],
  ["151", "hazard", "Bahnübergang", "Level crossing"],
  ["250", "prohibition", "Verbot für Fahrzeuge aller Art", "No vehicles"],
  ["251", "prohibition", "Verbot für Kraftwagen und sonstige mehrspurige Kraftfahrzeuge", "No motor vehicles"],
  ["253", "prohibition", "Verbot für Kraftfahrzeuge über zulässiges Gesamtgewicht", "No motor vehicles over a gross weight"],
  ["254", "prohibition", "Verbot für Radfahrer", "No cyclists"],
  ["255", "prohibition", "Verbot für Krafträder, Kleinkrafträder und Mofas", "No motorcycles, mopeds"],
  ["257-50", "prohibition", "Verbot für Mofas", "No mopeds"],
  ["259", "prohibition", "Verbot für Fußgänger", "No pedestrians"],
  ["260", "prohibition", "Verbot für Krafträder, Mofas und mehrspurige Kraftfahrzeuge", "No motor vehicles of any kind"],
  ["261", "prohibition", "Verbot für Fahrzeuge mit gefährlichen Gütern", "No vehicles carrying dangerous goods"],
  ["262-5", "prohibition", "Verbot für Fahrzeuge über angegebene Masse", "No vehicles over a mass"],
  ["263-8", "prohibition", "Verbot für Fahrzeuge über angegebene Achslast", "No vehicles over an axle load"],
  ["264-2", "prohibition", "Verbot für Fahrzeuge über angegebene Breite", "No vehicles over a width"],
  ["265-3", "prohibition", "Verbot für Fahrzeuge über angegebene Höhe", "No vehicles over a height"],
  ["266-10", "prohibition", "Verbot für Fahrzeuge über angegebene Länge", "No vehicles over a length"],
  ["267", "prohibition", "Verbot der Einfahrt", "No entry"],
  ["268", "prohibition", "Schneeketten vorgeschrieben", "Snow chains required"],
  ["269", "prohibition", "Verbot für Fahrzeuge mit wassergefährdender Ladung", "No vehicles with water-polluting load"],
  ["270", "prohibition", "Umweltzone (Verkehrsverbot zur Luftreinhaltung)", "Low-emission zone"],
  ["272", "prohibition", "Verbot des Wendens", "No U-turns"],
  ["273-70", "prohibition", "Mindestabstand", "Minimum distance"],
  ["276", "prohibition", "Überholverbot für Kraftfahrzeuge aller Art", "No overtaking"],
  ["277", "prohibition", "Überholverbot für Kraftfahrzeuge über 2,8 t", "No overtaking for vehicles over 2.8 t"],
  ["280", "prohibition", "Ende des Überholverbots für Kraftfahrzeuge aller Art", "End of no overtaking"],
  ["281", "prohibition", "Ende des Überholverbots für Kraftfahrzeuge über 3,5 t", "End of no overtaking for vehicles over 3.5 t"],
  ["282", "prohibition", "Ende sämtlicher Streckenverbote", "End of all restrictions"],
  ["283", "prohibition", "Absolutes Haltverbot", "No stopping"],
  ["286", "prohibition", "Eingeschränktes Haltverbot", "No waiting"],
];

/** What a sign carries as a value (unit, range). Must agree with the server's catalogue. */
const VALUES = {
  "253": { unit: "t", required: false, min: 0.5, max: 100 },
  "262-5": { unit: "t", required: true, min: 0.5, max: 100 },
  "263-8": { unit: "t", required: true, min: 0.5, max: 100 },
  "264-2": { unit: "m", required: true, min: 0.5, max: 5 },
  "265-3": { unit: "m", required: true, min: 0.5, max: 10 },
  "266-10": { unit: "m", required: true, min: 0.5, max: 40 },
  "273-70": { unit: "m", required: true, min: 0.5, max: 200 },
};

/** Signs that stand at one place: picked with one point (and a direction of travel). */
const POINT_LIKE = new Set(["101-11", "101-55", "102", "131", "133-10", "151", "267", "280", "281", "282"]);

/** Signs that are only ever temporary: they need a period with an end (days at most). */
const TEMPORARY = { "123": 90, "124": 3 };

export const CATALOG = SIGNS.map(([vz, kind, de, en]) => ({
  code: `DE:${vz}`,
  vz,
  kind,
  de,
  en,
  value: VALUES[vz] ?? null,
  pointLike: POINT_LIKE.has(vz),
  maxPeriodDays: TEMPORARY[vz] ?? null,
}));

const BY_CODE = new Map(CATALOG.map((s) => [s.code, s]));

export function signByCode(code) {
  return BY_CODE.get(code) ?? null;
}

/** The name of a sign in the given language ("de" or "en"). A code the page does not know shows its code. */
export function signName(code, lang) {
  const sign = BY_CODE.get(code);
  return sign ? (lang === "de" ? sign.de : sign.en) : code;
}

// ---- the pictogram ----------------------------------------------------------------------------------------------
// The pictures are drawn here, in the page's own colours, and are not the official sign images: a simple shape of the sign's kind with
// its number (docs/web-compliance.md). A triangle for warnings, a circle for prohibitions, blue for the command (snow chains), grey for
// ends. No external file, no licence to carry.
const NS = "http://www.w3.org/2000/svg";
function el(name, attrs = {}, ...children) {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  for (const child of children) node.append(child);
  return node;
}

/** An inline SVG of the sign. `label` makes it an image with that name; without it the picture is decorative (the name is shown beside it). */
export function signPictogram(code, { size = 40, label = null } = {}) {
  const sign = BY_CODE.get(code);
  const vz = sign?.vz ?? code.replace(/^[A-Z]{2}:/, "");
  const svg = el("svg", { viewBox: "0 0 100 100", width: size, height: size, focusable: "false", class: "sign-pictogram" });
  if (label) {
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", label);
  } else {
    svg.setAttribute("aria-hidden", "true");
  }
  const text = (fill, y = 60, fontSize = vz.length > 4 ? 19 : vz.length > 3 ? 23 : 28) =>
    el("text", { x: 50, y, "text-anchor": "middle", "font-family": "system-ui, Arial, sans-serif", "font-weight": 700, "font-size": fontSize, fill }, document.createTextNode(vz));
  if (sign?.kind === "hazard") {
    svg.append(el("polygon", { points: "50,7 95,88 5,88", fill: "#ffffff", stroke: "#c62828", "stroke-width": 9, "stroke-linejoin": "round" }), text("#111111", 71));
  } else if (vz === "268") {
    svg.append(el("circle", { cx: 50, cy: 50, r: 45, fill: "#1565c0" }), text("#ffffff"));
  } else if (vz === "267") {
    svg.append(el("circle", { cx: 50, cy: 50, r: 45, fill: "#c62828" }), el("rect", { x: 22, y: 42, width: 56, height: 16, fill: "#ffffff" }));
  } else if (["280", "281", "282"].includes(vz)) {
    svg.append(el("circle", { cx: 50, cy: 50, r: 43, fill: "#ffffff", stroke: "#616161", "stroke-width": 7 }), el("path", { d: "M24 76 76 24", stroke: "#616161", "stroke-width": 8, "stroke-linecap": "round" }), text("#424242", 62));
  } else {
    svg.append(el("circle", { cx: 50, cy: 50, r: 43, fill: "#ffffff", stroke: "#c62828", "stroke-width": 11 }), text("#111111"));
  }
  return svg;
}

// ---- validity as text ------------------------------------------------------------------------------------------

function formatDate(date, lang) {
  const [y, m, d] = date.split("-");
  return lang === "de" ? `${d}.${m}.${y}` : `${y}-${m}-${d}`;
}

/** "Mo–Fr": consecutive weekdays are joined. `dayName(n)` gives the short name of ISO weekday n. */
export function formatDays(days, dayName) {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(j - i >= 2 ? `${dayName(sorted[i])}–${dayName(sorted[j])}` : sorted.slice(i, j + 1).map(dayName).join(", "));
    i = j + 1;
  }
  return parts.join(", ");
}

/**
 * The validity of an entry in words: "always", or the windows and the period. `t` is the page's translator (`signs.validity.*`).
 * Times are the local times of the place, which the text says.
 */
export function describeValidity(validity, t, lang) {
  const parts = [];
  for (const w of validity.windows ?? []) {
    parts.push(`${formatDays(w.days, (n) => t(`signs.day.${n}`))} ${w.from}–${w.to}`);
  }
  if (validity.period) {
    const { from, to } = validity.period;
    parts.push(to ? t("signs.validity.period", { from: formatDate(from, lang), to: formatDate(to, lang) }) : t("signs.validity.since", { from: formatDate(from, lang) }));
  }
  if (parts.length === 0) return t("signs.validity.always");
  return parts.join("; ") + (validity.windows?.length ? ` (${t("signs.validity.localTime")})` : "");
}
