// Formula properties: a small expression language, parsed and evaluated here (never run as code).
//
//   prop("Points") * 2            if(prop("Done"), "✅", "⏳")       dateBetween(prop("Due"), today(), "days")
//   concat(prop("Name"), " — ", format(prop("Score")))              round(prop("Done count") / prop("Total") * 100)
//
// Values are numbers, text, true/false, dates (YYYY-MM-DD text), or lists. Errors are shown in the cell.

export type FValue = number | string | boolean | null | FValue[];

type Node =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'bool'; v: boolean }
  | { k: 'call'; name: string; args: Node[] }
  | { k: 'unary'; op: string; arg: Node }
  | { k: 'bin'; op: string; left: Node; right: Node };

export class FormulaError extends Error {}

// ---------- reading the text ----------

type Token = { t: 'num'; v: number } | { t: 'str'; v: string } | { t: 'id'; v: string } | { t: 'op'; v: string };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
    } else if (/[0-9.]/.test(c)) {
      const m = /^\d*\.?\d+(e[+-]?\d+)?/i.exec(src.slice(i));
      if (!m) throw new FormulaError(`Unexpected “${c}”`);
      out.push({ t: 'num', v: Number(m[0]) });
      i += m[0].length;
    } else if (c === '"' || c === "'" || c === '“' || c === '”') {
      const close = c === '“' ? '”' : c;
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== close && !(close === '"' && src[j] === '”')) {
        if (src[j] === '\\' && j + 1 < src.length) {
          s += src[j + 1] === 'n' ? '\n' : src[j + 1];
          j += 2;
        } else s += src[j++];
      }
      if (j >= src.length) throw new FormulaError('A text in quotes is not closed');
      out.push({ t: 'str', v: s });
      i = j + 1;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ t: 'id', v: m[0] });
      i += m[0].length;
    } else {
      const two = src.slice(i, i + 2);
      if (['==', '!=', '<=', '>=', '&&', '||'].includes(two)) {
        out.push({ t: 'op', v: two });
        i += 2;
      } else if ('+-*/%^(),<>!'.includes(c)) {
        out.push({ t: 'op', v: c });
        i++;
      } else throw new FormulaError(`Unexpected “${c}”`);
    }
  }
  return out;
}

const PRECEDENCE: Record<string, number> = { '||': 1, or: 1, '&&': 2, and: 2, '==': 3, '!=': 3, '<': 4, '>': 4, '<=': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6, '^': 7 };

export function parseFormula(src: string): Node {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (v: string) => {
    const t = peek();
    return !!t && ((t.t === 'op' && t.v === v) || (t.t === 'id' && t.v === v));
  };
  const expect = (v: string) => {
    if (!isOp(v)) throw new FormulaError(`Expected “${v}”`);
    pos++;
  };
  const primary = (): Node => {
    const t = peek();
    if (!t) throw new FormulaError('The formula ends too early');
    if (t.t === 'num') return pos++, { k: 'num', v: t.v };
    if (t.t === 'str') return pos++, { k: 'str', v: t.v };
    if (t.t === 'op' && t.v === '(') {
      pos++;
      const e = expr(0);
      expect(')');
      return e;
    }
    if (t.t === 'op' && (t.v === '-' || t.v === '!')) {
      pos++;
      return { k: 'unary', op: t.v, arg: expr(8) };
    }
    if (t.t === 'id') {
      pos++;
      if (t.v === 'true' || t.v === 'false') return { k: 'bool', v: t.v === 'true' };
      if (t.v === 'not') return { k: 'unary', op: '!', arg: expr(8) };
      if (!isOp('(')) throw new FormulaError(`“${t.v}” needs brackets, e.g. ${t.v}(…)`);
      pos++;
      const args: Node[] = [];
      if (!isOp(')')) {
        args.push(expr(0));
        while (isOp(',')) {
          pos++;
          args.push(expr(0));
        }
      }
      expect(')');
      return { k: 'call', name: t.v, args };
    }
    throw new FormulaError(`Unexpected “${t.v}”`);
  };
  const expr = (min: number): Node => {
    let left = primary();
    for (;;) {
      const t = peek();
      const op = t && (t.t === 'op' || (t.t === 'id' && (t.v === 'and' || t.v === 'or'))) ? t.v : null;
      if (!op || PRECEDENCE[op] === undefined || PRECEDENCE[op] < min) break;
      pos++;
      const right = expr(op === '^' ? PRECEDENCE[op] : PRECEDENCE[op] + 1);
      left = { k: 'bin', op, left, right };
    }
    return left;
  };
  const tree = expr(0);
  if (pos < tokens.length) throw new FormulaError(`Unexpected “${(tokens[pos] as { v: unknown }).v}”`);
  return tree;
}

