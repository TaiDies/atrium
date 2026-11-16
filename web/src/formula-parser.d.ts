// The parts of @fortune-sheet/formula-parser (it ships no types) that the spreadsheet import uses.
declare module '@fortune-sheet/formula-parser' {
  export class Parser {
    parse(formula: string): { error: string | null; result: unknown };
    on(event: string, handler: (...args: never[]) => void): void;
  }
}
