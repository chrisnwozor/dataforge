import { z } from "zod";
import type { CheckResult, CheckSettings, CheckValue } from "./types";
const checkValue: z.ZodType<CheckValue> = z.lazy(() =>
  z.union([
    z.string().max(100000),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(checkValue).max(1000),
    z.record(z.string(), checkValue),
  ]),
);
export const checkSettingsSchema: z.ZodType<CheckSettings> = z
  .object({
    version: z.literal(1).default(1),
    autoAfterLoad: z.boolean().default(false),
    absoluteTolerance: z.number().finite().min(0).max(100).default(0.01),
    relativeTolerance: z.number().finite().min(0).max(0.01).default(0.000001),
  })
  .strict();
export const checkResultSchema: z.ZodType<CheckResult> = z
  .object({
    id: z.string().min(1).max(300),
    area: z.enum(["Ingestion", "Semantic", "Reports", "Dashboards"]),
    name: z.string().min(1).max(1000),
    status: z.enum(["pass", "warn", "fail", "skipped"]),
    expected: checkValue,
    actual: checkValue,
    difference: z.number().finite().nullable(),
    tolerance: z.number().finite().nonnegative(),
    elapsedMs: z.number().finite().nonnegative(),
    explanation: z.string().max(20000),
    nextStep: z.string().max(10000),
    sql: z.string().max(1000000),
    referenceSql: z.string().max(1000000).optional(),
  })
  .strict();
export const checkCountsSchema = z
  .object({
    pass: z.number().int().nonnegative(),
    warn: z.number().int().nonnegative(),
    fail: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
  })
  .strict();
