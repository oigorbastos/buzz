import { expect, test } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";

const PREVIEW_ORIGIN =
  process.env.LAB_PREVIEW_BASE_URL ?? "http://127.0.0.1:4173";
const PREVIEW_URL = `${PREVIEW_ORIGIN}/?resetDevState=1&preview=lab-v2#/lab`;

test("Lab v2 preview supports personal editing, tags, and filters", async ({
  page,
}, testInfo) => {
  const externalRequests: string[] = [];
  const browserErrors: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== PREVIEW_ORIGIN) {
      externalRequests.push(request.url());
    }
  });
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.goto(PREVIEW_URL);

  await expect(page.getByTestId("lab-preview-safety-banner")).toContainText(
    "Safe staging · fictional data",
  );
  await expect(page.getByText("Roadmap do Buzz · Alis")).toBeVisible();
  await expect(page.getByText("Prompts e runbooks do Igor")).toBeVisible();
  await expect(page.getByText("Pesquisa da comunidade")).toBeVisible();
  await expect(page.getByText("3 boards")).toBeVisible();
  await waitForAnimations(page);
  await page.screenshot({
    clip: { x: 0, y: 0, width: 1280, height: 720 },
    path: testInfo.outputPath("lab-v2-board-list.png"),
  });

  await page.getByTestId("lab-filter-mine").click();
  await expect(page.getByText("Prompts e runbooks do Igor")).toBeVisible();
  await expect(page.getByText("1 board")).toBeVisible();
  await expect(page.getByText("Roadmap do Buzz · Alis")).toHaveCount(0);

  await page.getByTestId("lab-filter-all").click();
  await page.getByTestId("lab-tag-filter").selectOption("pesquisa");
  await expect(page.getByText("Pesquisa da comunidade")).toBeVisible();
  await page
    .getByTestId("lab-board-card-33333333-3333-4333-8333-333333333333")
    .click();
  await expect(page.getByTestId("lab-board-content")).toContainText(
    "edição pessoal de outra pessoa",
  );
  await expect(page.getByTestId("lab-board-edit")).toHaveCount(0);
  await page.getByTestId("lab-board-history-toggle").click();
  const history = page.getByTestId("lab-board-history");
  await expect(history).toBeVisible();
  await expect(history.getByText(/^Revision 1/)).toBeVisible();
  await expect(page.locator('[data-testid^="lab-restore-"]')).toHaveCount(0);

  await page.getByTestId("lab-board-back").click();
  await page.getByTestId("lab-create-board").click();
  await page.getByTestId("create-lab-board-title").fill("Board ADV pessoal");
  await page.getByRole("button", { name: /Personal editing/ }).click();
  await page.getByTestId("lab-tag-input").fill("adv");
  await page.getByTestId("lab-tag-input").press("Enter");
  await page.getByTestId("lab-tag-input").fill("prompts");
  await page.getByTestId("lab-tag-input").press("Enter");
  await page
    .getByTestId("create-lab-board-content")
    .fill("# Board pessoal\n\n- Igor\n  - Cloclo");
  await page.getByTestId("create-lab-board-submit").click();

  await expect(
    page.getByRole("heading", { name: "Board ADV pessoal" }),
  ).toBeVisible();
  await expect(
    page.getByText("Only you and your agents can edit"),
  ).toBeVisible();
  await expect(page.getByText("#adv")).toBeVisible();
  await expect(page.getByText("#prompts")).toBeVisible();
  await expect(page.getByTestId("lab-board-edit")).toBeVisible();

  await waitForAnimations(page);
  await page.screenshot({
    clip: { x: 0, y: 0, width: 1280, height: 720 },
    path: testInfo.outputPath("lab-v2-preview.png"),
  });
  expect(externalRequests).toEqual([]);
  expect(browserErrors).toEqual([]);
});
