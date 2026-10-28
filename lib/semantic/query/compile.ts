import type { ResolvedExpr } from "../expr";
import { createExpressionResolver } from "../expr";
import type {
  SemanticColumn,
  SemanticMeasure,
  SemanticModel,
  SemanticTable,
  SemanticType,
  SqlParameter,
} from "../types";
import type {
  AttributeRef,
  CompiledQuery,
  QueryFilter,
  QueryResultColumn,
  QueryValue,
} from "./types";
import { normalizeQuery } from "./schema";
import { MaterializedPlan, materializedBatch } from "./materialize";

export class QueryCompileError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "QueryCompileError";
  }
}

const quote = (name: string) => `[${name.replaceAll("]", "]]")}]`;
const qualified = (table: SemanticTable) =>
  `${quote(table.schema)}.${quote(table.sqlName)}`;
const fold = (value: string) => value.toLocaleLowerCase("en-US");
const timeFunctions = new Set([
  "YTD",
  "MTD",
  "QTD",
  "SAMEPERIODLASTYEAR",
  "PREVIOUSPERIOD",
]);
type ColumnRef = { table: SemanticTable; column: SemanticColumn };
type BoundFilter = QueryFilter & { resolved: ColumnRef };
function findOne<T>(
  values: T[],
  name: string,
  id: (value: T) => string,
  names: (value: T) => string[],
  kind: string,
): T {
  const exact = values.find((value) => id(value) === name);
  if (exact) return exact;
  const matches = values.filter((value) =>
    names(value).some((candidate) => fold(candidate) === fold(name)),
  );
  if (matches.length !== 1)
    throw new QueryCompileError(
      matches.length
        ? `The ${kind} reference is ambiguous: ${name}. Use its ID.`
        : `Unknown ${kind}: ${name}.`,
    );
  return matches[0];
}

export function resolveAttribute(
  model: SemanticModel,
  ref: AttributeRef,
  allowMeasureSource = false,
): ColumnRef {
  const table = findOne(
    model.tables,
    ref.table,
    (value) => value.id,
    (value) => [value.name, value.sqlName],
    "table",
  );
  const column = findOne(
    table.columns,
    ref.column,
    (value) => value.id,
    (value) => [value.name, value.sqlName],
    "column",
  );
  if (column.role === "measure-source" && !allowMeasureSource)
    throw new QueryCompileError(
      `${column.name} is a measure source. Select a measure instead of grouping this numeric source.`,
    );
  return { table, column };
}

function resolveMeasure(model: SemanticModel, ref: string): SemanticMeasure {
  return findOne(
    model.measures,
    ref,
    (value) => value.id,
    (value) => [value.name],
    "measure",
  );
}

function walk(node: ResolvedExpr, visit: (node: ResolvedExpr) => void): void {
  visit(node);
  switch (node.kind) {
    case "measure":
      walk(node.expression, visit);
      break;
    case "unary":
      walk(node.operand, visit);
      break;
    case "binary":
      walk(node.left, visit);
      walk(node.right, visit);
      break;
    case "in":
      walk(node.expression, visit);
      node.values.forEach((value) => walk(value, visit));
      break;
    case "call":
      node.args.forEach((value) => walk(value, visit));
      break;
  }
}

/** Every identifier comes from the validated semantic model; values are always parameters. */
class SqlBuilder {
  readonly params: SqlParameter[] = [];
  readonly usedColumns = new Map<string, ColumnRef>();
  readonly usedTables = new Set<string>();
  private aliases = new Map<string, string>();
  private flatAliases = new Map<string, string>();
  readonly fact: SemanticTable;

  constructor(
    readonly model: SemanticModel,
    readonly hideUnknown: boolean,
  ) {
    const fact = model.tables.find(
      (table) => table.id === model.factTableId && table.kind === "fact",
    );
    if (!fact)
      throw new QueryCompileError("The semantic model has no fact table.");
    this.fact = fact;
    this.aliases.set(fact.id, "f");
  }

