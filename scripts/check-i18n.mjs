import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const projectRoot = path.resolve(import.meta.dirname, "..");
const sourceRoot = path.join(projectRoot, "src");
const i18nPath = path.join(sourceRoot, "lib", "i18n.tsx");
const hanPattern = /\p{Script=Han}/u;
const normalize = (value) => value.replace(/\s+/g, " ").trim();

function sourceFile(filePath) {
  return ts.createSourceFile(
    filePath,
    fs.readFileSync(filePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function findTranslationValues() {
  const file = sourceFile(i18nPath);
  const values = new Set();

  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(file) === "ZH_CN_TRANSLATIONS" &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const property of node.initializer.properties) {
        if (
          ts.isPropertyAssignment(property) &&
          (ts.isStringLiteral(property.initializer) ||
            ts.isNoSubstitutionTemplateLiteral(property.initializer))
        ) {
          values.add(normalize(property.initializer.text));
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(file);
  return values;
}

function listSourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listSourceFiles(fullPath);
    if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\.(ts|tsx)$/.test(entry.name)) return [];
    return [fullPath];
  });
}

function collectChineseLiterals(node, file, output) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    const value = normalize(node.text);
    if (hanPattern.test(value)) {
      output.push({ value, line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
    }
  }
  ts.forEachChild(node, (child) => collectChineseLiterals(child, file, output));
}

const translations = findTranslationValues();
const missing = [];

for (const filePath of listSourceFiles(sourceRoot)) {
  if (filePath === i18nPath) continue;
  const file = sourceFile(filePath);
  const candidates = [];

  function visit(node) {
    if (ts.isJsxText(node)) {
      const value = normalize(node.getText(file));
      if (hanPattern.test(value)) {
        candidates.push({
          value,
          line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        });
      }
    } else if (
      ts.isJsxAttribute(node) &&
      node.initializer &&
      ts.isStringLiteral(node.initializer)
    ) {
      collectChineseLiterals(node.initializer, file, candidates);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(file);
      if (
        callee === "window.confirm" ||
        callee === "sendNotification" ||
        callee === "toast" ||
        callee.startsWith("toast.")
      ) {
        for (const argument of node.arguments) {
          collectChineseLiterals(argument, file, candidates);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(file);
  for (const candidate of candidates) {
    if (!translations.has(candidate.value)) {
      missing.push({
        ...candidate,
        file: path.relative(projectRoot, filePath).replaceAll("\\", "/"),
      });
    }
  }
}

if (missing.length > 0) {
  console.error("User-facing Chinese strings missing from the en-US/zh-CN catalog:");
  for (const item of missing) {
    console.error(`  ${item.file}:${item.line} ${JSON.stringify(item.value)}`);
  }
  process.exit(1);
}

console.log(`i18n coverage check passed (${translations.size} zh-CN catalog values).`);