// ---------- working it out ----------

const DATE = /^\d{4}-\d{2}-\d{2}/;
const toDate = (v: FValue) => (typeof v === 'string' && DATE.test(v) ? new Date(`${v.slice(0, 10)}T00:00:00`) : null);
const fromDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const num = (v: FValue): number => {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === null || v === '') return 0;
  if (Array.isArray(v)) return v.length;
  const n = Number(v);
  if (Number.isNaN(n)) throw new FormulaError(`“${v}” is not a number`);
  return n;
};
export const text = (v: FValue): string =>
  v === null ? '' : Array.isArray(v) ? v.map(text).join(', ') : typeof v === 'number' ? String(Math.round(v * 1e10) / 1e10) : typeof v === 'boolean' ? (v ? 'true' : 'false') : v;
const truthy = (v: FValue) => (Array.isArray(v) ? v.length > 0 : v !== null && v !== '' && v !== 0 && v !== false);
const isEmpty = (v: FValue) => v === null || v === '' || (Array.isArray(v) && v.length === 0);

function addTo(d: Date, n: number, unit: string) {
  const out = new Date(d);
  const u = unit.replace(/s$/, '');
  if (u === 'day') out.setDate(out.getDate() + n);
  else if (u === 'week') out.setDate(out.getDate() + 7 * n);
  else if (u === 'month') out.setMonth(out.getMonth() + n);
  else if (u === 'year') out.setFullYear(out.getFullYear() + n);
  else throw new FormulaError(`Unknown unit “${unit}” (use days, weeks, months or years)`);
  return out;
}

