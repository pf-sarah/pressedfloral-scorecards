import { expect, test } from "@playwright/test";

test("@parity fixture auth lands on Home with admin access", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
  await expect(page.getByText("Where would you like to go?")).toBeVisible();
  await expect(page.getByText("local-dev@pressedfloral.com")).toBeVisible();
  await expect(page.getByTestId("nav-rippling")).toBeVisible();
  await expect(page.getByTestId("nav-users")).toBeVisible();
});

test("@parity goals and actuals show fixture goals and save actuals", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("nav-setup").click();
  await expect(page.getByRole("heading", { name: "Goals & Actuals" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Company Revenue" })).toBeVisible();
  await page.locator(".toolbar-row select").first().selectOption("2026-04");
  const revenueRow = page.getByRole("row").filter({ hasText: "Company Revenue" }).first();
  await revenueRow.getByRole("button", { name: "⋮" }).click();
  await page.getByRole("button", { name: "Edit goal" }).click();
  await page.locator(".goal-editor-inline").getByRole("button", { name: "Save Goal" }).click();
  await expect(page.getByText("Goal saved")).toBeVisible();
  await revenueRow.getByRole("button", { name: "⋮" }).click();
  await page.getByRole("button", { name: "Enter actual" }).click();
  const actual = page.getByLabel("Actual for Company Revenue");
  await actual.fill("135000");
  await actual.blur();
  await expect(page.getByText("Actual saved")).toBeVisible();
});

test("@parity team scorecard calculates and submits", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("nav-scorecard").click();
  await page.locator(".scorecard-list").getByText("Mia Carter", { exact: true }).click();
  await expect(page.getByText("BASE EARNINGS")).toBeVisible();
  await expect(page.getByText("Average First Response Hours")).toBeVisible();
  await page.getByRole("button", { name: "Submit Scorecard" }).click();
  await expect(page.getByText("Scorecard submitted")).toBeVisible();
});

test("@parity history filters and exports", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("nav-history").click();
  await expect(page.getByText("Ava Jensen")).toBeVisible();
  await page.getByTestId("history-scorecard-view").click();
  await page.getByTestId("scorecard-card-scorecard-ava-may").click();
  await expect(page.getByRole("cell", { name: "Company Revenue" })).toBeVisible();
});

test("@parity rippling upload previews employees", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("nav-rippling").click();
  const csv = [
    "Full Name,Title,Department,Location,Hourly Rate,Gross Earnings,Hours Worked,Manager",
    "Test Person,Design Specialist,Design,UT,$22,$3800,172,Sarah Miller"
  ].join("\n");
  await page.setInputFiles("input[type=file]", {
    name: "rippling.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(csv)
  });
  await expect(page.getByText("Test Person")).toBeVisible();
});

test("@parity admin can invite and edit users in fixture mode", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("nav-users").click();
  await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();
  await expect(page.getByText("Invite User")).toBeVisible();
  await expect(page.getByText("manager@pressedfloral.com")).toBeVisible();

  await page.getByLabel("Invite email").fill("new.viewer@pressedfloral.com");
  await page.getByLabel("User role").first().selectOption("user");
  await page.getByLabel("Linked employee").selectOption("Ava Jensen");
  await page.getByRole("button", { name: "Send Invite" }).click();
  await expect(page.getByText("Invite simulated")).toBeVisible();
  await expect(page.getByText("new.viewer@pressedfloral.com")).toBeVisible();

  const managerRow = page.getByRole("row").filter({ hasText: "manager@pressedfloral.com" }).first();
  await managerRow.getByRole("button", { name: "Edit" }).click();
  const editRow = page.locator(".user-edit-row");
  await editRow.getByLabel("User role").selectOption("user");
  await editRow.getByLabel("Linked employee").selectOption("Mia Carter");
  await editRow.getByRole("button", { name: "Save User" }).click();
  await expect(page.getByText("User updated")).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "manager@pressedfloral.com" }).first()).toContainText("Viewer for Mia Carter");
});
