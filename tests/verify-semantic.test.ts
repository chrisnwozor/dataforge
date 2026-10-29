import { describe, expect, it, vi } from "vitest";
import {
  createSemanticChecks,
  clearedMeasureAttributes,
} from "@/lib/verify/semantic";
import { buildReferenceQuery } from "@/lib/verify/reference";
import type { SemanticModel, SemanticMeasure } from "@/lib/semantic/types";
import type {
  QueryResult,
  QueryValue,
  SemanticQuery,
} from "@/lib/semantic/query/types";
import type {
  ReferenceSql,
  SemanticCheckInput,
  CheckCase,
} from "@/lib/verify/types";
const definition = (
  id: string,
  name: string,
  expression: string,
): SemanticMeasure => ({
  id,
  name,
  expression,
  format: name.includes("%") ? "percent" : "number",
  folder: "",
  description: "",
  isAuto: false,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
});
const model: SemanticModel = {
  projectId: "independent-tests",
  version: "1",
  factTableId: "fact",
  tables: [
    {
      id: "fact",
      name: "fact_sales",
      schema: "dw",
      sqlName: "fact_sales",
      kind: "fact",
      keyColumnId: "fact-key",
      columns: [
        {
          id: "fact-key",
          tableId: "fact",
          name: "FactKey",
          sqlName: "fact_key",
          type: "number",
          role: "key",
        },
        {
          id: "Sales",
          tableId: "fact",
          name: "Sales",
          sqlName: "Sales",
          type: "number",
          role: "measure-source",
        },
        {
          id: "Profit",
          tableId: "fact",
          name: "Profit",
          sqlName: "Profit",
          type: "number",
          role: "measure-source",
        },
        {
          id: "geo-key",
          tableId: "fact",
          name: "GeoKey",
          sqlName: "geo_key",
          type: "number",
          role: "key",
        },
      ],
    },
    {
      id: "geo",
      name: "dim_geo",
      schema: "dw",
      sqlName: "dim_geo",
      kind: "dimension",
      keyColumnId: "geo:key",
      columns: [
        {
          id: "geo:key",
          tableId: "geo",
          name: "GeoKey",
          sqlName: "geo_key",
          type: "number",
          role: "key",
        },
        {
          id: "Region",
          tableId: "geo",
          name: "Region",
          sqlName: "Region",
          type: "string",
          role: "attribute",
          distinctCount: 2,
        },
        {
          id: "Town",
          tableId: "geo",
          name: "Town",
          sqlName: "Town",
          type: "string",
          role: "attribute",
          distinctCount: 4,
        },
      ],
    },
  ],
  relationships: [
    {
      id: "r",
      fromTableId: "fact",
      fromColumnId: "geo-key",
      toTableId: "geo",
      toColumnId: "geo:key",
      cardinality: "many-to-one",
    },
  ],
  hierarchies: [
    {
      id: "h",
      name: "Geography",
      tableId: "geo",
      levels: ["Region", "Town"],
      isAuto: false,
    },
  ],
  measures: [
    definition("sales", "Sales", "SUM(fact_sales[Sales])"),
    definition("profit", "Profit", "SUM(fact_sales[Profit])"),
    definition("average", "Average", "AVG(fact_sales[Sales])"),
    definition("margin", "Margin %", "DIVIDE([Profit],[Sales])"),
    definition(
      "share",
      "Sales % of Total",
      "DIVIDE([Sales],CALCULATE([Sales],ALL(dim_geo[Region])))",
    ),
  ],
};
const source = [
  { Region: "East", Town: "A", Sales: 100, Profit: 10 },
  { Region: "East", Town: "B", Sales: 200, Profit: 40 },
  { Region: "West", Town: "C", Sales: 300, Profit: 90 },
  { Region: "West", Town: "D", Sales: 400, Profit: 160 },
];
function expected(names: string[], groups: string[]) {
  const contexts = new Map<string, typeof source>();
  for (const row of source) {
    const member = JSON.stringify(
        groups.map((g) => row[g as "Region" | "Town"]),
      ),
      rows = contexts.get(member) ?? [];
    rows.push(row);
    contexts.set(member, rows);
  }
  if (!groups.length && !contexts.size) contexts.set("[]", []);
  return [...contexts].map(([member, rows]) => {
    const sales = rows.reduce((s, r) => s + r.Sales, 0),
      profit = rows.reduce((s, r) => s + r.Profit, 0);
    return {
      members: JSON.parse(member) as QueryValue[],
      values: names.map((n) =>
        n === "Sales"
          ? sales
          : n === "Profit"
            ? profit
            : n === "Average"
              ? sales / rows.length
              : n === "Margin %"
                ? profit / sales
                : n === "Sales % of Total"
                  ? groups.includes("Town")
                    ? 1
                    : sales / 1000
                  : NaN,
      ),
    };
  });
}
function driver(
  options: {
    delta?: number;
    reverse?: boolean;
    truncated?: boolean;
    engineError?: Error;
    referenceError?: Error;
    duplicate?: boolean;
  } = {},
): SemanticCheckInput {
  const engine = vi.fn(async (query: SemanticQuery): Promise<QueryResult> => {
    if (options.engineError) throw options.engineError;
    const measures = query.measures.map((n) =>
      model.measures.find((m) => m.id === n || m.name === n)!,
    );
    const columns = [
      ...query.rows.map((r, i) => ({
        key: `a${i}`,
        name: r.column,
        type: "string" as const,
        role: "attribute" as const,
      })),
      ...measures.map((m, i) => ({
        key: `m${i}`,
        name: m.name,
        type: "number" as const,
        role: "measure" as const,
      })),
    ];
    let records = expected(
      measures.map((m) => m.name),
      query.rows.map((r) => r.column),
    ).map((r) =>
      Object.fromEntries([
        ...r.members.map((v, i) => [`a${i}`, v]),
        ...r.values.map((v, i) => [`m${i}`, v + (options.delta ?? 0)]),
      ]),
    );
    if (options.reverse) records = records.reverse();
    if (options.duplicate) records.push({ ...records[0] });
    return {
      columns,
      rows: records,
      rowCount: records.length,
      truncated: options.truncated ?? false,
      sql: "SELECT engine_result",
      elapsedMs: 1,
      fromCache: false,
    };
  });
  const reference = vi.fn(async (query: ReferenceSql) => {
    if (options.referenceError) throw options.referenceError;
    const attributes = query.columns.filter((c) => c.role === "attribute"),
      measures = query.columns.filter((c) => c.role === "measure");
    return expected(
      measures.map((m) => m.name),
      attributes.map((c) => c.name),
    ).map((r) =>
      Object.fromEntries([
        ...r.members.map((v, i) => [attributes[i].key, v]),
        ...r.values.map((v, i) => [measures[i].key, v]),
      ]),
    );
  });
  return { model: structuredClone(model), engine, reference };
}
const signal = () => new AbortController().signal;
const find = (checks: CheckCase[], id: string) => {
  const result = checks.find((c) => c.id === id);
  if (!result) throw new Error(`Missing test check ${id}`);
  return result;
};
describe("semantic correctness checks with independent driver doubles", () => {
  it("reconciles every supported measure/context and additive hierarchy to explicit fixture arithmetic", async () => {
    const input = driver({ reverse: true }),
      checks = createSemanticChecks(input);
    expect(checks.length).toBeGreaterThan(20);
    for (const check of checks) {
      const outcome = await check.run(signal());
      expect(outcome.status, `${check.name}: ${outcome.explanation}`).toBe(
        "pass",
      );
      expect(outcome.sql).toContain("engine_result");
      expect(outcome.referenceSql).toContain("FROM");
    }
    expect(input.engine).toHaveBeenCalled();
    expect(input.reference).toHaveBeenCalled();
  });
  it("fails a wrong grand total and retains actual and independently generated SQL", async () => {
    const input = driver({ delta: 1 }),
      out = await find(createSemanticChecks(input), "semantic-total:sales").run(
        signal(),
      );
    expect(out.status).toBe("fail");
    expect(out.sql).toBe("SELECT engine_result");
    expect(out.referenceSql).toContain("SUM(CONVERT");
    expect(out.explanation).toMatch(/differ|discrepancy/);
  });
  it("matches member tuples independently of result order and rejects duplicate contexts", async () => {
    expect(
      (
        await find(
          createSemanticChecks(driver({ reverse: true })),
          "semantic-group:sales:geo:Region",
        ).run(signal())
      ).status,
    ).toBe("pass");
    const duplicate = await find(
      createSemanticChecks(driver({ duplicate: true })),
      "semantic-group:sales:geo:Region",
    ).run(signal());
    expect(duplicate.status).toBe("fail");
    expect(duplicate.explanation).toContain("duplicate member tuples");
  });
  it("accepts currency differences within absolute tolerance and fails outside it", async () => {
    const input = driver({ delta: 0.005 });
    expect(
      (
        await find(
          createSemanticChecks(input, { absolute: 0.01, relative: 0 }),
          "semantic-total:sales",
        ).run(signal())
      ).status,
    ).toBe("pass");
    expect(
      (
        await find(
          createSemanticChecks(input, { absolute: 0.001, relative: 0 }),
          "semantic-total:sales",
        ).run(signal())
      ).status,
    ).toBe("fail");
  });
  it("uses tight raw-ratio tolerance rather than treating 0.01 as one percentage point", async () => {
    const out = await find(
      createSemanticChecks(driver({ delta: 0.00002 })),
      "semantic-total:margin",
    ).run(signal());
    expect(out.status).toBe("fail");
    expect(out.tolerance).toBeLessThanOrEqual(0.000001);
  });
  it("recomputes ratios from independent physical aggregates", async () => {
    const input = driver(),
      out = await find(
        createSemanticChecks(input),
        "semantic-ratio:margin",
      ).run(signal());
    expect(out.status).toBe("pass");
    expect(out.referenceSql).toContain("[Profit]");
    expect(out.referenceSql).toContain("[Sales]");
    expect(out.explanation).toContain("Numerator and denominator");
  });
  it("checks additive partitions while never summing averages or ratios as additive values", () => {
    const checks = createSemanticChecks(driver());
    expect(
      checks.some((c) => c.id === "semantic-additive:sales:geo:Region"),
    ).toBe(true);
    expect(
      checks.some((c) => c.id.startsWith("semantic-additive:average:")),
    ).toBe(false);
    expect(
      checks.some((c) => c.id.startsWith("semantic-additive:margin:")),
    ).toBe(false);
    expect(
      checks.some((c) => c.id.startsWith("semantic-hierarchy:h:1:average")),
    ).toBe(false);
  });
  it("sums a valid percent-of-total partition to raw 1 and does not assert 100% on unrelated axes", async () => {
    const checks = createSemanticChecks(driver()),
      check = find(checks, "semantic-percent:share:geo:Region"),
      out = await check.run(signal());
    expect(out.status).toBe("pass");
    expect(out.expected).toBe(1);
    expect(out.actual).toBe(1);
    expect(checks.some((c) => c.id === "semantic-percent:share:geo:Town")).toBe(
      false,
    );
    expect(clearedMeasureAttributes(model, "share")).toEqual([
      { table: "geo", column: "Region" },
    ]);
  });
  it("reports missing cardinality and >50-value attributes as skipped with an explanation", async () => {
    const input = driver();
    input.model.tables[1].columns.find(
      (c) => c.id === "Region",
    )!.distinctCount = 51;
    delete input.model.tables[1].columns.find((c) => c.id === "Town")!
      .distinctCount;
    const checks = createSemanticChecks(input);
    const high = await find(checks, "semantic-group:sales:geo:Region").run(
        signal(),
      ),
      unknown = await find(checks, "semantic-group:sales:geo:Town").run(
        signal(),
      );
    expect(high.status).toBe("skipped");
    expect(high.explanation).toContain("51");
    expect(unknown.status).toBe("skipped");
    expect(unknown.explanation).toContain("no retained cardinality");
  });
  it("skips incomplete/truncated engine results rather than passing partial sums", async () => {
    const input = driver({ truncated: true });
    expect(
      (
        await find(
          createSemanticChecks(input),
          "semantic-group:sales:geo:Region",
        ).run(signal())
      ).status,
    ).toBe("skipped");
    expect(
      (
        await find(
          createSemanticChecks(input),
          "semantic-additive:sales:geo:Region",
        ).run(signal())
      ).status,
    ).toBe("skipped");
  });
  it("skips unsupported formulas without querying the engine or manufacturing expected numbers", async () => {
    const input = driver();
    input.model.measures = [
      definition("unsupported", "Unsupported", "MEDIAN(fact_sales[Sales])"),
    ];
    const out = await find(
      createSemanticChecks(input),
      "semantic-total:unsupported",
    ).run(signal());
    expect(out.status).toBe("skipped");
    expect(out.explanation).toContain("MEDIAN");
    expect(input.engine).not.toHaveBeenCalled();
    expect(input.reference).not.toHaveBeenCalled();
  });
  it("skips time intelligence when no date dimension is configured", async () => {
    const input = driver();
    input.model.measures = [
      definition("ytd", "Sales YTD", "YTD(SUM(fact_sales[Sales]))"),
    ];
    const out = await find(
      createSemanticChecks(input),
      "semantic-total:ytd",
    ).run(signal());
    expect(out.status).toBe("skipped");
    expect(out.explanation).toContain("date dimension");
  });
  it.each(["engine", "reference"] as const)(
    "records %s failures as failed checks with available SQL",
    async (kind) => {
      const error = Object.assign(new Error("driver unavailable"), {
          sql: `SELECT broken_${kind}`,
        }),
        input = driver(
          kind === "engine"
            ? { engineError: error }
            : { referenceError: error },
        );
      const out = await find(
        createSemanticChecks(input),
        "semantic-total:sales",
      ).run(signal());
      expect(out.status).toBe("fail");
      expect(out.explanation).toContain("driver unavailable");
      expect(out.sql).toContain(
        kind === "engine" ? "broken_engine" : "engine_result",
      );
      expect(out.referenceSql).toContain("SELECT");
    },
  );
  it("preserves cancellation and labels low-priority preemption as skipped", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      find(createSemanticChecks(driver()), "semantic-total:sales").run(
        controller.signal,
      ),
    ).rejects.toThrow();
    const error = Object.assign(new Error("preempted"), { status: 499 });
    const out = await find(
      createSemanticChecks(driver({ engineError: error })),
      "semantic-total:sales",
    ).run(signal());
    expect(out.status).toBe("skipped");
    expect(out.explanation).toContain("interactive request");
  });
  it("builds explicit year and year/month window checks for time measures", () => {
    const input = driver();
    input.model.tables.push({
      id: "date",
      name: "dim_date",
      schema: "dw",
      sqlName: "dim_date",
      kind: "dimension",
      keyColumnId: "DateKey",
      columns: [
        {
          id: "DateKey",
          tableId: "date",
          name: "DateKey",
          sqlName: "DateKey",
          type: "number",
          role: "key",
        },
        ...(["Date", "Year", "Month"] as const).map((n) => ({
          id: n,
          tableId: "date",
          name: n,
          sqlName: n,
          type: n === "Date" ? ("date" as const) : ("number" as const),
          role: "attribute" as const,
          distinctCount: 12,
        })),
      ],
    });
    input.model.date = {
      tableId: "date",
      dateColumnId: "Date",
      keyColumnId: "DateKey",
      factColumnId: "fk",
    };
    input.model.measures.push(definition("ytd", "Sales YTD", "YTD([Sales])"));
    const checks = createSemanticChecks(input);
    expect(checks.some((c) => c.id === "semantic-time:ytd:year")).toBe(true);
    expect(checks.some((c) => c.id === "semantic-time:ytd:month")).toBe(true);
  });
  it("reference output identities are separate from engine projection names", () => {
    const built = buildReferenceQuery(model, {
      measures: ["sales"],
      rows: [{ table: "geo", column: "Region" }],
      filters: [],
      orderBy: [],
      hideUnknown: false,
      limit: 100,
    });
    expect(built.columns.map((c) => c.key)).toEqual(["g0", "v0"]);
  });
  it("exercises fail, tolerance and error paths for every generated semantic check", async () => {
    for (const check of createSemanticChecks(driver({ delta: 1 }))) {
      const out = await check.run(signal());
      expect(out.status, `${check.name}: ${out.explanation}`).toBe("fail");
    }
    for (const check of createSemanticChecks(driver({ delta: 0.0000001 }))) {
      const out = await check.run(signal());
      expect(out.status, `${check.name}: ${out.explanation}`).toBe("pass");
    }
    for (const check of createSemanticChecks(
      driver({ engineError: new Error("unavailable driver") }),
    )) {
      const out = await check.run(signal());
      expect(out.status, `${check.name}: ${out.explanation}`).toBe("fail");
    }
    for (const check of createSemanticChecks(
      driver({ referenceError: new Error("unavailable independent driver") }),
    )) {
      const out = await check.run(signal());
      expect(out.status, `${check.name}: ${out.explanation}`).toBe("fail");
    }
  });
  it("exercises truncation/skip paths for every generated semantic check", async () => {
    for (const check of createSemanticChecks(driver({ truncated: true }))) {
      const out = await check.run(signal());
      expect(out.status, `${check.name}: ${out.explanation}`).toBe("skipped");
    }
  });
  it("does not require average or cross-measure ALL ratios to sum to 100%", () => {
    const input = driver();
    input.model.measures.push(
      definition(
        "avg-share",
        "Average %",
        "DIVIDE([Average],CALCULATE([Average],ALL(dim_geo[Region])))",
      ),
      definition(
        "cross-share",
        "Profit % of Sales",
        "DIVIDE([Profit],CALCULATE([Sales],ALL(dim_geo[Region])))",
      ),
    );
    const checks = createSemanticChecks(input);
    expect(
      checks.some((c) => c.id.startsWith("semantic-percent:avg-share:")),
    ).toBe(false);
    expect(
      checks.some((c) => c.id.startsWith("semantic-percent:cross-share:")),
    ).toBe(false);
    expect(checks.some((c) => c.id === "semantic-total:avg-share")).toBe(true);
  });
  it("skips an undefined zero-denominator distribution instead of inventing 100%", async () => {
    const input = driver(),
      originalEngine = input.engine,
      originalReference = input.reference;
    input.engine = async (q, s) => {
      const result = await originalEngine(q, s);
      if (q.measures.includes("share"))
        for (const row of result.rows)
          for (const c of result.columns.filter((c) => c.role === "measure"))
            row[c.key] = null;
      return result;
    };
    input.reference = async (q, s) => {
      const rows = await originalReference(q, s);
      if (q.columns.some((c) => c.name === "Sales % of Total"))
        for (const row of rows)
          for (const c of q.columns.filter((c) => c.role === "measure"))
            row[c.key] = null;
      return rows;
    };
    const out = await find(
      createSemanticChecks(input),
      "semantic-percent:share:geo:Region",
    ).run(signal());
    expect(out.status).toBe("skipped");
    expect(out.explanation).toContain("denominator is zero or NULL");
  });
});
