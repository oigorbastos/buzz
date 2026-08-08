import { expect, test } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";

const PREVIEW_ORIGIN =
  process.env.LAB_PREVIEW_BASE_URL ?? "http://127.0.0.1:4173";
const PREVIEW_URL = `${PREVIEW_ORIGIN}/?resetDevState=1&preview=lab-v2#/lab`;

test("Lab v2 preview keeps private boards private and supports tags", async ({
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
  await expect(
    page.getByText("Board privado alheio — não deve aparecer"),
  ).toHaveCount(0);
  await expect(page.getByText("SEGREDO-MOCK-NAO-VAZAR")).toHaveCount(0);
  await expect(page.getByText("2 boards")).toBeVisible();
  await expect(
    page.getByTestId("lab-tag-filter").locator('option[value="sigilo-alheio"]'),
  ).toHaveCount(0);
  await waitForAnimations(page);
  await page.screenshot({
    clip: { x: 0, y: 0, width: 1280, height: 720 },
    path: testInfo.outputPath("lab-v2-board-list.png"),
  });

  await page.getByTestId("lab-filter-private").click();
  await expect(page.getByText("Prompts e runbooks do Igor")).toBeVisible();
  await expect(page.getByText("1 board")).toBeVisible();
  await expect(page.getByText("Roadmap do Buzz · Alis")).toHaveCount(0);

  await page.goto(
    `${PREVIEW_ORIGIN}/?resetDevState=1&preview=lab-v2#/lab/boards/33333333-3333-4333-8333-333333333333`,
  );
  await expect(page.getByText("This board is not available.")).toBeVisible();
  await expect(
    page.getByText("Board privado alheio — não deve aparecer"),
  ).toHaveCount(0);
  await expect(page.getByText("SEGREDO-MOCK-NAO-VAZAR")).toHaveCount(0);
  await expect(page.getByTestId("lab-board-content")).toHaveCount(0);
  await expect(page.getByTestId("lab-board-edit")).toHaveCount(0);
  await expect(page.getByTestId("lab-board-history-toggle")).toHaveCount(0);

  await page.goto(PREVIEW_URL);
  await page.getByTestId("lab-create-board").click();
  await page.getByTestId("create-lab-board-title").fill("Board ADV privado");
  await page
    .getByTestId("create-lab-board-dialog")
    .getByRole("button", { name: /Private/ })
    .click();
  await page.getByTestId("lab-tag-input").fill("adv");
  await page.getByTestId("lab-tag-input").press("Enter");
  await page.getByTestId("lab-tag-input").fill("prompts");
  await page.getByTestId("lab-tag-input").press("Enter");
  await page
    .getByTestId("create-lab-board-content")
    .fill("# Board privado\n\n- Igor\n  - Cloclo");
  await page.getByTestId("create-lab-board-submit").click();

  await expect(
    page.getByRole("heading", { name: "Board ADV privado" }),
  ).toBeVisible();
  await expect(
    page.getByText("Only you and your agents can find, read, and edit"),
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