  addColumn(ref: ColumnRef) {
    this.usedTables.add(ref.table.id);
    this.usedColumns.set(ref.column.id, ref);
  }

  addExpression(node: ResolvedExpr) {
    walk(node, (child) => {
      if (child.kind === "column") this.addColumn(child);
      if (child.kind === "call" && timeFunctions.has(child.name)) {
        const date = this.model.date;
        if (!date)
          throw new QueryCompileError(
            `${child.name} requires a generated date dimension.`,
          );
        const table = this.model.tables.find(
          (candidate) => candidate.id === date.tableId,
        );
        const column = table?.columns.find(
          (candidate) => candidate.id === date.dateColumnId,
        );
        if (!table || !column)
          throw new QueryCompileError(
            "The semantic calendar relationship is invalid.",
          );
        this.addColumn({ table, column });
      }
    });
  }

  param(value: QueryValue, type?: SemanticType): string {
    if (this.params.length >= 1_999)
      throw new QueryCompileError(
        "The query uses too many parameter values. Reduce the number of filters or selected measures.",
      );
    const name = `p${this.params.length}`;
    this.params.push({ name, value, ...(type ? { type } : {}) });
    return `@${name}`;
  }

  prepare() {
    let index = 0;
    for (const table of this.model.tables)
      if (this.usedTables.has(table.id) && table.id !== this.fact.id)
        this.aliases.set(table.id, `d${index++}`);
    index = 0;
    for (const id of this.usedColumns.keys())
      this.flatAliases.set(id, `c${index++}`);
  }

  column(ref: ColumnRef, flatAlias?: string): string {
    if (flatAlias) {
      const flat = this.flatAliases.get(ref.column.id);
      if (!flat)
        throw new QueryCompileError(
          "An expression references a column outside the query model.",
        );
      return `${quote(flatAlias)}.${quote(flat)}`;
    }
    const alias = this.aliases.get(ref.table.id);
    if (!alias)
      throw new QueryCompileError(
        "An expression references an unjoined table.",
      );
    return `${quote(alias)}.${quote(ref.column.sqlName)}`;
  }

  flatName(columnId: string): string {
    const name = this.flatAliases.get(columnId);
    if (!name) throw new QueryCompileError("Unknown prepared column.");
    return name;
  }

  includeSurrogateKeys() {
    for (const table of this.model.tables) {
      if (table.id === this.fact.id || !this.usedTables.has(table.id)) continue;
      const { source, target } = this.relationship(table);
      this.addColumn({ table: this.fact, column: source });
      this.addColumn({ table, column: target });
    }
  }

  private relationship(table: SemanticTable) {
    const links = this.model.relationships.filter(
      (link) =>
        link.fromTableId === this.fact.id &&
        link.toTableId === table.id &&
        link.cardinality === "many-to-one",
    );
    const link =
      links.find(
        (candidate) =>
          table.id === this.model.date?.tableId &&
          candidate.fromColumnId === this.model.date.factColumnId,
      ) ?? links[0];
    const source = this.fact.columns.find(
      (column) => column.id === link?.fromColumnId,
    );
    const target = table.columns.find(
      (column) => column.id === link?.toColumnId,
    );
    if (!link || !source || !target)
      throw new QueryCompileError(
        `The dimension ${table.name} has no valid fact relationship.`,
      );
    return { source, target };
  }

  from(): { from: string; unknown: string[] } {
    let from = `${qualified(this.fact)} AS [f]`;
    const unknown: string[] = [];
    for (const table of this.model.tables) {
      if (table.id === this.fact.id || !this.usedTables.has(table.id)) continue;
      const { source, target } = this.relationship(table);
      from += `\n  LEFT JOIN ${qualified(table)} AS ${quote(this.aliases.get(table.id)!)} ON [f].${quote(source.sqlName)} = ${this.column({ table, column: target })}`;
      if (this.hideUnknown) unknown.push(`[f].${quote(source.sqlName)} <> -1`);
    }
    return { from, unknown };
  }

