import { expect, test, type Page } from "@playwright/test";
import { openMap, watchTraffic } from "./helpers.js";
import { instanceUrl } from "./instances.js";

const node = instanceUrl("main");

/** Hides the hazard markers other tests left in the middle of the map, so a click reaches the map itself. */
async function clearMarkers(page: Page): Promise<void> {
  await page.locator("#filters input[type=checkbox]").evaluateAll((boxes) =>
    boxes.forEach((box) => {
      (box as HTMLInputElement).checked = false;
      box.dispatchEvent(new Event("change", { bubbles: true }));
    }),
  );
}

test.describe("own duration of a report", () => {
  // (Uses "Panne": no other test reports that category at the map centre, where a merge would change the wording of the answers.)
  test("the dialog offers the category's standard, an own duration inside the node's bounds, and says when the report ends", async ({ page }) => {
    await watchTraffic(page, node);
    await openMap(page, node);
    await page.locator("#report-open").click();
    const dialog = page.locator("#report-dialog");
    // No category chosen yet: nothing to choose a duration for.
    await expect(dialog.getByRole("group", { name: "Wie lange soll die Meldung gelten?" })).toHaveCount(0);

    await dialog.getByRole("radio", { name: "Panne", exact: true }).check();
    const duration = dialog.getByRole("group", { name: "Wie lange soll die Meldung gelten?" });
    await expect(duration.getByRole("radio", { name: "Standard (25 Minuten)" })).toBeChecked();
    await duration.getByRole("radio", { name: "Eigene Dauer" }).check();
    await expect(duration).toContainText("Erlaubt sind 10 Minuten bis 6 Stunden.");

    // Quick choices are only those the category allows.
    const quick = duration.getByRole("group", { name: "Schnellwahl" });
    await expect(quick.getByRole("button", { name: "10 Minuten" })).toBeVisible();
    await expect(quick.getByRole("button", { name: "12 Stunden" })).toHaveCount(0);
    await quick.getByRole("button", { name: "2 Stunden" }).click();
    await expect(duration.getByRole("textbox", { name: "Dauer" })).toHaveValue("2");

    const posted = page.waitForRequest((request) => request.method() === "POST" && request.url().endsWith("/v1/hazard-reports"));
    await dialog.getByRole("button", { name: "Melden", exact: true }).click();
    expect((await posted).postDataJSON().expiresInSeconds).toBe(7200);
    // The answer names the end the node set (a report merged into an existing one keeps the later end).
    await expect(dialog.locator(".result.ok")).toContainText(/Sie gilt bis .*\d{2}:\d{2}/);
  });

  test("a typed duration outside the bounds is refused with the bounds, before anything is sent", async ({ page }) => {
    await watchTraffic(page, node);
    await openMap(page, node);
    let posts = 0;
    await page.route("**/v1/hazard-reports", (route) => {
      if (route.request().method() === "POST") posts += 1;
      return route.continue();
    });
    await page.locator("#report-open").click();
    const dialog = page.locator("#report-dialog");
    await dialog.getByRole("radio", { name: "Panne", exact: true }).check();
    await dialog.getByRole("radio", { name: "Eigene Dauer" }).check();
    await dialog.getByRole("textbox", { name: "Dauer" }).fill("7");
    await dialog.getByLabel("Einheit").selectOption("hours");
    await dialog.getByRole("button", { name: "Melden", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("Die Dauer ist zu lang. Erlaubt sind 10 Minuten bis 6 Stunden.");
    await expect(dialog.getByRole("textbox", { name: "Dauer" })).toBeFocused();
    expect(posts).toBe(0);

    await dialog.getByRole("textbox", { name: "Dauer" }).fill("");
    await dialog.getByRole("button", { name: "Melden", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("Bitte eine Dauer eingeben.");
    await dialog.getByRole("textbox", { name: "Dauer" }).fill("3 Std");
    await dialog.getByRole("button", { name: "Melden", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("ganze Zahl");
    expect(posts).toBe(0);
  });

  test("when the node refuses a duration the visitor is told the bounds it named — nothing is cut short silently", async ({ page }) => {
    await watchTraffic(page, node);
    await openMap(page, node);
    await page.route("**/v1/hazard-reports", (route) => {
      if (route.request().method() !== "POST") return route.continue();
      return route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "EXPIRY_OUT_OF_RANGE", message: "out of range", details: { defaultSeconds: 1500, minSeconds: 900, maxSeconds: 3600 } } }),
      });
    });
    await page.locator("#report-open").click();
    const dialog = page.locator("#report-dialog");
    await dialog.getByRole("radio", { name: "Panne", exact: true }).check();
    await dialog.getByRole("radio", { name: "Eigene Dauer" }).check();
    await dialog.getByRole("button", { name: "30 Minuten" }).click();
    await dialog.getByRole("button", { name: "Melden", exact: true }).click();
    await expect(dialog.locator(".result.bad")).toContainText("Erlaubt sind 15 Minuten bis 1 Stunde.");
  });
});

test.describe("speed limit: correct it, or add one where none is recorded", () => {
  test("a recorded road shows its value with the origin, and 'Stimmt nicht?' sends a proposal and says honestly what became of it", async ({ page }) => {
    await watchTraffic(page, node);
    await openMap(page, node);
    await clearMarkers(page);
    await page.locator("#map").click(); // the middle of the map is the seeded 50 km/h street
    const popup = page.locator(".leaflet-popup-content");
    await expect(popup).toContainText("Tempolimit hier: 50 km/h");
    await expect(popup).toContainText("Herkunft: aus den Kartendaten dieses Knotens (importiert).");
    await expect(popup).toContainText("Deine Angabe wird auf diesem Knoten gezählt");

    await popup.getByRole("button", { name: "Stimmt nicht?" }).click();
    await expect(popup.getByRole("heading", { name: "Tempolimit korrigieren" })).toBeVisible();
    await expect(popup).toContainText("Aktuell erfasst: 50 km/h");
    await expect(popup).toContainText("Bitte nur eintragen, was die Beschilderung vor Ort zeigt.");
    // The value in force is not offered again; a wrong value is explained, in words.
    await expect(popup.getByRole("button", { name: "50", exact: true })).toHaveCount(0);
    await popup.getByLabel(/Anderer Wert/).fill("55x");
    await popup.getByRole("button", { name: "Senden" }).click();
    await expect(popup.getByRole("alert")).toContainText("Bitte nur Ziffern eingeben.");
    await popup.getByLabel(/Anderer Wert/).fill("50");
    await popup.getByRole("button", { name: "Senden" }).click();
    await expect(popup.getByRole("alert")).toContainText("Das ist der Wert, der schon gilt.");

    await popup.getByRole("button", { name: "30", exact: true }).click();
    const posted = page.waitForRequest((request) => request.method() === "POST" && /\/v1\/speed-limit-segments\/[^/]+\/corrections$/.test(request.url()));
    await popup.getByRole("button", { name: "Senden" }).click();
    expect((await posted).postDataJSON()).toMatchObject({ value: 30, unit: "kmh", reason: "wrong_value" });
    await expect(popup.getByRole("heading", { name: "Danke!" })).toBeVisible();
    await expect(popup.locator(".result.ok")).toContainText(/Dein Vorschlag 30 km\/h ist eingegangen|zusammengeführt/);
    await expect(popup.locator(".result.ok")).toContainText("von 3 Bestätigungen");
    // One proposal does not change the value anybody sees.
    await popup.getByRole("button", { name: "Zurück" }).click();
    await expect(popup).toContainText("Tempolimit hier: 50 km/h");
    await expect(popup).toContainText("Offene Vorschläge");
  });

  test("where no limit is recorded: two points on the map name the stretch, it is drawn grey, and the proposal is sent for it", async ({ page }) => {
    await watchTraffic(page, node);
    await openMap(page, node);
    await clearMarkers(page);
    // The node answers "nothing recorded" for this spot.
    await page.route("**/v1/speed-limit?**", (route) => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_FOUND", message: "none" } }) }));
    let resolved: Record<string, unknown> | null = null;
    await page.route("**/v1/roads/resolve", (route) => {
      resolved = route.request().postDataJSON() as Record<string, unknown>;
      const from = (resolved.from as { lat: number; lng: number });
      const to = (resolved.to as { lat: number; lng: number });
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ref: "ivl:1,2:3,4",
          segmentKey: "k".repeat(32),
          // the road's own shape: not the straight line between the two taps
          geometry: { type: "LineString", coordinates: [[from.lng, from.lat], [(from.lng + to.lng) / 2, (from.lat + to.lat) / 2 + 0.0002], [to.lng, to.lat]] },
          lengthM: 420,
          road: { name: "Teststraße", ref: null, class: "residential" },
          covered: [],
          proposals: [],
        }),
      });
    });
    let body: Record<string, unknown> | null = null;
    await page.route("**/v1/speed-limit-intervals", (route) => {
      body = route.request().postDataJSON() as Record<string, unknown>;
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ correction: { id: "ivl-1", status: "proposed", value: 30, unit: "kmh", confirmations: 1, denials: 0 }, recorded: true, merged: false, segment: null }),
      });
    });
    await page.locator("#map").click();
    const popup = page.locator(".leaflet-popup-content");
    await expect(popup).toContainText("Kein Tempolimit erfasst");
    await popup.getByRole("button", { name: "Tempolimit nachreichen" }).click();
    await expect(popup.getByRole("heading", { name: "Tempolimit für ein Stück Straße" })).toBeVisible();
    // No question about the direction of the road any more: the start is the tapped spot, the end is picked on the map.
    await expect(popup).not.toContainText("In welcher Richtung verläuft die Straße?");
    await expect(popup).toContainText("Anfang: gesetzt");
    await expect(popup).toContainText("Ende: noch nicht gewählt");

    // Sending before the stretch is known is refused, before anything is sent.
    await popup.getByRole("button", { name: "30", exact: true }).click();
    await popup.getByRole("button", { name: "Senden" }).click();
    await expect(popup.getByRole("alert")).toContainText("Bitte erst Anfang und Ende des Stücks wählen.");
    await expect(page.locator("path.interval-preview")).toHaveCount(0);

    await popup.getByRole("button", { name: "Ende auf der Karte wählen" }).click();
    // The form is put away while the point is picked (it would cover the map) and comes back with the answer.
    await expect(page.locator("#pick-chip")).toContainText("Tippe auf der Karte das Ende des Stücks an.");
    await expect(popup).toBeHidden();
    const box = (await page.locator("#map").boundingBox())!;
    await page.mouse.click(box.x + box.width / 2 + 160, box.y + box.height / 2 + 70);
    await expect(popup).toContainText("Gefunden: Teststraße, etwa 420 m.");
    await expect(page.locator("path.interval-preview")).toHaveCount(1);
    expect(resolved).toMatchObject({ from: { lat: expect.any(Number), lng: expect.any(Number) }, to: { lat: expect.any(Number), lng: expect.any(Number) } });

    await popup.getByRole("button", { name: "30", exact: true }).click();
    await popup.getByRole("button", { name: "Senden" }).click();
    await expect(popup.locator(".result.ok")).toContainText("Dein Vorschlag 30 km/h ist eingegangen (1 von 3 Bestätigungen).");
    expect(body).toMatchObject({ value: 30, unit: "kmh", reason: "missing", from: { lat: expect.any(Number) }, to: { lng: expect.any(Number) } });
    await expect(page.locator("path.interval-preview")).toHaveCount(0);
  });

  test("two points that are not on one road: the page says so and sends nothing", async ({ page }) => {
    await watchTraffic(page, node);
    await openMap(page, node);
    await clearMarkers(page);
    await page.route("**/v1/speed-limit?**", (route) => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_FOUND", message: "none" } }) }));
    await page.route("**/v1/roads/resolve", (route) =>
      route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ error: { code: "NO_ROAD_BETWEEN_POINTS", message: "no road between" } }) }),
    );
    let posts = 0;
    await page.route("**/v1/speed-limit-intervals", (route) => {
      posts += 1;
      return route.continue();
    });
    await page.locator("#map").click();
    const popup = page.locator(".leaflet-popup-content");
    await popup.getByRole("button", { name: "Tempolimit nachreichen" }).click();
    await popup.getByRole("button", { name: "Ende auf der Karte wählen" }).click();
    // The form is put away while the point is picked (it would cover the map) and comes back with the answer.
    await expect(page.locator("#pick-chip")).toContainText("Tippe auf der Karte das Ende des Stücks an.");
    await expect(popup).toBeHidden();
    const box = (await page.locator("#map").boundingBox())!;
    await page.mouse.click(box.x + box.width / 2 + 160, box.y + box.height / 2 + 70);
    await expect(popup.getByRole("alert")).toContainText("Die beiden Stellen liegen nicht auf einer gemeinsamen Straße.");
    await popup.getByRole("button", { name: "30", exact: true }).click();
    await popup.getByRole("button", { name: "Senden" }).click();
    await expect(popup.getByRole("alert").last()).toContainText("Bitte erst Anfang und Ende des Stücks wählen.");
    expect(posts).toBe(0);
  });

  test("a wrong entry can be marked: the page lists what is near, shows it, and tells how many have reported it", async ({ page }) => {
    await watchTraffic(page, node);
    await openMap(page, node);
    await clearMarkers(page);
    await page.route("**/v1/data-defects/near**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [
            {
              targetType: "speedLimitSegment",
              targetId: "00000000-0000-4000-8000-000000000001",
              distanceMeters: 7,
              speedLimit: 51,
              speedLimitUnit: "kmh",
              source: "seed",
              geometry: { type: "LineString", coordinates: [[8.0, 50.0], [8.001, 50.0005]] },
              reports: 1,
              threshold: 3,
            },
          ],
        }),
      }),
    );
    let reported: Record<string, unknown> | null = null;
    await page.route("**/v1/data-defects", (route) => {
      reported = route.request().postDataJSON() as Record<string, unknown>;
      return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ recorded: true, reports: 2, threshold: 3, removed: false }) });
    });
    await page.locator("#map").click();
    const popup = page.locator(".leaflet-popup-content");
    await popup.getByRole("button", { name: "Fehlerhaften Eintrag melden" }).click();
    await expect(popup.getByRole("heading", { name: "Fehlerhaften Eintrag melden" })).toBeVisible();
    await expect(popup).toContainText("Tempolimit 51 km/h, 7 m entfernt");
    await expect(popup).toContainText("(1 von 3 gemeldet)");
    await popup.getByRole("button", { name: "Auf der Karte zeigen" }).click();
    await expect(page.locator("path.defect-preview")).toHaveCount(1);
    await popup.getByRole("button", { name: "Fehlerhaft melden" }).click();
    await expect(popup).toContainText("Danke. 2 von 3 gemeldet.");
    expect(reported).toMatchObject({ targetType: "speedLimitSegment", targetId: "00000000-0000-4000-8000-000000000001", reason: "not_on_a_road" });
  });
});
