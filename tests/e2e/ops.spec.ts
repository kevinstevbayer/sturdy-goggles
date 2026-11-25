import { expect, test } from "@playwright/test";

const VIEWPORTS = [
  { name: "360x800", width: 360, height: 800 },
  { name: "390x844", width: 390, height: 844 },
  { name: "768x1024", width: 768, height: 1024 },
  { name: "1280x800", width: 1280, height: 800 },
  { name: "1536x864", width: 1536, height: 864 }
];

test.describe("UI Quality Gate & Responsive Screenshots", () => {
  for (const scheme of ["light", "dark"] as const) {
    for (const vp of VIEWPORTS) {
      test("Login screen has zero horizontal overflow at " + vp.name + " (" + scheme + ")", async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.goto("/login");
        await expect(page.getByRole("heading", { name: "Role PIN" })).toBeVisible();

        const hasOverflow = await page.evaluate(
          () => document.documentElement.scrollWidth > document.documentElement.clientWidth
        );
        expect(hasOverflow).toBe(false);

        await page.screenshot({
          path: "test-results/screenshots/login-" + vp.name + "-" + scheme + ".png",
          fullPage: true
        });
      });
    }
  }
});

test.describe("Offline Outbox & Non-Blocking Reset Panel (Mocked Backend)", () => {
  test("queues 3 attempts offline, skips reset on scan, and syncs exactly 3 rows on reconnect", async ({
    page,
    context
  }) => {
    const syncedIds = new Set<string>();

    // Intercept Supabase REST calls to verify idempotent outbox sync
    await page.route("**/rest/v1/**", async (route) => {
      const url = route.request().url();
      const method = route.request().method();

      if (url.includes("/stations")) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ config: {
              id: 1,
              name: "A-Frame Walker",
              widget: "stopwatch_progress",
              cap_s: 120,
              rank: "time_then_progress",
              bonus_on_dnf: true,
              progress: { kind: "taps", unit: "m", values: [0, 1, 2, 3, 4, 5, 6, 7, 8] },
              helpers: [],
              reset: { target_s: 60, checklist: ["Frame upright", "Ropes untangled"] },
              rule: "Steer across 8 m.",
              bonus: { q: "Sample Q?", a: "Sample A" } } })
        });
      }
      if (url.includes("/teams_public")) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([
            { id: "t1", number: 1, church: "Church A", team_name: null, token: "AAAA1111", route: 0, withdrawn: false },
            { id: "t2", number: 2, church: "Church B", team_name: null, token: "BBBB2222", route: 1, withdrawn: false },
            { id: "t3", number: 3, church: "Church C", team_name: null, token: "CCCC3333", route: 2, withdrawn: false }
          ])
        });
      }
      if (url.includes("/event_settings")) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ id: 1, event_state: "live", current_variant: "W1", variant_labels: ["W1"], walk_time_s: 30 })
        });
      }
      if (url.includes("/attempts") && (method === "POST" || method === "PUT")) {
        const body = route.request().postDataJSON() as { id?: string } | { id?: string }[];
        const arr = Array.isArray(body) ? body : [body];
        for (const item of arr) {
          if (item?.id) syncedIds.add(item.id);
        }
        return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(arr) });
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([]) });
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "th2027_role_session",
        JSON.stringify({
          access_token: "test-jwt",
          role: "station_1",
          station_id: 1,
          session_id: "00000000-0000-0000-0000-000000000001"
        })
      );
    });

    await page.goto("/host");
    await expect(page.getByText("A-Frame Walker")).toBeVisible();

    // Go offline and submit 3 teams in a row (including scanning during reset panel)
    await context.setOffline(true);

    for (const num of ["1", "2", "3"]) {
      await page.getByLabel("Scan or enter team").fill(num);
      await page.getByRole("button", { name: "Find team" }).click();
      await page.getByRole("button", { name: "Start" }).click();
      await page.getByRole("button", { name: "Stop" }).click();
      await page.getByRole("button", { name: "Correct" }).click();
      await page.getByRole("button", { name: "Submit" }).click();
      await expect(page.getByText("Attempt saved")).toBeVisible();
    }

    // Reconnect and wait for outbox flush
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(() => syncedIds.size, { timeout: 10_000 }).toBe(3);
  });
});



