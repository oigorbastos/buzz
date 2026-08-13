import { expect, test } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";

const PREVIEW_ORIGIN =
  process.env.LAB_PREVIEW_BASE_URL ?? "http://127.0.0.1:4173";
const PREVIEW_URL = `${PREVIEW_ORIGIN}/?resetDevState=1&preview=lab-v2#/lab`;
const COMMUNITY_BOARD_ID = "11111111-1111-4111-8111-111111111111";
const PRIVATE_BOARD_ID = "22222222-2222-4222-8222-222222222222";
const READONLY_BOARD_ID = "44444444-4444-4444-8444-444444444444";

test("Lab v2 preview enforces all access scopes, tags, and board ID copy", async ({
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
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: PREVIEW_ORIGIN,
  });
  await page.goto(PREVIEW_URL);

  await expect(page.getByTestId("lab-preview-safety-banner")).toContainText(
    "Safe staging · fictional data",
  );
  await expect(page.getByText("Roadmap do Buzz · Alis")).toBeVisible();
  await expect(page.getByText("Prompts e runbooks do Igor")).toBeVisible();
  await expect(
    page.getByText("Guia publicado para a comunidade"),
  ).toBeVisible();
  await expect(
    page.getByText("Board privado alheio — não deve aparecer"),
  ).toHaveCount(0);
  await expect(page.getByText("SEGREDO-MOCK-NAO-VAZAR")).toHaveCount(0);
  await expect(page.getByText("3 boards")).toBeVisible();
  await expect(
    page.getByTestId("lab-tag-filter").locator('option[value="sigilo-alheio"]'),
  ).toHaveCount(0);
  await expect(page.getByTestId("lab-board-list")).toHaveAttribute(
    "data-view-mode",
    "grid",
  );
  await expect(page.getByTestId("lab-view-grid")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect
    .poll(() =>
      page
        .locator('[data-testid^="lab-board-card-"]')
        .evaluateAll((items) =>
          items.map((item) =>
            item.getAttribute("data-testid")?.replace("lab-board-card-", ""),
          ),
        ),
    )
    .toEqual([COMMUNITY_BOARD_ID, READONLY_BOARD_ID, PRIVATE_BOARD_ID]);

  await page.getByTestId("lab-view-list").click();
  await expect(page.getByTestId("lab-board-list")).toHaveAttribute(
    "data-view-mode",
    "list",
  );
  await expect(page.getByTestId("lab-view-list")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.reload();
  await expect(page.getByTestId("lab-board-list")).toHaveAttribute(
    "data-view-mode",
    "list",
  );
  await expect(page.getByTestId("lab-view-list")).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await page.getByTestId(`lab-board-copy-id-${COMMUNITY_BOARD_ID}`).click();
  await expect(page).toHaveURL(/#\/lab$/);
  await expect(page.getByText("Board ID copied")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(COMMUNITY_BOARD_ID);
  await waitForAnimations(page);
  await page.screenshot({
    clip: { x: 0, y: 0, width: 1280, height: 720 },
    path: testInfo.outputPath("lab-v2-board-list.png"),
  });

  await page.getByTestId("lab-filter-private").click();
  await expect(page.getByText("Prompts e runbooks do Igor")).toBeVisible();
  await expect(page.getByText("1 board")).toBeVisible();
  await expect(page.getByText("Roadmap do Buzz · Alis")).toHaveCount(0);

  await page.getByTestId("lab-filter-community_readonly").click();
  await expect(
    page.getByText("Guia publicado para a comunidade"),
  ).toBeVisible();
  await expect(page.getByText("1 board")).toBeVisible();
  await expect(page.getByText("Prompts e runbooks do Igor")).toHaveCount(0);
  await page.getByTestId(`lab-board-card-${READONLY_BOARD_ID}`).click();

  await expect(
    page.getByRole("heading", { name: "Guia publicado para a comunidade" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Everyone in this community can find and read. Only the owner and their agents can edit.",
    ),
  ).toBeVisible();
  await expect(page.getByTestId("lab-board-content")).toContainText(
    "Todos podem encontrar e ler",
  );
  await expect(page.getByTestId("lab-board-edit")).toHaveCount(0);
  await page.getByTestId("lab-board-history-toggle").click();
  await expect(page.getByTestId("lab-board-history")).toBeVisible();
  await expect(page.getByTestId("lab-restore-1")).toHaveCount(0);

  await page.getByTestId(`lab-board-copy-id-${READONLY_BOARD_ID}`).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(READONLY_BOARD_ID);
  await page.getByTestId("lab-board-copy-reference").click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(`buzz://lab?board=${READONLY_BOARD_ID}`);

  await waitForAnimations(page);
  await page.screenshot({
    clip: { x: 0, y: 0, width: 1280, height: 720 },
    path: testInfo.outputPath("lab-v2-read-only-board.png"),
  });

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
  await expect(page.locator('[data-testid^="lab-board-copy-id-"]')).toHaveCount(
    0,
  );
  await expect(page.getByTestId("lab-board-copy-reference")).toHaveCount(0);

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

  await page.getByTestId("lab-board-back").click();
  await page.getByTestId("lab-create-board").click();
  await page
    .getByTestId("create-lab-board-title")
    .fill("Referência pública de leitura");
  await page
    .getByTestId("create-lab-board-dialog")
    .getByRole("button", { name: /Read-only/ })
    .click();
  await page
    .getByTestId("create-lab-board-content")
    .fill("# Referência\n\nTodos podem consultar.");
  await page.getByTestId("create-lab-board-submit").click();

  await expect(
    page.getByRole("heading", { name: "Referência pública de leitura" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Everyone in this community can find and read. Only you and your agents can edit.",
    ),
  ).toBeVisible();
  await expect(page.getByTestId("lab-board-edit")).toBeVisible();

  await waitForAnimations(page);
  await page.screenshot({
    clip: { x: 0, y: 0, width: 1280, height: 720 },
    path: testInfo.outputPath("lab-v2-preview.png"),
  });
  expect(externalRequests).toEqual([]);
  expect(browserErrors).toEqual([]);
});
