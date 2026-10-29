import { localMode, requireProjectAccess } from "@/lib/auth/context";
import { createHash } from "node:crypto";
import { deriveSemanticModel } from "@/lib/semantic/derive";
import {
  semanticEditsSchema,
  semanticHierarchySchema,
  semanticMeasureSchema,
  semanticModelSchema,
} from "@/lib/semantic/schema";
import type {
  SemanticHierarchy,
  SemanticMeasure,
  SemanticModel,
} from "@/lib/semantic/types";
import { compile, parse, type Expr } from "@/lib/semantic/expr";
import { invalidateSemanticCache } from "@/lib/semantic/query/cache";
import { getDatabase, withTransaction } from "./db";
import { HttpError } from "./http";
import { getConnectionSettings, readPublicConnection } from "./connection";
import { getOrCreateModel } from "./models";
import {
  ensureProjectEvidence,
  findProject,
  readColumnProfiles,
  readProfileReport,
} from "./projects";
import { listRuns } from "./runs";

/** Server-only gate shared by semantic and query APIs. Never return settings to a client. */
export function requireSemanticReady(projectId: string) {
  if (!localMode()) requireProjectAccess(projectId, "viewer");
  if (!findProject(projectId)) throw new HttpError(404, "Project not found.");
  const connection = readPublicConnection();
  if (!connection.configured)
    throw new HttpError(
      409,
      connection.configurationError ??
        "Configure and save a SQL Server connection in Settings before using measures or queries.",
    );
  const settings = getConnectionSettings();
  const run = listRuns(projectId).find(
    (value) =>
      value.status === "succeeded" && value.options.db === settings.database,
  );
  if (!run)
    throw new HttpError(
      409,
      "Complete a successful load into the configured database before using measures or queries.",
    );
  return { settings, run };
}

async function derive(projectId: string) {
  const project = await ensureProjectEvidence(projectId);
  const saved = await getOrCreateModel(projectId);
  if (saved.validation.some((issue) => issue.severity === "error"))
    throw new HttpError(
      409,
      "Resolve the Model validation errors and run the load before using the semantic layer.",
    );
  const columns = readColumnProfiles(projectId).map((column) => ({
    ...column,
    maxLength: column.maxLength ?? 0,
    maxDecimalPlaces: column.maxDecimalPlaces ?? 0,
  }));
  const model = deriveSemanticModel({
    project,
    model: saved.model,
    columns,
    sampledRows: readProfileReport(projectId).sampledRows ?? [],
    updatedAt: saved.updatedAt,
  });
  return {
    model,
    fingerprint: hash({
      model: saved.model,
      columns,
      tables: model.tables,
      relationships: model.relationships,
      date: model.date,
    }),
  };
}
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Cheap in-flight invalidation check; do not derive and validate the whole model a second time. */
export function readSemanticStamp(projectId: string): string {
  if (!localMode()) requireProjectAccess(projectId, "viewer");
  const row = getDatabase()
    .prepare(
      `
    SELECT p.updated_at AS projectUpdatedAt, m.updated_at AS modelUpdatedAt,
      s.revision AS semanticRevision
    FROM projects AS p LEFT JOIN models AS m ON m.project_id = p.id
    LEFT JOIN semantic_state AS s ON s.project_id = p.id WHERE p.id = ?
  `,
    )
    .get(projectId);
  return JSON.stringify(row ?? null);
}

function readDefinitions(projectId: string): {
  measures: SemanticMeasure[];
  hierarchies: SemanticHierarchy[];
} {
  const db = getDatabase();
  try {
    const measures = db
      .prepare(
        "SELECT id, name, expression, format, folder, description, is_auto AS isAuto, created_at AS createdAt, updated_at AS updatedAt FROM semantic_measures WHERE project_id = ? ORDER BY rowid",
      )
      .all(projectId)
      .map((row) =>
        semanticMeasureSchema.parse({ ...row, isAuto: row.isAuto === 1 }),
      );
    const hierarchies = db
      .prepare(
        'SELECT id, name, "table" AS tableId, levels, is_auto AS isAuto FROM semantic_hierarchies WHERE project_id = ? ORDER BY rowid',
      )
      .all(projectId)
      .map((row) =>
        semanticHierarchySchema.parse({
          ...row,
          levels: JSON.parse(String(row.levels)),
          isAuto: row.isAuto === 1,
        }),
      );
    return { measures, hierarchies };
  } catch {
    throw new HttpError(
      500,
      "Saved semantic definitions are invalid. Restore a database backup or repair the semantic definitions; they have not been replaced.",
    );
  }
}

