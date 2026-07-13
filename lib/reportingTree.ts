import type { Employee } from "./types";

// Returns the set of employee names that report, directly or transitively,
// to managerName (via Employee.manager). Does not include managerName itself.
export function getReportingTree(managerName: string, employees: Employee[]): Set<string> {
  const result = new Set<string>();
  const queue = [managerName];
  const visited = new Set<string>();
  while (queue.length) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const emp of employees) {
      if (emp.manager === current && !visited.has(emp.name)) {
        result.add(emp.name);
        queue.push(emp.name);
      }
    }
  }
  return result;
}
