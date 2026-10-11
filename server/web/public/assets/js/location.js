import { h } from "./dom.js";
import { compassPoint, nextHeading, nextLocateState } from "./geo.js";

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * The arrow that shows where the visitor is: a navigation arrow in the direction of travel inside a light circle of the position's
 * accuracy. The arrow is outlined in white and ringed in dark blue, so it reads on every colour of the map in light and dark mode.
 * Without a known direction (never moved yet, no heading from the device) it is a plain dot — an arrow pointing nowhere in
 * particular would lie.
 */
function arrowElement() {
  const wrap = h("span", { class: "me-arrow", role: "img" });
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 44 44");
  svg.setAttribute("width", "44");
  svg.setAttribute("height", "44");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const dot = document.createElementNS(SVG_NS, "circle");
  dot.setAttribute("class", "me-dot");
  dot.setAttribute("cx", "22");
  dot.setAttribute("cy", "22");
  dot.setAttribute("r", "9");
  const head = document.createElementNS(SVG_NS, "path");
  head.setAttribute("class", "me-head");
  // an arrow head pointing up (north); the wrapper is rotated to the heading
  head.setAttribute("d", "M22 4 L34 35 L22 28 L10 35 Z");
  svg.append(dot, head);
  wrap.append(svg);
  return { wrap, head, dot };
}

/**
 * "Centre on me": position, arrow and the three states off / centred / following (docs/web-ui.md). The browser's position is
 * requested only when the visitor presses the button, is used while the state is not "off", and is neither stored nor sent anywhere
 * by this module. `onState(state)` and `onProblem(kind)` let the page update the button and say what happened.
 */
export class LocateController {
  #state = "off";
  #watchId = null;
  #fix = null;
  #previous = null;
  #heading = null;
  #marker = null;
  #accuracy = null;
  #arrow = null;
  #first = true;

  constructor({ map, geolocation = globalThis.navigator?.geolocation, minZoom = 15, followZoom = 16, onState = () => {}, onProblem = () => {}, describe = () => "" }) {
    this.map = map;
    this.geolocation = geolocation;
    this.minZoom = minZoom;
    this.followZoom = followZoom;
    this.onState = onState;
    this.onProblem = onProblem;
    this.describe = describe;
    // The visitor moved the map themselves: stop following, keep the arrow.
    map.on("dragstart", () => this.#transition("drag"));
  }

  get state() {
    return this.#state;
  }

  get heading() {
    return this.#heading;
  }

  get position() {
    return this.#fix ? { lat: this.#fix.lat, lng: this.#fix.lng } : null;
  }

  /** The button was pressed (or its keyboard equivalent). */
  press() {
    if (!this.geolocation) {
      this.onProblem("unsupported");
      return;
    }
    this.#transition("press");
  }

  #transition(event) {
    const before = this.#state;
    const after = nextLocateState(before, event);
    if (after === before) return;
    this.#state = after;
    if (before === "off") this.#start();
    if (after === "off") this.#stop();
    if (before === "off" && this.#fix) this.#centre();
    if (before === "centered" && after === "following" && this.#fix) this.#centre(true);
    this.onState(after, before);
  }

  #start() {
    this.#first = true;
    this.onProblem("waiting");
    this.#watchId = this.geolocation.watchPosition(
      (pos) => this.#onFix(pos),
      (error) => this.#onError(error),
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 },
    );
  }

  #stop() {
    if (this.#watchId !== null) this.geolocation.clearWatch(this.#watchId);
    this.#watchId = null;
    this.#marker?.remove();
    this.#accuracy?.remove();
    this.#marker = null;
    this.#accuracy = null;
    this.#arrow = null;
    this.#fix = null;
    this.#previous = null;
    this.#heading = null;
  }

  #onError(error) {
    // A timeout while the signal is weak is not the end of it; a refusal or a missing sensor is.
    if (error?.code === 3 && this.#state !== "off") return;
    this.#transition("error");
    this.onProblem(error?.code === 1 ? "denied" : "unavailable");
  }

  #onFix(pos) {
    const c = pos.coords;
    const fix = { lat: c.latitude, lng: c.longitude, accuracy: c.accuracy, heading: c.heading, speed: c.speed };
    this.#previous = this.#fix;
    this.#fix = fix;
    this.#heading = nextHeading({ fix, previous: this.#previous, current: this.#heading });
    this.#draw();
    if (this.#first) {
      this.#first = false;
      this.#centre();
    } else if (this.#state === "following") {
      this.map.panTo([fix.lat, fix.lng], { animate: true, duration: 0.4 });
    }
  }

  #centre(follow = false) {
    if (!this.#fix) return;
    const zoom = Math.max(this.map.getZoom(), follow ? this.followZoom : this.minZoom);
    this.map.setView([this.#fix.lat, this.#fix.lng], zoom);
  }

  #draw() {
    const L = window.L;
    const fix = this.#fix;
    const latlng = [fix.lat, fix.lng];
    if (!this.#marker) {
      this.#arrow = arrowElement();
      const icon = L.divIcon({ className: "me-icon", html: this.#arrow.wrap, iconSize: [44, 44], iconAnchor: [22, 22] });
      // Not part of the tab order: it is a status display, described through the label below and the page's live region.
      this.#marker = L.marker(latlng, { icon, interactive: false, keyboard: false, zIndexOffset: 1000 }).addTo(this.map);
      this.#accuracy = L.circle(latlng, { radius: Math.max(fix.accuracy || 0, 5), className: "me-accuracy", interactive: false }).addTo(this.map);
    } else {
      this.#marker.setLatLng(latlng);
      this.#accuracy.setLatLng(latlng).setRadius(Math.max(fix.accuracy || 0, 5));
    }
    const { wrap } = this.#arrow;
    const known = this.#heading !== null;
    wrap.classList.toggle("no-heading", !known);
    wrap.dataset.heading = known ? String(Math.round(this.#heading)) : "";
    wrap.style.transform = known ? `rotate(${Math.round(this.#heading)}deg)` : "";
    wrap.setAttribute("aria-label", this.describe({ accuracy: Math.round(fix.accuracy || 0), heading: known ? Math.round(this.#heading) : null, compass: known ? compassPoint(this.#heading, document.documentElement.lang) : null }));
  }

  /** Re-labels the arrow after a language switch. */
  refreshLabel() {
    if (!this.#arrow || !this.#fix) return;
    const known = this.#heading !== null;
    this.#arrow.wrap.setAttribute("aria-label", this.describe({ accuracy: Math.round(this.#fix.accuracy || 0), heading: known ? Math.round(this.#heading) : null, compass: known ? compassPoint(this.#heading, document.documentElement.lang) : null }));
  }
}