function writeDefinitions(
  projectId: string,
  measures: SemanticMeasure[],
  hierarchies: SemanticHierarchy[],
) {
  const db = getDatabase();
  db.prepare("DELETE FROM semantic_measures WHERE project_id = ?").run(
    projectId,
  );
  db.prepare("DELETE FROM semantic_hierarchies WHERE project_id = ?").run(
    projectId,
  );
  const measure = db.prepare(
    "INSERT INTO semantic_measures (id, project_id, name, expression, format, folder, description, is_auto, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const value of measures)
    measure.run(
      value.id,
      projectId,
      value.name,
      value.expression,
      value.format,
      value.folder,
      value.description,
      value.isAuto ? 1 : 0,
      value.createdAt,
      value.updatedAt,
    );
  const hierarchy = db.prepare(
    'INSERT INTO semantic_hierarchies (id, project_id, name, "table", levels, is_auto) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (const value of hierarchies)
    hierarchy.run(
      value.id,
      projectId,
      value.name,
      value.tableId,
      JSON.stringify(value.levels),
      value.isAuto ? 1 : 0,
    );
}

function assemble(
  projectId: string,
  derived: Awaited<ReturnType<typeof derive>>,
): SemanticModel {
  const definitions = readDefinitions(projectId);
  const state = getDatabase()
    .prepare("SELECT revision FROM semantic_state WHERE project_id = ?")
    .get(projectId);
  try {
    return semanticModelSchema.parse({
      ...derived.model,
      ...definitions,
      version: hash({
        base: derived.fingerprint,
        revision: state?.revision,
        ...definitions,
      }),
    });
  } catch {
    throw new HttpError(
      500,
      "The saved semantic model is invalid. Its definitions have not been replaced.",
    );
  }
}

/** First access initializes once; intentional deletions stay deleted until explicit regeneration. */
export async function getSemanticModel(
  projectId: string,
): Promise<SemanticModel> {
  if (!localMode()) requireProjectAccess(projectId, "viewer");
  requireSemanticReady(projectId);
  const derived = await derive(projectId);
  const db = getDatabase();
  if (
    !db
      .prepare("SELECT project_id FROM semantic_state WHERE project_id = ?")
      .get(projectId)
  ) {
    withTransaction(db, () => {
      const result = db
        .prepare(
          "INSERT INTO semantic_state (project_id, updated_at) VALUES (?, ?) ON CONFLICT(project_id) DO NOTHING",
        )
        .run(projectId, new Date().toISOString());
      if (result.changes)
        writeDefinitions(
          projectId,
          derived.model.measures,
          derived.model.hierarchies,
        );
    });
  }
  return assemble(projectId, derived);
}

function assertDefinitions(model: SemanticModel, checkExpressions: boolean) {
  const unique = (values: string[], label: string) => {
    if (new Set(values).size !== values.length)
      throw new HttpError(400, `Each ${label} must be unique.`);
  };
  unique(
    model.measures.map((value) => value.id),
    "measure ID",
  );
  unique(
    model.measures.map((value) => value.name.toLocaleLowerCase("en-US")),
    "measure name",
  );
  unique(
    model.hierarchies.map((value) => value.id),
    "hierarchy ID",
  );
  unique(
    model.hierarchies.map((value) => value.name.toLocaleLowerCase("en-US")),
    "hierarchy name",
  );
  for (const hierarchy of model.hierarchies) {
    const table = model.tables.find((table) => table.id === hierarchy.tableId);
    if (
      !table ||
      hierarchy.levels.some(
        (id) => !table.columns.some((column) => column.id === id),
      )
    )
      throw new HttpError(
        400,
        "Hierarchy levels must reference columns in the selected semantic table.",
      );
    unique(hierarchy.levels, "hierarchy level");
  }
  if (checkExpressions)
    for (const measure of model.measures) {
      try {
        compile(measure.expression, model);
      } catch (error) {
        throw new HttpError(
          400,
          `Measure “${measure.name}”: ${error instanceof Error ? error.message : "Invalid expression."}`,
        );
      }
    }
}

export async function saveSemanticModel(
  projectId: string,
  value: unknown,
): Promise<SemanticModel> {
  if (!localMode()) requireProjectAccess(projectId, "editor");
  const current = await getSemanticModel(projectId);
  const parsed = semanticEditsSchema.safeParse(value);
  if (!parsed.success)
    throw new HttpError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid semantic edits.",
    );
  if (
    parsed.data.version !== undefined &&
    parsed.data.version !== current.version
  )
    throw new HttpError(
      409,
      "The semantic model changed. Reload its latest version before saving.",
    );
  const timestamp = new Date().toISOString();
  const previous = new Map(
    current.measures.map((measure) => [measure.id, measure]),
  );
  const renames = new Map(
    parsed.data.measures.flatMap((measure) => {
      const old = previous.get(measure.id);
      return old && old.name !== measure.name
        ? [[old.name.toLocaleLowerCase("en-US"), measure.name] as const]
        : [];
    }),
  );
  const measures = parsed.data.measures.map((measure) => {
    const old = previous.get(measure.id);
    const changed =
      old &&
      (["name", "expression", "format", "folder", "description"] as const).some(
        (key) => old[key] !== measure[key],
      );
    let expression: string;
    try {
      expression = renameMeasureReferences(measure.expression, renames);
    } catch (error) {
      throw new HttpError(
        400,
        `Measure “${measure.name}”: ${error instanceof Error ? error.message : "Invalid expression."}`,
      );
    }
    return {
      ...measure,
      expression,
      isAuto: !!old?.isAuto && !changed && measure.isAuto,
      createdAt: old?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
  });
  const previousHierarchies = new Map(
    current.hierarchies.map((hierarchy) => [hierarchy.id, hierarchy]),
  );
  const hierarchies = parsed.data.hierarchies.map((hierarchy) => {
    const old = previousHierarchies.get(hierarchy.id);
    const unchanged =
      old &&
      old.name === hierarchy.name &&
      old.tableId === hierarchy.tableId &&
      JSON.stringify(old.levels) === JSON.stringify(hierarchy.levels);
    return {
      ...hierarchy,
      isAuto: !!old?.isAuto && !!unchanged && hierarchy.isAuto,
    };
  });
  const next = { ...current, measures, hierarchies };
  assertDefinitions(next, true);
  const db = getDatabase();
  withTransaction(db, () => {
    // Recheck the version inside the write transaction; another editor may have saved while deriving.
    const definitions = readDefinitions(projectId);
    if (
      hash({ measures: current.measures, hierarchies: current.hierarchies }) !==
      hash(definitions)
    )
      throw new HttpError(
        409,
        "The semantic model changed. Reload before saving.",
      );
    writeDefinitions(projectId, next.measures, next.hierarchies);
    db.prepare(
      "UPDATE semantic_state SET revision = revision + 1, updated_at = ? WHERE project_id = ?",
    ).run(timestamp, projectId);
  });
  invalidateSemanticCache(projectId);
  return getSemanticModel(projectId);
}

export async function regenerateSemanticDefaults(
  projectId: string,
): Promise<SemanticModel> {
  if (!localMode()) requireProjectAccess(projectId, "editor");
  await getSemanticModel(projectId);
  const derived = await derive(projectId);
  // Custom expressions remain intact even if a source-model edit now requires their repair.
  withTransaction(getDatabase(), () => {
    // Read custom definitions under the write transaction so a concurrent edit is never discarded.
    const current = readDefinitions(projectId);
    const custom = current.measures.filter((value) => !value.isAuto);
    const names = new Set(
      custom.map((value) => value.name.toLocaleLowerCase("en-US")),
    );
    const ids = new Set(custom.map((value) => value.id));
    const renames = new Map(
      derived.model.measures.flatMap((value) => {
        const replacement = custom.find((measure) => measure.id === value.id);
        return replacement && replacement.name !== value.name
          ? [[value.name.toLocaleLowerCase("en-US"), replacement.name] as const]
          : [];
      }),
    );
    const measures = [
      ...derived.model.measures
        .filter(
          (value) =>
            !ids.has(value.id) &&
            !names.has(value.name.toLocaleLowerCase("en-US")),
        )
        .map((value) => ({
          ...value,
          expression: renameMeasureReferences(value.expression, renames),
        })),
      ...custom,
    ];
    const customHierarchies = current.hierarchies.filter(
      (value) => !value.isAuto,
    );
    const hierarchyNames = new Set(
      customHierarchies.map((value) => value.name.toLocaleLowerCase("en-US")),
    );
    const hierarchyIds = new Set(customHierarchies.map((value) => value.id));
    const hierarchies = [
      ...derived.model.hierarchies.filter(
        (value) =>
          !hierarchyIds.has(value.id) &&
          !hierarchyNames.has(value.name.toLocaleLowerCase("en-US")),
      ),
      ...customHierarchies,
    ];
    writeDefinitions(projectId, measures, hierarchies);
    getDatabase()
      .prepare(
        "UPDATE semantic_state SET revision = revision + 1, updated_at = ? WHERE project_id = ?",
      )
      .run(new Date().toISOString(), projectId);
  });
  invalidateSemanticCache(projectId);
  return getSemanticModel(projectId);
}

/** Replace parsed measure references only; same-named columns and string literals stay intact. */
function renameMeasureReferences(
  expression: string,
  names: Map<string, string>,
): string {
  if (!names.size) return expression;
  const edits: { start: number; end: number; text: string }[] = [];
  const visit = (node: Expr): void => {
    if (node.kind === "measure") {
      const name = names.get(node.name.toLocaleLowerCase("en-US"));
      if (name)
        edits.push({
          start: node.pos,
          end: node.end,
          text: `[${name.replaceAll("]", "]]")}]`,
        });
    } else if (node.kind === "call") node.args.forEach(visit);
    else if (node.kind === "binary") {
      visit(node.left);
      visit(node.right);
    } else if (node.kind === "unary") visit(node.operand);
    else if (node.kind === "in") {
      visit(node.expression);
      node.values.forEach(visit);
    }
  };
  visit(parse(expression));
  return edits
    .sort((a, b) => b.start - a.start)
    .reduce(
      (text, edit) =>
        text.slice(0, edit.start) + edit.text + text.slice(edit.end),
      expression,
    );
}
