import { describe, expect, it } from "vitest";
import { normalizeAdminUserPayload, scopeSummary } from "../../lib/adminUsers";

describe("admin user payloads", () => {
  it("normalizes admin profiles to full access", () => {
    const result = normalizeAdminUserPayload({
      email: "ADMIN@PressedFloral.com",
      role: "admin",
      departments: ["Design"],
      locations: ["Utah"],
      linkedEmployeeName: "Ava Jensen"
    }, { requireEmail: true });

    expect(result).toEqual({
      ok: true,
      value: {
        email: "admin@pressedfloral.com",
        role: "admin",
        departments: [],
        locations: [],
        allDepartments: true,
        allLocations: true
      }
    });
  });

  it("allows manager all-scope access only through explicit flags", () => {
    const result = normalizeAdminUserPayload({
      role: "manager",
      departments: [],
      locations: [],
      allDepartments: true,
      allLocations: true
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.departments).toEqual([]);
      expect(result.value.locations).toEqual([]);
    }
  });

  it("keeps scoped manager departments and locations", () => {
    const result = normalizeAdminUserPayload({
      role: "manager",
      departments: ["Design", "Not a department", "Design"],
      locations: ["Utah", "Mars"],
      linkedEmployeeName: "Mia Carter"
    });

    expect(result).toEqual({
      ok: true,
      value: {
        role: "manager",
        departments: ["Design"],
        locations: ["Utah"],
        linkedEmployeeName: "Mia Carter",
        allDepartments: false,
        allLocations: false
      }
    });
  });

  it("requires users to be linked to an employee", () => {
    expect(normalizeAdminUserPayload({ role: "user", linkedEmployeeName: "" })).toEqual({
      ok: false,
      error: "Choose the employee this viewer can access."
    });

    const result = normalizeAdminUserPayload({
      role: "user",
      linkedEmployeeName: "Ava Jensen",
      departments: ["Design"],
      locations: ["Utah"]
    });

    expect(result).toEqual({
      ok: true,
      value: {
        role: "user",
        departments: [],
        locations: [],
        linkedEmployeeName: "Ava Jensen",
        allDepartments: true,
        allLocations: true
      }
    });
  });

  it("rejects invalid roles and manager scopes", () => {
    expect(normalizeAdminUserPayload({ role: "owner" })).toEqual({
      ok: false,
      error: "Choose a valid role."
    });
    expect(normalizeAdminUserPayload({ role: "manager", departments: [], locations: ["Utah"] })).toEqual({
      ok: false,
      error: "Choose at least one department or select all departments."
    });
  });

  it("summarizes role scopes", () => {
    expect(scopeSummary({ role: "admin", departments: [], locations: [] })).toBe("Full access");
    expect(scopeSummary({ role: "user", departments: [], locations: [], linkedEmployeeName: "Ava Jensen" })).toBe("Viewer for Ava Jensen");
    expect(scopeSummary({ role: "manager", departments: ["Design"], locations: [] })).toBe("Design · all locations");
  });
});