  baseProjection(): string {
    if (!this.usedColumns.size)
      return (
        "[f]." +
        quote(
          this.fact.columns.find(
            (column) => column.id === this.fact.keyColumnId,
          )?.sqlName ?? "__invalid_key",
        ) +
        " AS [__df_fact_key]"
      );
    return [...this.usedColumns.values()]
      .map(
        (ref) =>
          `${this.column(ref)} AS ${quote(this.flatAliases.get(ref.column.id)!)}`,
      )
      .join(",\n    ");
  }

  filter(filter: BoundFilter, alias?: string): string {
    const column = this.column(filter.resolved, alias);
    const value = (input: QueryValue): string => {
      if (input !== null) {
        const type = filter.resolved.column.type;
        if (
          (type === "number" && typeof input !== "number") ||
          (type === "boolean" && typeof input !== "boolean") ||
          ((type === "string" || type === "date") && typeof input !== "string")
        )
          throw new QueryCompileError(
            `Filter values for ${filter.resolved.column.name} must have type ${type}.`,
          );
        if (
          type === "date" &&
          (typeof input !== "string" ||
            !/^\d{4}-\d{2}-\d{2}$/.test(input) ||
            !Number.isFinite(Date.parse(input)) ||
            new Date(input).toISOString().slice(0, 10) !== input)
        )
          throw new QueryCompileError(
            `Enter a valid ISO date (YYYY-MM-DD) for ${filter.resolved.column.name}.`,
          );
      }
      return this.param(input, filter.resolved.column.type);
    };
    if (filter.op === "isNull") return `${column} IS NULL`;
    if (filter.op === "isNotNull") return `${column} IS NOT NULL`;
    if (filter.op === "in" || filter.op === "notIn") {
      const values = filter.values!;
      const nonNull = values.filter((entry) => entry !== null);
      const hasNull = nonNull.length !== values.length;
      const list = nonNull.length
        ? `${column} ${filter.op === "notIn" ? "NOT IN" : "IN"} (${nonNull.map(value).join(", ")})`
        : "";
      const nullTest = hasNull
        ? `${column} IS ${filter.op === "notIn" ? "NOT " : ""}NULL`
        : "";
      return list && nullTest
        ? `(${list} ${filter.op === "notIn" ? "AND" : "OR"} ${nullTest})`
        : list || nullTest || (filter.op === "in" ? "1 = 0" : "1 = 1");
    }
    if (filter.value === null) {
      if (filter.op !== "eq" && filter.op !== "ne")
        throw new QueryCompileError(
          "NULL supports only equality, inequality, or null checks.",
        );
      return `${column} IS ${filter.op === "ne" ? "NOT " : ""}NULL`;
    }
    const op = { eq: "=", ne: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" }[
      filter.op
    ];
    return `${column} ${op} ${value(filter.value!)}`;
  }
}

