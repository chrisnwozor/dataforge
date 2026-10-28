import { DatabaseSync } from "node:sqlite";
import type { SemanticColumn, SemanticModel } from "@/lib/semantic/types";
import {
  readSuperstoreRows,
  type SuperstoreRow,
} from "../fixtures/superstore-results";

const quote = (name: string) => `[${name.replaceAll("]", "]]")}]`;
const value = (
  raw: string | undefined,
  column: SemanticColumn,
): string | number | null => {
  if (raw === undefined || !raw.trim()) return null;
  if (column.type === "number") return Number(raw.replaceAll(",", ""));
  if (column.type === "boolean") return /^(true|yes|1)$/i.test(raw) ? 1 : 0;
  return raw.trim();
};
const dateValue = (
  date: string,
  column: SemanticColumn,
): string | number | null => {
  const [year, month, day] = date.split("-").map(Number);
  const instant = new Date(date + "T00:00:00.000Z");
  const weekday = instant.getUTCDay();
  const values: Record<string, string | number> = {
    Date: date,
    Year: year,
    Quarter: Math.ceil(month / 3),
    QuarterName: `Q${Math.ceil(month / 3)}`,
    Month: month,
    MonthName: new Intl.DateTimeFormat("en-US", {
      month: "long",
      timeZone: "UTC",
    }).format(instant),
    Day: day,
    DayOfWeek: weekday === 0 ? 7 : weekday,
    DayName: new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      timeZone: "UTC",
    }).format(instant),
    WeekOfYear: Math.ceil(
      (instant.getTime() - Date.UTC(year, 0, 1) + 86_400_000) / 604_800_000,
    ),
    IsWeekend: weekday === 0 || weekday === 6 ? 1 : 0,
  };
  return values[column.name] ?? null;
};

/** Test warehouse setup from source rows, independent of the query compiler. */
export function createSuperstoreWarehouse(
  model: SemanticModel,
  observations: SuperstoreRow[] = readSuperstoreRows(),
): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const schema of new Set(model.tables.map((table) => table.schema)))
    db.exec(`ATTACH DATABASE ':memory:' AS ${quote(schema)}`);
  for (const table of model.tables) {
    db.exec(
      `CREATE TABLE ${quote(table.schema)}.${quote(table.sqlName)} (${table.columns.map((column) => `${quote(column.sqlName)} ${column.id === table.keyColumnId ? "INTEGER PRIMARY KEY" : column.type === "number" || column.type === "boolean" ? "REAL" : "TEXT"}`).join(", ")})`,
    );
  }
  const fact = model.tables.find((table) => table.id === model.factTableId)!;
  const dimensionKeys = new Map<string, Map<string, number>>();
  for (const table of model.tables.filter(
    (table) => table.kind === "dimension",
  )) {
    const relationship = model.relationships.find(
      (link) => link.toTableId === table.id,
    )!;
    const foreign = fact.columns.find(
      (column) => column.id === relationship.fromColumnId,
    )!;
    const sourceOrdinal =
      foreign.sourceColumnId === undefined
        ? undefined
        : Number(foreign.sourceColumnId);
    if (sourceOrdinal === undefined)
      throw new Error(`Test fixture needs a source key for ${table.name}`);
    const keys = new Map<string, number>();
    dimensionKeys.set(table.id, keys);
    const insert = db.prepare(
      `INSERT INTO ${quote(table.schema)}.${quote(table.sqlName)} VALUES (${table.columns.map(() => "?").join(",")})`,
    );
    insert.run(
      ...table.columns.map((column) =>
        column.id === table.keyColumnId
          ? -1
          : column.type === "number"
            ? -1
            : null,
      ),
    );
    for (const observation of observations) {
      const raw = observation.raw[sourceOrdinal]?.trim();
      if (!raw || keys.has(raw)) continue;
      const key =
        table.id === model.date?.tableId
          ? Number(raw.replaceAll("-", ""))
          : keys.size + 1;
      keys.set(raw, key);
      insert.run(
        ...table.columns.map((column) =>
          column.id === table.keyColumnId
            ? key
            : table.id === model.date?.tableId
              ? dateValue(raw, column)
              : value(
                  column.sourceColumnId === undefined
                    ? undefined
                    : observation.raw[Number(column.sourceColumnId)],
                  column,
                ),
        ),
      );
    }
  }
  const insertFact = db.prepare(
    `INSERT INTO ${quote(fact.schema)}.${quote(fact.sqlName)} VALUES (${fact.columns.map(() => "?").join(",")})`,
  );
  for (const [index, observation] of observations.entries()) {
    insertFact.run(
      ...fact.columns.map((column) => {
        if (column.id === fact.keyColumnId) return index + 1;
        const relationship = model.relationships.find(
          (link) => link.fromColumnId === column.id,
        );
        if (relationship)
          return (
            dimensionKeys
              .get(relationship.toTableId)!
              .get(observation.raw[Number(column.sourceColumnId)]?.trim()) ?? -1
          );
        return value(
          column.sourceColumnId === undefined
            ? undefined
            : observation.raw[Number(column.sourceColumnId)],
          column,
        );
      }),
    );
  }
  return db;
}
