// ADR 0014 6.9: los cierres de RunClose (end, keepStopped, keepPlan, materialize) se llaman desde fuera de run-close.ts
// solo por los delegados de Runtime, y el cableado los pasa con enlace tardío (`(...a) => this.end(...a)`). Un test
// que parchea Runtime.end solo intercepta si nadie llama a `close.end` directo ni recibe el RunClose o un método suyo
// sin enlazar. Hoy se cumple; aquí se mide sobre el AST de src/runtime para que siga así.
import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from '../templates/base-scaffold/node_modules/typescript';

const SRC = join(import.meta.dir, '..', 'src', 'runtime');
const CLOSES = new Set(['end', 'keepStopped', 'keepPlan', 'materialize']);
// run-close.ts es la implementación: sus llamadas internas a this.end son el cierre mismo, no un cableado.
const FILES = readdirSync(SRC).filter((f) => f.endsWith('.ts') && f !== 'run-close.ts');

/** El nombre del método de clase que envuelve al nodo, o undefined fuera de uno. */
function enclosingMethod(n: ts.Node): string | undefined {
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) if (ts.isMethodDeclaration(p)) return p.name.getText();
  return undefined;
}

/** `close`, `this.close`, `deps.close`, `this.deps.close`: cualquier receptor que nombre al RunClose. */
const isClose = (e: ts.Expression): boolean => (ts.isIdentifier(e) && e.text === 'close') || (ts.isPropertyAccessExpression(e) && e.name.text === 'close');

/** El inicializador de una clave del cableado es `(…) => this.<name>(…)`, con o sin llaves. */
function lateBound(init: ts.Expression, name: string): boolean {
  if (!ts.isArrowFunction(init)) return false;
  let call: ts.Node | undefined = init.body;
  if (ts.isBlock(init.body)) {
    const only = init.body.statements[0];
    call = init.body.statements.length === 1 && only ? (ts.isExpressionStatement(only) ? only.expression : ts.isReturnStatement(only) ? only.expression : undefined) : undefined;
  }
  return !!call && ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression) && call.expression.expression.kind === ts.SyntaxKind.ThisKeyword && call.expression.name.text === name;
}

function violations(file: string, text: string): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true);
  const out: string[] = [];
  const at = (n: ts.Node, what: string) => out.push(`${file}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1} ${what}: ${n.getText().slice(0, 80)}`);
  const visit = (n: ts.Node): void => {
    // close.end / this.close.keepPlan / deps.close.materialize, llamado o pasado como valor: solo en el delegado homónimo.
    if (ts.isPropertyAccessExpression(n) && CLOSES.has(n.name.text) && isClose(n.expression)) {
      if (!(file === 'server.ts' && enclosingMethod(n) === n.name.text)) at(n, 'cierre directo de RunClose');
    }
    if (ts.isElementAccessExpression(n) && isClose(n.expression)) at(n, 'cierre de RunClose por índice');
    // const { end } = this.close
    if (ts.isVariableDeclaration(n) && ts.isObjectBindingPattern(n.name) && n.initializer && isClose(n.initializer)) at(n, 'desestructura RunClose');
    // El RunClose entero como valor (`close: this.close`, `fn(this.close)`) deja que otro llame sus cierres directo.
    if (file === 'server.ts' && ts.isPropertyAccessExpression(n) && n.name.text === 'close' && n.expression.kind === ts.SyntaxKind.ThisKeyword) {
      const p = n.parent;
      const member = ts.isPropertyAccessExpression(p) && p.expression === n;
      const assigned = ts.isBinaryExpression(p) && p.left === n && p.operatorToken.kind === ts.SyntaxKind.EqualsToken;
      if (!member && !assigned) at(n, 'RunClose entregado como valor');
    }
    // Cableado: toda clave end/keepStopped/keepPlan/materialize de un objeto en transport.ts es `(...a) => this.<clave>(...a)`.
    if (file === 'server.ts' && ts.isPropertyAssignment(n) && CLOSES.has(n.name.getText()) && !lateBound(n.initializer, n.name.getText())) at(n, 'cableado sin enlace tardío');
    if (file === 'server.ts' && ts.isShorthandPropertyAssignment(n) && CLOSES.has(n.name.text)) at(n, 'cableado sin enlace tardío');
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

test('6.9: fuera de run-close.ts, los cierres de RunClose solo se llaman desde los delegados de Runtime', () => {
  expect(FILES).toContain('server.ts');
  const found = FILES.flatMap((f) => violations(f, readFileSync(join(SRC, f), 'utf8')));
  expect(found).toEqual([]);
});

test('6.9: el escáner ve cada forma de saltarse el delegado', () => {
  const t = (body: string) => violations('server.ts', `class Runtime {\n${body}\n}`);
  expect(t('private end(...a) { this.close.end(...a); }\nprivate keepPlan(...a) { return this.close.keepPlan(...a); }\nwire() { return { end: (...a) => this.end(...a), keepPlan: (...a) => { return this.keepPlan(...a); } }; }')).toEqual([]);
  expect(t('wire() { return { end: (...a) => this.close.end(...a) }; }')).toHaveLength(2);
  expect(t('wire() { return { end: this.end }; }')).toHaveLength(1);
  expect(t('wire() { return { keepStopped: this.close.keepStopped.bind(this.close) }; }').length).toBeGreaterThan(0);
  expect(t('wire() { return { close: this.close }; }')).toHaveLength(1);
  expect(t('private end(...a) { this.close.keepPlan(...a); }')).toHaveLength(1);
  expect(violations('run-cycle.ts', 'class C { f() { this.deps.close.materialize(1); const { end } = this.deps.close; } }')).toHaveLength(2);
});