function compileCheckedQuery(
  model: SemanticModel,
  input: unknown,
): CompiledQuery {
  const query = normalizeQuery(input);
  const measures = query.measures.map((ref) => resolveMeasure(model, ref));
  if (new Set(measures.map((measure) => measure.id)).size !== measures.length)
    throw new QueryCompileError("Choose each measure only once.");
  const rows = query.rows.map((ref) => resolveAttribute(model, ref));
  const pivotColumns = (query.columns ?? []).map((ref) =>
    resolveAttribute(model, ref),
  );
  const groups = [...rows, ...pivotColumns];
  if (new Set(groups.map((ref) => ref.column.id)).size !== groups.length)
    throw new QueryCompileError("Choose each grouping attribute only once.");
  const filters: BoundFilter[] = query.filters.map((filter) => ({
    ...filter,
    resolved: resolveAttribute(model, filter.attribute, true),
  }));
  const resolver = createExpressionResolver(model);
  const checked = measures.map((measure) =>
    resolver.resolveMeasure(measure.id),
  );
  const builder = new SqlBuilder(model, query.hideUnknown);
  groups.forEach((ref) => builder.addColumn(ref));
  filters.forEach((filter) => builder.addColumn(filter.resolved));
  checked.forEach((expression) => builder.addExpression(expression.ast));
  const factKey = builder.fact.columns.find(
    (column) => column.id === builder.fact.keyColumnId,
  );
  if (!factKey)
    throw new QueryCompileError("The semantic fact has no surrogate key.");
  builder.addColumn({ table: builder.fact, column: factKey });
  builder.includeSurrogateKeys();
  builder.prepare();
  let usesTime = false;
  checked.forEach((expression) =>
    walk(expression.ast, (node) => {
      if (node.kind === "call" && timeFunctions.has(node.name)) usesTime = true;
    }),
  );
  const plan = new MaterializedPlan(
    builder,
    groups,
    filters,
    (message) => new QueryCompileError(message),
    usesTime,
  );
  const values = checked.map((expression, index) =>
    plan.scalar(measures[index].id, expression.ast),
  );
  const { from, unknown } = builder.from();
  const batch = plan.statements(from, unknown);
  const columns: QueryResultColumn[] = [
    ...groups.map(({ column }, index) => ({
      key: `a${index}`,
      name: column.name,
      type: column.type,
      role: "attribute" as const,
    })),
    ...measures.map((measure, index) => ({
      key: `m${index}`,
      name: measure.name,
      type: (["number", "string", "boolean", "date"].includes(
        checked[index].type,
      )
        ? checked[index].type
        : "number") as SemanticType,
      role: "measure" as const,
    })),
  ];
  const groupAlias = new Map(
    groups.map((group, index) => [group.column.id, `a${index}`]),
  );
  const measureAlias = new Map(
    measures.map((measure, index) => [measure.id, `m${index}`]),
  );
  const resolveOrder = (ref: string | AttributeRef): string => {
    if (typeof ref === "string") {
      const found = groupAlias.get(ref) ?? measureAlias.get(ref);
      if (found) return found;
      const matches = columns.filter(
        (column) => fold(column.name) === fold(ref),
      );
      if (matches.length === 1) return matches[0].key;
      throw new QueryCompileError(
        "Order by a selected measure or grouping attribute.",
      );
    }
    const found = resolveAttribute(model, ref);
    const alias = groupAlias.get(found.column.id);
    if (!alias)
      throw new QueryCompileError(
        "Order attributes must also be selected as grouping attributes.",
      );
    return alias;
  };
  const order: string[] = [];
  if (query.topN) {
    const measure = resolveMeasure(model, query.topN.measure);
    const alias = measureAlias.get(measure.id);
    if (!alias)
      throw new QueryCompileError("Select the Top N measure in the query.");
    order.push(`[r].${quote(alias)} DESC`);
  }
  query.orderBy.forEach((entry) =>
    order.push(
      `[r].${quote(resolveOrder(entry.ref))} ${entry.dir === "desc" ? "DESC" : "ASC"}`,
    ),
  );
  if (!order.length)
    groups.forEach((_, index) => order.push(`[r].[a${index}] ASC`));
  const limit = query.topN ? Math.min(query.limit, query.topN.n) : query.limit;
  builder.params.push({ name: "__df_limit", value: limit + 1, type: "number" });
  const projections = [
    ...groups.map((_, index) => `[g].[a${index}]`),
    ...values.map((value, index) => `${value} AS [m${index}]`),
  ];
  const resultSource = `FROM ${quote(batch.source)} AS [g]\n${batch.joins.join("\n")}\n${batch.applies.join("\n")}${groups.length ? "\nWHERE [g].[__df_group_count] > 0" : ""}`;
  batch.statements.push(
    `SELECT ${projections.join(",\n  ")}${pivotColumns.length ? `, DENSE_RANK() OVER (ORDER BY ${pivotColumns.map((_, index) => `[g].[a${rows.length + index}]`).join(", ")}) AS [__df_pivot_rank]` : ""}\nINTO [#df_result]\n${resultSource};`,
  );
  batch.tempTables.push("#df_result");
  let finalSource = "#df_result";
  if (pivotColumns.length) {
    batch.statements.push(
      "SELECT [r].*, MAX([r].[__df_pivot_rank]) OVER () AS [__df_pivot_total] INTO [#df_pivot] FROM [#df_result] AS [r];",
    );
    batch.tempTables.push("#df_pivot");
    finalSource = "#df_pivot";
  }
  const finalSelect = `SELECT TOP (@__df_limit) ${[...columns.map((column) => `[r].${quote(column.key)}`), ...(pivotColumns.length ? ["[r].[__df_pivot_total]"] : [])].join(", ")}\nFROM ${quote(finalSource)} AS [r]${pivotColumns.length ? "\nWHERE [r].[__df_pivot_rank] <= 50" : ""}${order.length ? `\nORDER BY ${order.join(", ")}` : ""};`;
  const sql = materializedBatch(
    batch.statements,
    finalSelect,
    batch.tempTables,
  );
  if (builder.params.length > 2_000)
    throw new QueryCompileError(
      "The query uses too many parameter values. Reduce the number of filters or selected measures.",
    );
  if (sql.length > 1_048_576)
    throw new QueryCompileError(
      "The compiled query is too complex (maximum 1 MiB of SQL). Choose fewer or simpler measures.",
    );
  return {
    sql,
    params: builder.params,
    columns,
    limit,
    materialized: true,
    ...(pivotColumns.length
      ? {
          pivot: {
            rowKeys: rows.map((_, index) => `a${index}`),
            columnKeys: pivotColumns.map(
              (_, index) => `a${rows.length + index}`,
            ),
            measureKeys: measures.map((_, index) => `m${index}`),
          },
        }
      : {}),
  };
}

