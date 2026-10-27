import { describe, expect, it } from "vitest";
import { modelReducer } from "@/lib/modeling/editor";
import { modelSchema } from "@/lib/modeling/schema";
import type { Model } from "@/lib/modeling/types";

function initial(): Model {
  return {
    fact: {
      name: "fact_sales",
      grain: "one row per Order ID",
      reason: "Order ID identifies each source row.",
      measures: [
        {
          columnId: "4",
          name: "Sales",
          aggregation: "SUM",
          additivity: "additive",
          reason: "Sales is numeric.",
        },
      ],
      degenerateDimensions: [
        { columnId: "0", name: "Order ID", reason: "Order ID is unique." },
      ],
      foreignKeys: [
        {
          name: "CustomerKey",
          dimensionId: "customer",
          sourceColumnId: "2",
          reason: "Customer Name determines Segment.",
        },
        {
          name: "DateKey",
          dimensionId: "calendar",
          sourceColumnId: "1",
          reason: "The order date links to the calendar.",
        },
      ],
    },
    dimensions: [
      {
        id: "customer",
        name: "dim_customer",
        businessKey: "2",
        columnIds: ["2", "3"],
        attributes: ["3"],
        generated: null,
        reason: "Customer Name determines Segment.",
      },
      {
        id: "calendar",
        name: "dim_date",
        businessKey: "DateKey",
        columnIds: ["1"],
        attributes: ["Date", "Year", "Month", "Day"],
        generated: "date",
        reason: "Date values use a calendar dimension.",
      },
    ],
    unassigned: ["5", "6"],
    columnNames: {
      "0": "Order ID",
      "1": "Order Date",
      "2": "Customer Name",
      "3": "Segment",
      "4": "Sales",
      "5": "Discount",
      "6": "Region",
    },
    reasons: {},
    removeExactDuplicates: false,
    warnings: [],
  };
}

function assignments(model: Model): string[] {
  return [
    ...model.fact.measures.map((measure) => measure.columnId),
    ...model.fact.degenerateDimensions.map((dimension) => dimension.columnId),
    ...model.dimensions.flatMap((dimension) => dimension.columnIds),
    ...model.unassigned,
  ].sort();
}

