import { getTableColumns } from "drizzle-orm";
import { getTableName, type Table } from "drizzle-orm/table";
import { describe, expect, it } from "vitest";

import { createTestDatabase } from "./client";
import * as schema from "./schema";

function schemaTables(): Table[] {
  return Object.values(schema).filter((value): value is Table => {
    return typeof value === "object" && value !== null && Symbol.for("drizzle:IsDrizzleTable") in value;
  });
}

describe("database schema drift guard", () => {
  it("initializes every table and column declared in drizzle schema.ts", () => {
    const db = createTestDatabase();
    const initializedTables = new Set(
      (
        db.sqlite
          .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual table')")
          .all() as Array<{ name: string }>
      ).map((table) => table.name),
    );

    for (const table of schemaTables()) {
      const tableName = getTableName(table);
      expect(initializedTables, `${tableName} table exists after initializeDatabase`).toContain(tableName);

      const initializedColumns = new Set(
        (db.sqlite.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>).map(
          (column) => column.name,
        ),
      );
      const schemaColumns = Object.values(getTableColumns(table)).map((column) => column.name);

      for (const columnName of schemaColumns) {
        expect(initializedColumns, `${tableName}.${columnName} exists after initializeDatabase`).toContain(columnName);
      }
    }
  });
});
