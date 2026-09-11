#!/usr/bin/env tsx
/**
 * Enforcement for plan §5's vocabulary rename. The plan calls for "a CI check
 * (Playwright text scan across every non-admin route, plus a lint rule
 * flagging these literals in components/ and app/(app)/)". This repo has no
 * Playwright/e2e harness and no test runner at all (see scripts/verify-
 * templates.ts for the established pattern of standing in for that with a
 * plain script), so rather than bring in new test infrastructure just for
 * this check, this does the "lint rule" half for real — parsing every .tsx
 * file under app/(app) and components with the TypeScript compiler API and
 * scanning only rendered JSX text and a curated set of user-visible JSX
 * attributes (placeholder/title/aria-label/alt) — and treats that as the
 * practical substitute for the route-level scan too, since those are exactly
 * the strings a route would render. Imports, identifiers, and code comments
 * are never visited, so `PomodoroTimer` the component and `Checkpoint` the
 * type stay untouched, matching plan §5's "not renamed: TypeScript
 * identifiers" boundary. app/(admin) is out of scope by construction (only
 * app/(app) is walked).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";

const ROOTS = ["app/(app)", "components"];
const VISIBLE_ATTRS = new Set([
  "placeholder",
  "title",
  "aria-label",
  "alt",
  "label",
  "eyebrow",
  "sentence",
  "empty"
]);

// plan §5's table, left column — every retired term that must not appear in rendered UI text.
// Rows marked "(unchanged)" in the plan (Behind/Light day/On track/Ahead/Overrun, Grades, Break
// mode) are deliberately absent — they were never retired. "Slot" and "Checkpoint" ARE included
// even though they're also live TypeScript identifiers (`ScheduleSlot`, `Checkpoint`) — that's
// safe here specifically because the scanner only visits rendered JsxText and a curated set of
// visible JSX attributes, never import specifiers, JSX tag names, or `.property` access, so an
// identifier never enters the text this scan actually reads.
const RETIRED_TERMS: { pattern: RegExp; replacement: string }[] = [
  { pattern: /\bLoad Index\b/i, replacement: "Workload" },
  { pattern: /\bRequired minutes\b/i, replacement: "Planned" },
  { pattern: /\bActual minutes\b/i, replacement: "Done" },
  { pattern: /\bDebt\b/, replacement: "Catch-up hours" },
  { pattern: /\bCoverage\b/, replacement: "Topics revised" },
  { pattern: /\bNext Action\b/i, replacement: "Up next" },
  { pattern: /\bCheckpoints?\b/, replacement: "Assessment(s)" },
  { pattern: /\bSlots?\b/, replacement: "Block(s)" },
  { pattern: /\bClass log\b/i, replacement: "Log a class" },
  { pattern: /\bTopic confidence\b/i, replacement: "Understanding" },
  { pattern: /\bRevision (item|ladder|queue)\b/i, replacement: "Revision card / revision schedule / today's revision" },
  { pattern: /\bPass 1\b/, replacement: "Skim" },
  { pattern: /\bPass 2\b/, replacement: "Read" },
  { pattern: /\bPass 3\b/, replacement: "Deep dive" },
  { pattern: /\bReading goal\b/i, replacement: "Why am I reading this?" },
  { pattern: /\bPaper group\b/i, replacement: "Paper set" },
  { pattern: /\bsurvey mode\b/i, replacement: "Literature survey" },
  { pattern: /\bGroup synthesis\b/i, replacement: "What connects these papers?" },
  { pattern: /\bLayered notes\b/i, replacement: "Layered summary" },
  { pattern: /\bHighlight candidates\b/i, replacement: "Suggested highlights" },
  { pattern: /\bBreak-mode template\b/i, replacement: "Break-day template" },
  { pattern: /\bWorkday session\b/i, replacement: "Your day" },
  { pattern: /\bPomodoros?\b/i, replacement: "Focus session(s)" },
  { pattern: /\bDaily [Rr]eview\b/, replacement: "Daily wrap-up" },
  { pattern: /\bWeekly [Rr]eview\b/, replacement: "Weekly check-in" },
  { pattern: /\bMorning brief\b/i, replacement: "Morning overview" },
  { pattern: /\bEvening rollup\b/i, replacement: "Suggestions for tomorrow" },
  { pattern: /\bproposed (tasks|slots)\b/i, replacement: "suggested tasks / blocks" },
  { pattern: /\bExternal (task|deadline)\b/i, replacement: "Hard deadline" },
  { pattern: /\bdefault template\b/i, replacement: "Workday template" }
];

// The one-time "We renamed a few things" notice (plan §10.2) legitimately shows old terms next
// to their replacements — that's its entire purpose, not a missed rename.
const EXCLUDED_FILES = new Set(["components/vocabulary-rename-dialog.tsx"]);

function collectTsxFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && full.endsWith(".tsx") && !EXCLUDED_FILES.has(full)) out.push(full);
    }
  }
  return out;
}

function extractVisibleText(filePath: string): { text: string; line: number }[] {
  const source = fs.readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: { text: string; line: number }[] = [];

  function lineOf(node: ts.Node): number {
    return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  }

  function visit(node: ts.Node) {
    if (ts.isJsxText(node)) {
      const text = node.getText(sourceFile);
      if (text.trim()) found.push({ text, line: lineOf(node) });
    } else if (ts.isJsxAttribute(node) && VISIBLE_ATTRS.has(node.name.getText(sourceFile))) {
      const init = node.initializer;
      if (init && ts.isStringLiteral(init)) found.push({ text: init.text, line: lineOf(node) });
    } else if (
      ts.isJsxExpression(node) &&
      node.expression &&
      ts.isStringLiteral(node.expression) &&
      (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))
    ) {
      found.push({ text: node.expression.text, line: lineOf(node) });
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return found;
}

const failures: string[] = [];
for (const root of ROOTS) {
  for (const file of collectTsxFiles(root)) {
    for (const { text, line } of extractVisibleText(file)) {
      for (const { pattern, replacement } of RETIRED_TERMS) {
        const match = text.match(pattern);
        if (match) {
          failures.push(`${file}:${line} — retired term "${match[0]}" (use "${replacement}"): ${text.trim().slice(0, 80)}`);
        }
      }
    }
  }
}

if (failures.length > 0) {
  console.error(`verify-vocabulary: ${failures.length} retired term(s) found in rendered UI text:\n`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log("verify-vocabulary: no retired terms found in rendered app/(app) or components JSX text/visible attributes.");
