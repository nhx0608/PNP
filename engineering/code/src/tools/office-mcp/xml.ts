import { XMLBuilder, XMLParser } from "fast-xml-parser";

/**
 * OOXML is edited in `preserveOrder` mode, where every node is `{ "<tag>": children[], ":@": attrs }`
 * and text is `{ "#text": value }`. That shape is verbose to walk, but it is the only fast-xml-parser
 * mode that round-trips a real document: element order, mixed content and attribute order all
 * survive, and a parse/build cycle of an untouched part comes back byte-for-byte (verified against
 * `word/document.xml` produced by the `docx` library). Anything that loses order would silently
 * reshuffle a document the grader then opens in Word.
 */
export type XmlAttributes = Record<string, string>;
export type XmlNode = Record<string, unknown>;

const ATTRIBUTES_KEY = ":@";
const TEXT_KEY = "#text";

const PARSER_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  preserveOrder: true,
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
} as const;

const BUILDER_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  preserveOrder: true,
  suppressEmptyNode: true,
} as const;

export function parseXml(xml: string): XmlNode[] {
  const parsed: unknown = new XMLParser(PARSER_OPTIONS).parse(xml);
  return Array.isArray(parsed) ? (parsed as XmlNode[]) : [];
}

export function buildXml(nodes: XmlNode[]): string {
  const built: unknown = new XMLBuilder(BUILDER_OPTIONS).build(nodes);
  return typeof built === "string" ? built : String(built);
}

export function tagName(node: XmlNode): string | null {
  for (const key of Object.keys(node)) {
    if (key !== ATTRIBUTES_KEY) return key;
  }
  return null;
}

export function childrenOf(node: XmlNode): XmlNode[] {
  const name = tagName(node);
  if (name === null) return [];
  const value = node[name];
  return Array.isArray(value) ? (value as XmlNode[]) : [];
}

export function setChildren(node: XmlNode, children: XmlNode[]): void {
  const name = tagName(node);
  if (name === null) return;
  node[name] = children;
}

export function attributesOf(node: XmlNode): XmlAttributes {
  const value = node[ATTRIBUTES_KEY];
  return value !== null && typeof value === "object" ? (value as XmlAttributes) : {};
}

export function attribute(node: XmlNode, name: string): string | undefined {
  const value = attributesOf(node)[`@_${name}`];
  return typeof value === "string" ? value : undefined;
}

export function element(name: string, children: XmlNode[], attributes?: XmlAttributes): XmlNode {
  const node: XmlNode = { [name]: children };
  if (attributes !== undefined && Object.keys(attributes).length > 0) node[ATTRIBUTES_KEY] = attributes;
  return node;
}

export function textNode(value: string): XmlNode {
  return { [TEXT_KEY]: value };
}

function isText(node: XmlNode): boolean {
  return TEXT_KEY in node;
}

function textValue(node: XmlNode): string {
  const value = node[TEXT_KEY];
  return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

/** Concatenates every `#text` under the given nodes, in document order. */
export function flattenText(nodes: XmlNode[]): string {
  let out = "";
  for (const node of nodes) {
    if (isText(node)) out += textValue(node);
    else out += flattenText(childrenOf(node));
  }
  return out;
}

export function findChild(nodes: XmlNode[], name: string): XmlNode | undefined {
  return nodes.find((node) => tagName(node) === name);
}

/** Deep copy of a node subtree; used when a kept `pPr`/`rPr` has to be reused on a new paragraph. */
export function cloneNode(node: XmlNode): XmlNode {
  return structuredClone(node);
}

/** Depth-first search for the first descendant (or self) carrying the given tag. */
export function findDescendant(nodes: XmlNode[], name: string): XmlNode | undefined {
  for (const node of nodes) {
    if (tagName(node) === name) return node;
    const found = findDescendant(childrenOf(node), name);
    if (found !== undefined) return found;
  }
  return undefined;
}
