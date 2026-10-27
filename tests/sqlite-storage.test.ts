import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { closeDatabase, getDatabase } from "@/lib/server/db";
import {
  findProject,
  listProjects,
  readColumnProfiles,
  saveProjectProfile,
  updateColumnOverrides,
  type StoredProject,
} from "@/lib/server/projects";
import type { ProfileResult } from "@/lib/profiler";

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "dataforge-sqlite-"));
  vi.stubEnv("DATAFORGE_DATA_DIR", directory);
});
afterEach(() => {
  closeDatabase();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

function project(): StoredProject {
  return {
    id: randomUUID(),
    name: "Stored sales",
    sourceFile: "sales.csv",
    sourceType: "CSV",
    status: "Ready",
    rowCount: 2,
    columnCount: 1,
    duplicateRowCount: 0,
    totalNullCells: 0,
    createdAt: "2026-10-27T12:00:00.000Z",
    updatedAt: "2026-10-27T12:00:00.000Z",
  };
}

function profile(): ProfileResult {
  return {
    rowCount: 2,
    columnCount: 1,
    duplicateRowCount: 0,
    totalNullCells: 0,
    sampledRows: [["1"], ["2"]],
    sampledRowsTruncated: false,
    raggedRowCount: 0,
    raggedRowExamples: [],
    delimiter: ",",
    columns: [
      {
        ordinal: 0,
        name: "ID",
        inferredType: "integer",
        nullPct: 0,
        nullCount: 0,
        distinctCount: 2,
        duplicateCount: 0,
        minValue: "1",
        maxValue: "2",
        isKeyCandidate: true,
        isNearKeyCandidate: false,
        sampleValues: ["1", "2"],
      },
    ],
  };
}

describe("built-in SQLite storage", () => {
  it("retains WAL, busy timeout, and foreign-key enforcement", () => {
    const database = getDatabase();
    expect(database).toBeInstanceOf(DatabaseSync);
    expect(getDatabase()).toBe(database);
    expect(database.prepare("PRAGMA journal_mode").get()).toMatchObject({
      journal_mode: "wal",
    });
    expect(database.prepare("PRAGMA busy_timeout").get()).toMatchObject({
      timeout: 5000,
    });
    expect(database.prepare("PRAGMA foreign_keys").get()).toMatchObject({
      foreign_keys: 1,
    });

    const saved = project();
    saveProjectProfile(saved, profile());
    const remove = database.prepare("DELETE FROM projects WHERE id = ?");
    remove.run(saved.id);
    expect(readColumnProfiles(saved.id)).toEqual([]);
    expect(() =>
      database
        .prepare(
          `
      INSERT INTO column_profiles (project_id, ordinal, name, inferred_type, null_pct,
        distinct_count, duplicate_count, is_key_candidate, sample_values)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
        )
        .run(saved.id, 0, "ID", "integer", 0, 2, 0, 1, "[]"),
    ).toThrow(/FOREIGN KEY/i);
  });

  it("rolls back a failed profile insert and accepts the next transaction", () => {
    const saved = project();
    const invalidProfile = profile();
    invalidProfile.columns.push({
      ...invalidProfile.columns[0],
      name: "Duplicate ordinal",
    });
    invalidProfile.columnCount = 2;

    expect(() => saveProjectProfile(saved, invalidProfile)).toThrow(/UNIQUE/i);
    expect(listProjects()).toEqual([]);
    expect(readColumnProfiles(saved.id)).toEqual([]);

    saveProjectProfile(saved, profile());
    closeDatabase();
    closeDatabase();
    expect(findProject(saved.id)).toEqual(saved);
    expect(readColumnProfiles(saved.id)[0]).toMatchObject({
      sampleValues: ["1", "2"],
      isKeyCandidate: true,
      overrideType: null,
    });
  });

  it("reads and updates an existing database with the original table schema", () => {
    const saved = project();
    const existing = new DatabaseSync(join(directory, "dataforge.db"));
    try {
      // This is the schema written by the previous driver, before app initialization.
      existing.exec(`
        CREATE TABLE projects (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, source_file TEXT NOT NULL,
          source_type TEXT NOT NULL CHECK (source_type IN ('CSV', 'XLSX')),
          status TEXT NOT NULL, row_count INTEGER NOT NULL CHECK (row_count >= 0),
          column_count INTEGER NOT NULL CHECK (column_count >= 0),
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE column_profiles (
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          ordinal INTEGER NOT NULL CHECK (ordinal >= 0), name TEXT NOT NULL,
          inferred_type TEXT NOT NULL, override_type TEXT, null_pct REAL NOT NULL,
          distinct_count INTEGER NOT NULL, duplicate_count INTEGER NOT NULL,
          min_value TEXT, max_value TEXT,
          is_key_candidate INTEGER NOT NULL CHECK (is_key_candidate IN (0, 1)),
          sample_values TEXT NOT NULL, PRIMARY KEY (project_id, ordinal)
        );
      `);
      existing
        .prepare("INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(
          saved.id,
          saved.name,
          saved.sourceFile,
          saved.sourceType,
          saved.status,
          saved.rowCount,
          saved.columnCount,
          saved.createdAt,
          saved.updatedAt,
        );
      existing
        .prepare(
          "INSERT INTO column_profiles VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          saved.id,
          0,
          "ID",
          "integer",
          null,
          0,
          2,
          0,
          "1",
          "2",
          1,
          '["1","2"]',
        );
    } finally {
      existing.close();
    }

    expect(findProject(saved.id)).toEqual({
      ...saved,
      duplicateRowCount: null,
      totalNullCells: null,
    });
    expect(readColumnProfiles(saved.id)).toEqual([
      { ...profile().columns[0], overrideType: null },
    ]);
    updateColumnOverrides(saved.id, [{ ordinal: 0, type: "text" }]);
    closeDatabase();
    expect(readColumnProfiles(saved.id)[0]).toMatchObject({
      inferredType: "integer",
      overrideType: "text",
    });
  });
});
