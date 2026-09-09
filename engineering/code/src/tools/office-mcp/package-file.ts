import { readFile, writeFile } from "node:fs/promises";
import JSZip from "jszip";
import { OfficeToolError } from "./errors.ts";
import { attribute, buildXml, childrenOf, parseXml, setChildren, tagName, type XmlNode } from "./xml.ts";

/**
 * A .docx/.pptx is a zip of XML parts. Every editing tool here loads the package, rewrites only the
 * parts it must, and writes the rest back untouched — pictures, themes, styles, embedded fonts and
 * every part this server does not understand survive because they are never re-encoded.
 */
export type OfficePackage = {
  readonly zip: JSZip;
  readonly path: string;
};

export async function openPackage(file: string): Promise<OfficePackage> {
  const bytes = await readFile(file);
  try {
    const zip = await JSZip.loadAsync(bytes);
    return { zip, path: file };
  } catch (error) {
    throw new OfficeToolError("UNSUPPORTED_FORMAT",
      `无法作为 Office 包读取（不是 zip/OOXML 文件？）/ not a readable OOXML package: ${file}` +
      ` (${error instanceof Error ? error.message : String(error)})`);
  }
}

export async function readPartText(pkg: OfficePackage, part: string): Promise<string> {
  const entry = pkg.zip.file(part);
  if (entry === null) {
    throw new OfficeToolError("UNSUPPORTED_FORMAT", `包内缺少部件 / package part missing: ${part} (${pkg.path})`);
  }
  return entry.async("string");
}

export async function readOptionalPartText(pkg: OfficePackage, part: string): Promise<string | null> {
  const entry = pkg.zip.file(part);
  return entry === null ? null : entry.async("string");
}

export async function readPartTree(pkg: OfficePackage, part: string): Promise<XmlNode[]> {
  return parseXml(await readPartText(pkg, part));
}

export function writePartTree(pkg: OfficePackage, part: string, nodes: XmlNode[]): void {
  pkg.zip.file(part, buildXml(nodes));
}

export function removePart(pkg: OfficePackage, part: string): void {
  pkg.zip.remove(part);
}

export async function savePackage(pkg: OfficePackage, outputPath: string): Promise<number> {
  const bytes = await pkg.zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
  await writeFile(outputPath, bytes);
  return bytes.byteLength;
}

/** Resolves a relationship target (`../notesSlides/notesSlide1.xml`) against the part that owns it. */
export function resolveRelationshipTarget(ownerPart: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const segments = ownerPart.split("/").slice(0, -1);
  for (const piece of target.split("/")) {
    if (piece === "." || piece.length === 0) continue;
    if (piece === "..") segments.pop();
    else segments.push(piece);
  }
  return segments.join("/");
}

export type Relationship = { id: string; type: string; target: string };

export function relationshipsPartOf(ownerPart: string): string {
  const segments = ownerPart.split("/");
  const file = segments.pop() ?? "";
  return [...segments, "_rels", `${file}.rels`].join("/");
}

/** The `<Relationship>` elements of a part's `.rels`, in file order; empty when the part has none. */
export async function readRelationships(pkg: OfficePackage, ownerPart: string): Promise<Relationship[]> {
  const tree = await readRelationshipTree(pkg, ownerPart);
  return tree === null ? [] : relationshipsOf(tree);
}

export async function readRelationshipTree(pkg: OfficePackage, ownerPart: string): Promise<XmlNode[] | null> {
  const xml = await readOptionalPartText(pkg, relationshipsPartOf(ownerPart));
  return xml === null ? null : parseXml(xml);
}

function relationshipElements(tree: XmlNode[]): XmlNode[] {
  const root = tree.find((node) => tagName(node) === "Relationships");
  return root === undefined ? [] : childrenOf(root).filter((node) => tagName(node) === "Relationship");
}

export function relationshipsOf(tree: XmlNode[]): Relationship[] {
  const relationships: Relationship[] = [];
  for (const node of relationshipElements(tree)) {
    const id = attribute(node, "Id");
    const type = attribute(node, "Type");
    const target = attribute(node, "Target");
    if (id !== undefined && type !== undefined && target !== undefined) relationships.push({ id, type, target });
  }
  return relationships;
}

/** Drops the named relationships from a `.rels` tree, leaving every other entry byte-identical. */
export function removeRelationships(tree: XmlNode[], relationshipIds: ReadonlySet<string>): void {
  const root = tree.find((node) => tagName(node) === "Relationships");
  if (root === undefined) return;
  setChildren(root, childrenOf(root).filter((node) => {
    if (tagName(node) !== "Relationship") return true;
    const id = attribute(node, "Id");
    return id === undefined || !relationshipIds.has(id);
  }));
}
