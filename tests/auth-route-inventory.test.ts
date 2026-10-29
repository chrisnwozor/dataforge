import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
const root = process.cwd();
function walk(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(path, e.name)) : [join(path, e.name)],
  );
}
const publicRoutes = new Set([
  "app/api/health/route.ts",
  "app/api/auth/me/route.ts",
  ...[
    "sign-in",
    "sign-up",
    "verify",
    "forgot-password",
    "reset-password",
    "resend-verification",
  ].map((p) => `app/api/auth/${p}/route.ts`),
]);
const publicPages = new Set(
  [
    "sign-in",
    "sign-up",
    "verify",
    "forgot-password",
    "reset-password",
    "invite",
  ].map((p) => `app/${p}/page.tsx`),
);
const approved = new Set([
  "withProjectRoute",
  "withWorkspaceRoute",
  "withUserRoute",
  "publicRoute",
  "withProjectPage",
  "withWorkspacePage",
  "withUserPage",
  "publicPage",
]);
function inspect(file: string): string[] {
  const source = readFileSync(file, "utf8"),
    sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true),
    path = relative(root, file).replaceAll("\\", "/"),
    errors: string[] = [];
  const imports = new Set<string>();
  for (const node of sf.statements)
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === "@/lib/auth/guards" &&
      node.importClause?.namedBindings &&
      ts.isNamedImports(node.importClause.namedBindings)
    ) {
      for (const el of node.importClause.namedBindings.elements)
        if (!el.propertyName && approved.has(el.name.text))
          imports.add(el.name.text);
    }
  let protectedExports = 0;
  function check(expression: ts.Expression, label: string) {
    if (
      !ts.isCallExpression(expression) ||
      !ts.isIdentifier(expression.expression) ||
      !imports.has(expression.expression.text)
    ) {
      errors.push(
        `${path}: ${label} must be wrapped by an approved guard imported from lib/auth/guards`,
      );
      return;
    }
    const guard = expression.expression.text;
    if (
      (guard === "publicRoute" && !publicRoutes.has(path)) ||
      (guard === "publicPage" && !publicPages.has(path))
    )
      errors.push(`${path}: not on the explicit public allowlist`);
    if (
      path.startsWith("app/api/projects/[id]/") &&
      guard !== "withProjectRoute"
    )
      errors.push(`${path}: project route needs withProjectRoute`);
    if (path.startsWith("app/projects/[id]/") && guard !== "withProjectPage")
      errors.push(`${path}: project page needs withProjectPage`);
    protectedExports++;
  }
  for (const node of sf.statements) {
    if (ts.isExportAssignment(node)) check(node.expression, "default export");
    if (
      ts.isVariableStatement(node) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    )
      for (const d of node.declarationList.declarations)
        if (
          ts.isIdentifier(d.name) &&
          /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(d.name.text)
        ) {
          if (d.initializer) check(d.initializer, d.name.text);
          else errors.push(`${path}: uninitialized handler`);
        }
    if (
      ts.isFunctionDeclaration(node) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
      (node.modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) ||
        /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(
          node.name?.text || "",
        ))
    )
      errors.push(`${path}: unwrapped exported function`);
    if (ts.isExportDeclaration(node) && node.moduleSpecifier)
      errors.push(`${path}: re-exported handlers cannot bypass the inventory`);
  }
  if (!protectedExports) errors.push(`${path}: no guarded export found`);
  return errors;
}
describe("CI authentication boundary inventory", () => {
  it("guards every API method and app page, with explicit public exceptions", () => {
    const files = walk(join(root, "app")).filter(
      (p) =>
        p.endsWith("/page.tsx") ||
        (p.includes("/api/") && p.endsWith("/route.ts")) ||
        p.endsWith("/projects/[id]/layout.tsx"),
    );
    expect(files.length).toBeGreaterThan(80);
    expect(files.flatMap(inspect)).toEqual([]);
  });
  it("does not hide server actions outside the inventory", () => {
    const files = [
      ...walk(join(root, "app")),
      ...walk(join(root, "components")),
    ].filter((p) => /\.[tj]sx?$/.test(p));
    expect(
      files.filter((p) =>
        /^[\s]*["']use server["']/m.test(readFileSync(p, "utf8")),
      ),
    ).toEqual([]);
  });
});
