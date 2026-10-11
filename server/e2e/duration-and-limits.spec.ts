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
  test("the dialog offers the category's standard, an own duration inside the node's bounds, and says when the report ends", async ({ page }) => {
    await watchTraffic(page, node);
    await openMap(page, node);
    await page.locator("#report-open").click();
    const dialog = page.locator("#report-dialog");
    // No category chosen yet: nothing to choose a duration for.
    await expect(dialog.getByRole("group", { name: "Wie lange soll die Meldung gelten?" })).toHaveCount(0);

    await dialog.getByRole("radio", { name: "Unfall", exact: true }).check();
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
    await dialog.getByRole("radio", { name: "Unfall", exact: true }).check();
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
    await dialog.getByRole("radio", { name: "Unfall", exact: true }).check();
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

  test("where no limit is recorded: 'Tempolimit nachreichen' needs a direction, previews the road and sends the proposal", async ({ page }) => {
    await watchTraffic(page, node);
    await openMap(page, node);
    await clearMarkers(page);
    // The node answers "nothing recorded" for this spot.
    await page.route("**/v1/speed-limit?**", (route) => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_FOUND", message: "none" } }) }));
    let body: Record<string, unknown> | null = null;
    await page.route("**/v1/speed-limit-gaps", (route) => {
      body = route.request().postDataJSON() as Record<string, unknown>;
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ correction: { id: "gap-1", status: "proposed", value: 30, unit: "kmh", confirmations: 1, denials: 0 }, recorded: true, merged: false }),
      });
    });
    await page.locator("#map").click();
    const popup = page.locator(".leaflet-popup-content");
    await expect(popup).toContainText("Kein Tempolimit erfasst");
    await popup.getByRole("button", { name: "Tempolimit nachreichen" }).click();
    await expect(popup.getByRole("heading", { name: "Tempolimit nachreichen" })).toBeVisible();

    await popup.getByRole("button", { name: "30", exact: true }).click();
    await popup.getByRole("button", { name: "Senden" }).click();
    await expect(popup.getByRole("alert")).toContainText("Bitte die Richtung der Straße wählen.");
    await expect(page.locator("path.axis-preview")).toHaveCount(0);

    await popup.getByRole("radio", { name: "Nord–Süd" }).check();
    await expect(page.locator("path.axis-preview")).toHaveCount(1);
    await popup.getByRole("button", { name: "Senden" }).click();
    await expect(popup.locator(".result.ok")).toContainText("Dein Vorschlag 30 km/h ist eingegangen (1 von 3 Bestätigungen).");
    expect(body).toMatchObject({ bearingDegrees: 0, value: 30, unit: "kmh", reason: "missing" });
    await expect(page.locator("path.axis-preview")).toHaveCount(0);
  });

  test("the node knows a road there after all: the page moves the visitor to correcting that one", async ({ page }) => {
    await watchTraffic(page, node);
    await openMap(page, node);
    await clearMarkers(page);
    await page.route("**/v1/speed-limit?**", (route) => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_FOUND", message: "none" } }) }));
    await page.locator("#map").click(); // the seeded 50 km/h street runs north-south right here, the node's gap check knows it
    const popup = page.locator(".leaflet-popup-content");
    await popup.getByRole("button", { name: "Tempolimit nachreichen" }).click();
    await popup.getByRole("radio", { name: "Nord–Süd" }).check();
    await popup.getByRole("button", { name: "30", exact: true }).click();
    await popup.getByRole("button", { name: "Senden" }).click();
    await expect(popup.getByRole("heading", { name: "Tempolimit korrigieren" })).toBeVisible();
    await expect(popup).toContainText("Hier ist schon ein Tempolimit erfasst");
  });
});