describe("persisted model editor edits", () => {
  it("moves a measure to a dimension without losing or assigning a source twice", () => {
    const original = initial();
    const edited = modelReducer(original, {
      type: "move",
      column: "4",
      target: "customer",
      columnType: "DECIMAL",
    });
    expect(edited.fact.measures).toEqual([]);
    expect(edited.dimensions[0]).toMatchObject({
      columnIds: ["2", "3", "4"],
      attributes: ["3", "4"],
      businessKey: "2",
    });
    expect(assignments(edited)).toEqual(Object.keys(original.columnNames));
    expect(original.fact.measures).toHaveLength(1);
    expect(original.dimensions[0].columnIds).toEqual(["2", "3"]);
    expect(edited.fact.foreignKeys[0]).toEqual(original.fact.foreignKeys[0]);
    expect(modelSchema.safeParse(edited).success).toBe(true);
  });

  it("keeps incomplete business-key edits visible without dangling key references", () => {
    let model = modelReducer(initial(), {
      type: "move",
      column: "2",
      target: "unassigned",
      columnType: "VARCHAR",
    });
    expect(model.dimensions[0]).toMatchObject({
      businessKey: "",
      columnIds: ["3"],
      attributes: ["3"],
    });
    expect(model.fact.foreignKeys[0].sourceColumnId).toBeNull();
    model = modelReducer(model, { type: "key", id: "customer", column: "3" });
    expect(model.dimensions[0].attributes).toEqual([]);
    expect(model.fact.foreignKeys[0].sourceColumnId).toBe("3");
    expect(assignments(model)).toEqual(Object.keys(model.columnNames));
    expect(
      modelReducer(model, { type: "key", id: "customer", column: "999" }),
    ).toBe(model);
  });

  it("creates numeric measures and text identifiers with editable aggregations", () => {
    let model = modelReducer(initial(), {
      type: "move",
      column: "5",
      target: "fact",
      columnType: "DECIMAL",
    });
    expect(model.fact.measures[1]).toMatchObject({
      columnId: "5",
      aggregation: "AVG",
      additivity: "non-additive",
    });
    model = modelReducer(model, {
      type: "aggregation",
      column: "5",
      aggregation: "MAX",
    });
    expect(model.fact.measures[1].aggregation).toBe("MAX");
    model = modelReducer(model, {
      type: "move",
      column: "6",
      target: "fact",
      columnType: "VARCHAR",
    });
    expect(model.fact.degenerateDimensions.map((d) => d.columnId)).toEqual([
      "0",
      "6",
    ]);
    expect(assignments(model)).toEqual(Object.keys(model.columnNames));
    expect(
      modelReducer(model, {
        type: "move",
        column: "6",
        target: "fact",
        columnType: "VARCHAR",
      }),
    ).toBe(model);
  });

  it("updates calendar relationships when dates move and rejects non-date calendar attributes", () => {
    const original = initial();
    expect(
      modelReducer(original, {
        type: "move",
        column: "4",
        target: "calendar",
        columnType: "DECIMAL",
      }),
    ).toBe(original);
    let model = modelReducer(original, {
      type: "move",
      column: "1",
      target: "fact",
      columnType: "DATE",
    });
    expect(model.fact.foreignKeys.map((key) => key.name)).toEqual([
      "CustomerKey",
    ]);
    expect(model.dimensions[1].businessKey).toBe("DateKey");
    model = modelReducer(model, {
      type: "move",
      column: "1",
      target: "calendar",
      columnType: "DATE",
    });
    expect(model.fact.foreignKeys[1]).toMatchObject({
      name: "DateKey",
      dimensionId: "calendar",
      sourceColumnId: "1",
    });
    expect(assignments(model)).toEqual(Object.keys(model.columnNames));
  });

  it("returns dimension sources to unassigned and removes the associated foreign keys", () => {
    const original = initial();
    const model = modelReducer(original, { type: "remove", id: "customer" });
    expect(model.dimensions.map((dimension) => dimension.id)).toEqual([
      "calendar",
    ]);
    expect(model.unassigned).toEqual(["5", "6", "2", "3"]);
    expect(model.fact.foreignKeys.map((key) => key.dimensionId)).toEqual([
      "calendar",
    ]);
    expect(assignments(model)).toEqual(Object.keys(model.columnNames));
  });

  it("creates distinct dimension names and a business-key relationship on first assignment", () => {
    let model = modelReducer(initial(), { type: "add", id: "custom-uuid" });
    const dimension = model.dimensions[2];
    expect(dimension).toMatchObject({
      id: "custom-uuid",
      name: "dim_custom_3",
      businessKey: "",
      columnIds: [],
    });
    model = modelReducer(model, {
      type: "move",
      column: "6",
      target: dimension.id,
      columnType: "VARCHAR",
    });
    expect(model.dimensions[2]).toMatchObject({
      businessKey: "6",
      columnIds: ["6"],
      attributes: [],
    });
    expect(model.fact.foreignKeys[2].sourceColumnId).toBe("6");
    expect(modelReducer(model, { type: "add", id: dimension.id })).toBe(model);
  });

  it("keeps source identities stable through table and column renames", () => {
    let model = modelReducer(initial(), {
      type: "rename-column",
      column: "4",
      name: "Net Sales",
    });
    expect(model.columnNames["4"]).toBe("Net Sales");
    expect(model.fact.measures[0]).toMatchObject({
      columnId: "4",
      name: "Net Sales",
    });
    model = modelReducer(model, {
      type: "rename",
      id: "customer",
      name: "dim_account",
    });
    expect(model.fact.foreignKeys[0]).toMatchObject({
      name: "AccountKey",
      dimensionId: "customer",
      sourceColumnId: "2",
    });
    expect(assignments(model)).toEqual(Object.keys(model.columnNames));
  });

  it("retains grain and deduplication options and isolates replacement state", () => {
    let model = modelReducer(initial(), { type: "grain", value: "" });
    model = modelReducer(model, { type: "duplicates", value: true });
    expect(model.fact.grain).toBe("");
    expect(model.removeExactDuplicates).toBe(true);
    const replacement = initial();
    model = modelReducer(model, { type: "replace", model: replacement });
    replacement.fact.measures[0].name = "Changed outside the editor";
    expect(model.fact.measures[0].name).toBe("Sales");
  });

  it("bounds generated foreign-key names and collision suffixes after long renames", () => {
    const longName = "a".repeat(128);
    let model = modelReducer(initial(), {
      type: "rename",
      id: "customer",
      name: longName,
    });
    model = modelReducer(model, { type: "add", id: "another" });
    model = modelReducer(model, {
      type: "rename",
      id: "another",
      name: longName,
    });
    model = {
      ...model,
      columnNames: { ...model.columnNames, "7": "b".repeat(128) },
      unassigned: [...model.unassigned, "7"],
    };
    model = modelReducer(model, {
      type: "move",
      column: "7",
      target: "calendar",
      columnType: "DATE",
    });
    const names = model.fact.foreignKeys.map((key) => key.name);
    expect(names.every((name) => name.length <= 128)).toBe(true);
    expect(new Set(names).size).toBe(names.length);
    expect(modelSchema.safeParse(model).success).toBe(true);
  });
});
