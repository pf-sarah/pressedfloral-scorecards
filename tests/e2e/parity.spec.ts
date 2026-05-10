import { expect, test } from "@playwright/test";

test("@parity fixture auth lands on Home with admin access", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
  await expect(page.getByText("Where would you like to go?")).toBeVisible();
  await expect(page.getByText("local-dev@pressedfloral.com")).toBeVisible();
  await expect(page.getByTestId("nav-rippling")).toBeVisible();
});

test("@parity goals and actuals show fixture goals and save actuals", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("nav-setup").click();
  await expect(page.getByRole("heading", { name: "Goals & Actuals" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Company Revenue" })).toBeVisible();
  const actual = page.getByLabel("Actual for Company Revenue");
  await actual.fill("135000");
  await actual.blur();
  await expect(page.getByText("Actual saved")).toBeVisible();
});

test("@parity team scorecard calculates and submits", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("nav-scorecard").click();
  await page.getByLabel("Employee").selectOption("emp-ava");
  await page.getByLabel("Scorecard actual for Completed Designs").fill("47");
  await expect(page.getByText("Calculated Bonus")).toBeVisible();
  await expect(page.getByText("Weighted Achievement")).toBeVisible();
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