const FUNCTIONS: Record<string, { help: string; fn: (args: FValue[]) => FValue }> = {
  if: { help: 'if(condition, then, otherwise)', fn: () => null }, // handled lazily in evaluate
  ifs: { help: 'ifs(condition1, value1, condition2, value2, …, otherwise)', fn: () => null },
  and: { help: 'and(a, b, …)', fn: (a) => a.every(truthy) },
  or: { help: 'or(a, b, …)', fn: (a) => a.some(truthy) },
  empty: { help: 'empty(value) — true when there is nothing', fn: ([v]) => isEmpty(v ?? null) },
  concat: { help: 'concat(a, b, …) — joins text', fn: (a) => a.map(text).join('') },
  join: { help: 'join(list, ", ")', fn: ([l, sep]) => (Array.isArray(l) ? l.map(text).join(text(sep ?? ', ')) : text(l ?? null)) },
  length: { help: 'length(text or list)', fn: ([v]) => (Array.isArray(v) ? v.length : text(v ?? null).length) },
  lower: { help: 'lower(text)', fn: ([v]) => text(v ?? null).toLowerCase() },
  upper: { help: 'upper(text)', fn: ([v]) => text(v ?? null).toUpperCase() },
  trim: { help: 'trim(text)', fn: ([v]) => text(v ?? null).trim() },
  contains: { help: 'contains(text or list, value)', fn: ([v, x]) => (Array.isArray(v) ? v.some((i) => text(i) === text(x ?? null)) : text(v ?? null).includes(text(x ?? null))) },
  replace: { help: 'replace(text, find, with) — replaces every match', fn: ([v, f, r]) => text(v ?? null).split(text(f ?? null)).join(text(r ?? null)) },
  slice: { help: 'slice(text, start, end)', fn: ([v, s, e]) => text(v ?? null).slice(num(s ?? 0), e === undefined ? undefined : num(e)) },
  repeat: { help: 'repeat(text, times) — e.g. a bar: repeat("█", 5)', fn: ([v, n]) => text(v ?? null).repeat(Math.max(0, Math.min(500, Math.floor(num(n ?? 0))))) },
  format: { help: 'format(value) — as text', fn: ([v]) => text(v ?? null) },
  toNumber: { help: 'toNumber(text)', fn: ([v]) => (isEmpty(v ?? null) ? null : num(v ?? null)) },
  abs: { help: 'abs(n)', fn: ([n]) => Math.abs(num(n ?? 0)) },
  round: { help: 'round(n, decimals)', fn: ([n, d]) => Math.round(num(n ?? 0) * 10 ** num(d ?? 0)) / 10 ** num(d ?? 0) },
  floor: { help: 'floor(n)', fn: ([n]) => Math.floor(num(n ?? 0)) },
  ceil: { help: 'ceil(n)', fn: ([n]) => Math.ceil(num(n ?? 0)) },
  sqrt: { help: 'sqrt(n)', fn: ([n]) => Math.sqrt(num(n ?? 0)) },
  pow: { help: 'pow(n, power)', fn: ([n, p]) => num(n ?? 0) ** num(p ?? 1) },
  min: { help: 'min(a, b, …) or min(list)', fn: (a) => Math.min(...a.flat().filter((v) => !isEmpty(v)).map(num)) },
  max: { help: 'max(a, b, …) or max(list)', fn: (a) => Math.max(...a.flat().filter((v) => !isEmpty(v)).map(num)) },
  sum: { help: 'sum(a, b, …) or sum(list)', fn: (a) => a.flat().filter((v) => !isEmpty(v)).reduce<number>((s, v) => s + num(v), 0) },
  average: { help: 'average(a, b, …) or average(list)', fn: (a) => {
    const vals = a.flat().filter((v) => !isEmpty(v)).map(num);
    return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
  } },
  today: { help: 'today()', fn: () => fromDate(new Date()) },
  now: { help: 'now()', fn: () => new Date().toISOString() },
  dateAdd: { help: 'dateAdd(date, amount, "days" | "weeks" | "months" | "years")', fn: ([d, n, u]) => {
    const date = toDate(d ?? null);
    return date ? fromDate(addTo(date, num(n ?? 0), text(u ?? 'days'))) : null;
  } },
  dateSubtract: { help: 'dateSubtract(date, amount, unit)', fn: ([d, n, u]) => {
    const date = toDate(d ?? null);
    return date ? fromDate(addTo(date, -num(n ?? 0), text(u ?? 'days'))) : null;
  } },
  dateBetween: { help: 'dateBetween(date1, date2, "days" | "weeks" | "months" | "years") — date1 minus date2', fn: ([a, b, u]) => {
    const x = toDate(a ?? null);
    const y = toDate(b ?? null);
    if (!x || !y) return null;
    const unit = text(u ?? 'days').replace(/s$/, '');
    if (unit === 'month' || unit === 'year') {
      const months = (x.getFullYear() - y.getFullYear()) * 12 + (x.getMonth() - y.getMonth());
      return unit === 'year' ? Math.trunc(months / 12) : months;
    }
    const days = Math.round((x.getTime() - y.getTime()) / 86_400_000);
    return unit === 'week' ? Math.trunc(days / 7) : days;
  } },
  formatDate: { help: 'formatDate(date) — e.g. "Mon, 3 Nov"', fn: ([d]) => {
    const date = toDate(d ?? null);
    return date ? date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) : '';
  } },
  day: { help: 'day(date) — day of the month', fn: ([d]) => toDate(d ?? null)?.getDate() ?? null },
  month: { help: 'month(date) — 1 to 12', fn: ([d]) => (toDate(d ?? null)?.getMonth() ?? -1) + 1 || null },
  year: { help: 'year(date)', fn: ([d]) => toDate(d ?? null)?.getFullYear() ?? null },
  weekday: { help: 'weekday(date) — 1 (Monday) to 7 (Sunday)', fn: ([d]) => {
    const date = toDate(d ?? null);
    return date ? ((date.getDay() + 6) % 7) + 1 : null;
  } },
};

