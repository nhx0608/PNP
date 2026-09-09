import PptxGenJSExport from "pptxgenjs";

/**
 * pptxgenjs ships a single `types/index.d.ts` for both its CommonJS and ESM builds and does not mark
 * the package as ESM, so TypeScript reads that declaration as CommonJS and models the default import
 * as `{ default: PptxGenJS }`, while Node's ESM loader (which takes the `import` condition, an ES
 * module) hands over the class itself. Both shapes are accepted here, once, so the rest of the
 * server can simply call `new PptxGen()`.
 */
type PptxGenConstructor = typeof PptxGenJSExport.default;

const exported: unknown = PptxGenJSExport;

export const PptxGen: PptxGenConstructor = typeof exported === "function"
  ? (exported as PptxGenConstructor)
  : (exported as { default: PptxGenConstructor }).default;

export type PptxDeck = InstanceType<PptxGenConstructor>;