export function compileQuery(
  model: SemanticModel,
  input: unknown,
): CompiledQuery {
  try {
    return compileCheckedQuery(model, input);
  } catch (error) {
    if (error instanceof Error && error.name === "ExpressionError")
      throw new QueryCompileError(error.message);
    throw error;
  }
}

export function compileDistinctValues(
  model: SemanticModel,
  attribute: AttributeRef,
  hideUnknown = true,
): CompiledQuery {
  const resolved = resolveAttribute(model, attribute);
  const builder = new SqlBuilder(model, hideUnknown);
  builder.addColumn(resolved);
  builder.includeSurrogateKeys();
  builder.prepare();
  const { from, unknown } = builder.from();
  const statements = [
    `SELECT ${builder.baseProjection()}, DENSE_RANK() OVER (ORDER BY ${builder.column(resolved)}) AS [__df_k0] INTO [#df_base] FROM ${from}${unknown.length ? ` WHERE ${unknown.join(" AND ")}` : ""};`,
    "CREATE CLUSTERED INDEX [ix_df_base_groups] ON [#df_base] ([__df_k0]);",
  ];
  const column = builder.column(resolved, "b");
  const select = `SELECT TOP (@__df_limit) ${column} AS [value], COUNT_BIG(*) AS [count]\nFROM [#df_base] AS [b]\nGROUP BY ${column}\nORDER BY [count] DESC, [value] ASC;`;
  return {
    sql: materializedBatch(statements, select, ["#df_base"]),
    params: [{ name: "__df_limit", value: 1001, type: "number" }],
    columns: [
      {
        key: "value",
        name: resolved.column.name,
        type: resolved.column.type,
        role: "attribute",
      },
      { key: "count", name: "Count", type: "number", role: "measure" },
    ],
    limit: 1000,
    materialized: true,
  };
}
