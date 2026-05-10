import { describe, expect, it } from "vitest";
import { escapeCsvCell, parseRipplingEmployees, toCsv } from "../../lib/csv";

describe("csv helpers", () => {
  it("escapes commas, quotes, and newlines", () => {
    expect(escapeCsvCell('A "quoted", value')).toBe('"A ""quoted"", value"');
    expect(toCsv([["A", "B"], ["Line\nTwo", "Plain"]])).toBe('A,B\n"Line\nTwo",Plain');
  });

  it("parses Rippling employee exports", () => {
    const employees = parseRipplingEmployees([
      "Full Name,Title,Department,Location,Hourly Rate,Gross Earnings,Hours Worked,Manager",
      "Ava Jensen,Design Specialist,Design,UT,$24,$4160,173.33,Sarah Miller"
    ].join("\n"));
    expect(employees).toHaveLength(1);
    expect(employees[0]).toMatchObject({
      name: "Ava Jensen",
      role: "Design Specialist",
      department: "Design",
      location: "Utah",
      payType: "hourly",
      hourlyRate: 24
    });
  });
});
