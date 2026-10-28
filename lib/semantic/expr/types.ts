import type {
  SemanticColumn,
  SemanticMeasure,
  SemanticTable,
  SemanticType,
} from "../types";

export type ExprType = SemanticType | "null" | "filter" | "period" | "star";
export type Period = "MONTH" | "QUARTER" | "YEAR";
export type BinaryOperator =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "="
  | "<>"
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "AND"
  | "OR";
export interface Span {
  pos: number;
  end: number;
}
export type Expr = Span &
  (
    | { kind: "literal"; value: string | number | boolean | null }
    | { kind: "column"; tableName: string; columnName: string }
    | { kind: "measure"; name: string }
    | { kind: "unary"; op: "+" | "-" | "NOT"; operand: Expr }
    | { kind: "binary"; op: BinaryOperator; left: Expr; right: Expr }
    | { kind: "in"; expression: Expr; values: Expr[]; negated: boolean }
    | { kind: "call"; name: string; args: Expr[] }
    | { kind: "period"; value: Period }
    | { kind: "star" }
  );
export type ResolvedExpr = Span & { type: ExprType } & (
    | { kind: "literal"; value: string | number | boolean | null }
    | { kind: "column"; table: SemanticTable; column: SemanticColumn }
    | { kind: "measure"; measure: SemanticMeasure; expression: ResolvedExpr }
    | { kind: "unary"; op: "+" | "-" | "NOT"; operand: ResolvedExpr }
    | {
        kind: "binary";
        op: BinaryOperator;
        left: ResolvedExpr;
        right: ResolvedExpr;
      }
    | {
        kind: "in";
        expression: ResolvedExpr;
        values: ResolvedExpr[];
        negated: boolean;
      }
    | { kind: "call"; name: string; args: ResolvedExpr[] }
    | { kind: "period"; value: Period }
    | { kind: "star" }
  );

export interface ExpressionIssue {
  message: string;
  position: number;
  end: number;
  suggestion?: string;
}
export class ExpressionError extends Error {
  readonly position: number;
  readonly end: number;
  readonly suggestion?: string;
  constructor(
    message: string,
    position = 0,
    end = position + 1,
    suggestion?: string,
  ) {
    super(
      `${message} (position ${position + 1})${suggestion ? ` Did you mean ${suggestion}?` : ""}`,
    );
    this.name = "ExpressionError";
    this.position = position;
    this.end = end;
    this.suggestion = suggestion;
  }
  toIssue(): ExpressionIssue {
    return {
      message: this.message,
      position: this.position,
      end: this.end,
      ...(this.suggestion ? { suggestion: this.suggestion } : {}),
    };
  }
}