export const FUNCTION_HELP = Object.entries(FUNCTIONS).map(([name, f]) => ({ name, help: f.help }));

export interface FormulaContext {
  /** The value of another property of the same card, by name. */
  prop: (name: string) => FValue;
}

export function evaluate(node: Node, ctx: FormulaContext): FValue {
  switch (node.k) {
    case 'num':
    case 'str':
    case 'bool':
      return node.v;
    case 'unary': {
      const v = evaluate(node.arg, ctx);
      return node.op === '-' ? -num(v) : !truthy(v);
    }
    case 'bin': {
      const { op } = node;
      if (op === '&&' || op === 'and') return truthy(evaluate(node.left, ctx)) && truthy(evaluate(node.right, ctx));
      if (op === '||' || op === 'or') return truthy(evaluate(node.left, ctx)) || truthy(evaluate(node.right, ctx));
      const a = evaluate(node.left, ctx);
      const b = evaluate(node.right, ctx);
      switch (op) {
        case '+':
          return typeof a === 'string' || typeof b === 'string' ? text(a) + text(b) : num(a) + num(b);
        case '-':
          return num(a) - num(b);
        case '*':
          return num(a) * num(b);
        case '/':
          if (num(b) === 0) throw new FormulaError('Division by zero');
          return num(a) / num(b);
        case '%':
          return num(a) % num(b);
        case '^':
          return num(a) ** num(b);
        case '==':
          return text(a) === text(b);
        case '!=':
          return text(a) !== text(b);
        default: {
          const both = typeof a === 'number' || typeof b === 'number';
          const [x, y] = both ? [num(a), num(b)] : [text(a), text(b)];
          return op === '<' ? x < y : op === '>' ? x > y : op === '<=' ? x <= y : x >= y;
        }
      }
    }
    case 'call': {
      const name = node.name;
      if (name === 'prop') {
        if (node.args.length !== 1 || node.args[0].k !== 'str') throw new FormulaError('Use prop("Property name")');
        return ctx.prop(node.args[0].v);
      }
      if (name === 'if') {
        if (node.args.length < 2) throw new FormulaError('Use if(condition, then, otherwise)');
        return truthy(evaluate(node.args[0], ctx)) ? evaluate(node.args[1], ctx) : node.args[2] ? evaluate(node.args[2], ctx) : null;
      }
      if (name === 'ifs') {
        for (let i = 0; i + 1 < node.args.length; i += 2) if (truthy(evaluate(node.args[i], ctx))) return evaluate(node.args[i + 1], ctx);
        return node.args.length % 2 ? evaluate(node.args[node.args.length - 1], ctx) : null;
      }
      const f = FUNCTIONS[name];
      if (!f) throw new FormulaError(`There's no function called “${name}”`);
      const result = f.fn(node.args.map((a) => evaluate(a, ctx)));
      if (typeof result === 'number' && !Number.isFinite(result)) return null;
      return result;
    }
  }
}

const cache = new Map<string, Node | FormulaError>();

/** Works out a formula; an error comes back as `{ error }`. */
export function runFormula(src: string, ctx: FormulaContext): { value: FValue } | { error: string } {
  if (!src.trim()) return { value: null };
  let tree = cache.get(src);
  if (!tree) {
    try {
      tree = parseFormula(src);
    } catch (err) {
      tree = err instanceof FormulaError ? err : new FormulaError('Invalid formula');
    }
    if (cache.size > 500) cache.clear();
    cache.set(src, tree);
  }
  if (tree instanceof FormulaError) return { error: tree.message };
  try {
    return { value: evaluate(tree, ctx) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Invalid formula' };
  }
}
