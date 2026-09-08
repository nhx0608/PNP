import { OfficeToolError } from "./errors.ts";
import {
  openPackage, readPartTree, readRelationships, readRelationshipTree, relationshipsPartOf, removePart,
  removeRelationships, resolveRelationshipTarget, savePackage, writePartTree, type OfficePackage,
} from "./package-file.ts";
import {
  attribute, childrenOf, cloneNode, element, findChild, findDescendant, flattenText, setChildren, tagName, textNode,
  type XmlNode,
} from "./xml.ts";

const PRESENTATION_PART = "ppt/presentation.xml";
const CONTENT_TYPES_PART = "[Content_Types].xml";
const SLIDE_RELATIONSHIP = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide";
const NOTES_RELATIONSHIP = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide";

export type PptxShape = { shapeId: string; name?: string; placeholder?: string; text: string };
export type PptxSlide = { index: number; part: string; title?: string; notes?: string; texts: PptxShape[] };
export type PptxExtraction = { path: string; slideCount: number; slides: PptxSlide[] };

type SlideReference = { index: number; part: string; relationshipId: string; element: XmlNode };

/**
 * Slide order lives in `p:sldIdLst`, not in the file names: `slide7.xml` can be the second slide of
 * a deck that has been reordered in PowerPoint. Every tool here numbers slides by that list (1-based,
 * what the user sees) and resolves each entry through the presentation's relationships to the part
 * that actually holds it.
 */
async function slideReferences(pkg: OfficePackage, presentation: XmlNode[]): Promise<SlideReference[]> {
  const root = presentation.find((node) => tagName(node) === "p:presentation");
  if (root === undefined) {
    throw new OfficeToolError("UNSUPPORTED_FORMAT", "ppt/presentation.xml 缺少 p:presentation 根元素 / missing p:presentation root");
  }
  const list = findChild(childrenOf(root), "p:sldIdLst");
  if (list === undefined) return [];
  const relationships = await readRelationships(pkg, PRESENTATION_PART);
  const byId = new Map(relationships.map((relationship) => [relationship.id, relationship]));
  const references: SlideReference[] = [];
  for (const entry of childrenOf(list)) {
    if (tagName(entry) !== "p:sldId") continue;
    const relationshipId = attribute(entry, "r:id");
    if (relationshipId === undefined) continue;
    const relationship = byId.get(relationshipId);
    if (relationship === undefined || relationship.type !== SLIDE_RELATIONSHIP) continue;
    references.push({
      index: references.length + 1,
      part: resolveRelationshipTarget(PRESENTATION_PART, relationship.target),
      relationshipId,
      element: entry,
    });
  }
  return references;
}

function slideIdList(presentation: XmlNode[]): XmlNode {
  const root = presentation.find((node) => tagName(node) === "p:presentation");
  const list = root === undefined ? undefined : findChild(childrenOf(root), "p:sldIdLst");
  if (list === undefined) {
    throw new OfficeToolError("UNSUPPORTED_FORMAT", "演示文稿没有幻灯片列表 p:sldIdLst / presentation has no p:sldIdLst");
  }
  return list;
}

function runText(nodes: XmlNode[]): string {
  let out = "";
  for (const node of nodes) {
    const name = tagName(node);
    if (name === null) continue;
    if (name === "a:t") out += flattenText(childrenOf(node));
    else if (name === "a:br") out += "\n";
    else if (name === "a:pPr" || name === "a:rPr" || name === "a:endParaRPr") continue;
    else out += runText(childrenOf(node));
  }
  return out;
}

function textBody(shape: XmlNode): XmlNode | undefined {
  return findChild(childrenOf(shape), "p:txBody");
}

function shapeText(shape: XmlNode): string {
  const body = textBody(shape);
  if (body === undefined) return "";
  return childrenOf(body)
    .filter((node) => tagName(node) === "a:p")
    .map((paragraph) => runText(childrenOf(paragraph)))
    .join("\n");
}

/** Every `p:sp` of a slide, descending into groups so a shape inside a group is still addressable. */
function collectShapes(nodes: XmlNode[], out: XmlNode[]): void {
  for (const node of nodes) {
    const name = tagName(node);
    if (name === "p:sp") out.push(node);
    else if (name === "p:grpSp") collectShapes(childrenOf(node), out);
  }
}

function shapeTree(slide: XmlNode[]): XmlNode[] {
  const root = slide.find((node) => tagName(node) === "p:sld") ?? slide.find((node) => tagName(node) === "p:notes");
  if (root === undefined) return [];
  const common = findChild(childrenOf(root), "p:cSld");
  if (common === undefined) return [];
  const tree = findChild(childrenOf(common), "p:spTree");
  if (tree === undefined) return [];
  const shapes: XmlNode[] = [];
  collectShapes(childrenOf(tree), shapes);
  return shapes;
}

function describeShape(shape: XmlNode): PptxShape {
  const visual = findChild(childrenOf(shape), "p:nvSpPr");
  const properties = visual === undefined ? undefined : findChild(childrenOf(visual), "p:cNvPr");
  const nonVisual = visual === undefined ? undefined : findChild(childrenOf(visual), "p:nvPr");
  const placeholder = nonVisual === undefined ? undefined : findChild(childrenOf(nonVisual), "p:ph");
  const shapeId = properties === undefined ? "" : attribute(properties, "id") ?? "";
  const name = properties === undefined ? undefined : attribute(properties, "name");
  const placeholderType = placeholder === undefined ? undefined : attribute(placeholder, "type") ?? "body";
  const described: PptxShape = { shapeId, text: shapeText(shape) };
  if (name !== undefined && name.length > 0) described.name = name;
  if (placeholderType !== undefined) described.placeholder = placeholderType;
  return described;
}

async function notesText(pkg: OfficePackage, slidePart: string): Promise<string | undefined> {
  const relationships = await readRelationships(pkg, slidePart);
  const notes = relationships.find((relationship) => relationship.type === NOTES_RELATIONSHIP);
  if (notes === undefined) return undefined;
  const part = resolveRelationshipTarget(slidePart, notes.target);
  if (pkg.zip.file(part) === null) return undefined;
  const tree = await readPartTree(pkg, part);
  const text = shapeTree(tree)
    .filter((shape) => {
      const described = describeShape(shape);
      return described.placeholder !== "sldImg" && described.placeholder !== "sldNum" && described.text.trim().length > 0;
    })
    .map((shape) => shapeText(shape))
    .join("\n")
    .trim();
  return text.length === 0 ? undefined : text;
}

export async function pptxExtract(file: string): Promise<PptxExtraction> {
  const pkg = await openPackage(file);
  const presentation = await readPartTree(pkg, PRESENTATION_PART);
  const references = await slideReferences(pkg, presentation);
  const slides: PptxSlide[] = [];
  for (const reference of references) {
    const tree = await readPartTree(pkg, reference.part);
    const shapes = shapeTree(tree).map((shape) => describeShape(shape));
    const titleShape = shapes.find((shape) => shape.placeholder === "title" || shape.placeholder === "ctrTitle");
    const title = titleShape?.text ?? shapes.find((shape) => shape.text.trim().length > 0)?.text.split("\n")[0];
    const notes = await notesText(pkg, reference.part);
    const slide: PptxSlide = {
      index: reference.index,
      part: reference.part,
      texts: shapes.filter((shape) => shape.text.length > 0),
    };
    if (title !== undefined && title.trim().length > 0) slide.title = title.trim();
    if (notes !== undefined) slide.notes = notes;
    slides.push(slide);
  }
  return { path: file, slideCount: slides.length, slides };
}

export type SlideEdit = { slide: number; shapeId?: string; match?: string; text: string };

export type PptxReplaceResult = {
  path: string;
  outputPath: string;
  edits: { slide: number; shapeId: string; previousText: string; text: string }[];
  bytes: number;
};

/**
 * Replaces a shape's text with the caller's, one paragraph per line. The first paragraph's `a:pPr`
 * and the first run's `a:rPr` are cloned onto every new paragraph, so the shape keeps its font,
 * size, colour and bullet settings; per-run formatting inside the old text (one bold word in a
 * sentence) is not reconstructed and is listed as a limitation in the README.
 */
function setShapeText(shape: XmlNode, text: string): void {
  const body = textBody(shape);
  if (body === undefined) {
    throw new OfficeToolError("INVALID_ARGUMENT", "该形状没有文本框，无法写入文本 / shape has no text body");
  }
  const children = childrenOf(body);
  const bodyProperties = findChild(children, "a:bodyPr");
  const listStyle = findChild(children, "a:lstStyle");
  const firstParagraph = findChild(children, "a:p");
  const paragraphProperties = firstParagraph === undefined ? undefined : findChild(childrenOf(firstParagraph), "a:pPr");
  const firstRun = firstParagraph === undefined ? undefined : findDescendant(childrenOf(firstParagraph), "a:r");
  const runProperties = firstRun === undefined ? undefined : findChild(childrenOf(firstRun), "a:rPr");
  const paragraphs = text.split(/\r?\n/).map((line) => {
    const paragraphChildren: XmlNode[] = [];
    if (paragraphProperties !== undefined) paragraphChildren.push(cloneNode(paragraphProperties));
    const runChildren: XmlNode[] = [];
    if (runProperties !== undefined) runChildren.push(cloneNode(runProperties));
    runChildren.push(element("a:t", line.length > 0 ? [textNode(line)] : []));
    paragraphChildren.push(element("a:r", runChildren));
    return element("a:p", paragraphChildren);
  });
  const next: XmlNode[] = [];
  if (bodyProperties !== undefined) next.push(bodyProperties);
  if (listStyle !== undefined) next.push(listStyle);
  next.push(...paragraphs);
  setChildren(body, next);
}

function requireSlide(references: readonly SlideReference[], index: number, label: string): SlideReference {
  if (!Number.isInteger(index) || index < 1 || index > references.length) {
    throw new OfficeToolError("INDEX_OUT_OF_RANGE",
      `${label} 幻灯片序号 ${index} 超出范围 1..${references.length} / slide index out of range`);
  }
  return references[index - 1] as SlideReference;
}

function selectShape(shapes: readonly XmlNode[], edit: SlideEdit, label: string): XmlNode {
  if (edit.shapeId !== undefined && edit.shapeId.length > 0) {
    const found = shapes.find((shape) => describeShape(shape).shapeId === edit.shapeId);
    if (found === undefined) {
      const available = shapes.map((shape) => describeShape(shape).shapeId).join(", ");
      throw new OfficeToolError("NO_MATCH",
        `${label}.shapeId=${edit.shapeId} 在该页不存在；可用 shapeId / no such shape on this slide, available: ${available}`);
    }
    return found;
  }
  const match = edit.match;
  if (match === undefined || match.length === 0) {
    throw new OfficeToolError("INVALID_ARGUMENT", `${label} 必须提供 shapeId 或 match / needs either shapeId or match`);
  }
  const exact = shapes.filter((shape) => shapeText(shape) === match);
  const partial = shapes.filter((shape) => shapeText(shape).includes(match));
  const candidates = exact.length > 0 ? exact : partial;
  if (candidates.length === 0) {
    throw new OfficeToolError("NO_MATCH", `${label}.match 未匹配该页任何形状 / matched no shape on this slide: ${JSON.stringify(match)}`);
  }
  if (candidates.length > 1) {
    const ids = candidates.map((shape) => describeShape(shape).shapeId).join(", ");
    throw new OfficeToolError("AMBIGUOUS_MATCH",
      `${label}.match 匹配到 ${candidates.length} 个形状（shapeId ${ids}），请改用 shapeId /` +
      ` ambiguous match, use shapeId instead: ${JSON.stringify(match)}`);
  }
  return candidates[0] as XmlNode;
}

export async function pptxReplaceText(
  file: string, outputPath: string, edits: readonly SlideEdit[],
): Promise<PptxReplaceResult> {
  if (edits.length === 0) throw new OfficeToolError("INVALID_ARGUMENT", "edits 不能为空 / must contain at least one edit");
  const pkg = await openPackage(file);
  const presentation = await readPartTree(pkg, PRESENTATION_PART);
  const references = await slideReferences(pkg, presentation);
  const trees = new Map<string, XmlNode[]>();
  const applied: PptxReplaceResult["edits"] = [];
  for (const [position, edit] of edits.entries()) {
    const label = `edits[${position}]`;
    const reference = requireSlide(references, edit.slide, label);
    let tree = trees.get(reference.part);
    if (tree === undefined) {
      tree = await readPartTree(pkg, reference.part);
      trees.set(reference.part, tree);
    }
    const shapes = shapeTree(tree);
    const shape = selectShape(shapes, edit, label);
    const previousText = shapeText(shape);
    setShapeText(shape, edit.text);
    applied.push({ slide: edit.slide, shapeId: describeShape(shape).shapeId, previousText, text: edit.text });
  }
  for (const [part, tree] of trees) writePartTree(pkg, part, tree);
  const bytes = await savePackage(pkg, outputPath);
  return { path: file, outputPath, edits: applied, bytes };
}

export type PptxReorderResult = {
  path: string;
  outputPath: string;
  slideCount: number;
  order: number[];
  bytes: number;
};

export async function pptxReorderSlides(
  file: string, outputPath: string, order: readonly number[],
): Promise<PptxReorderResult> {
  const pkg = await openPackage(file);
  const presentation = await readPartTree(pkg, PRESENTATION_PART);
  const references = await slideReferences(pkg, presentation);
  const seen = new Set<number>();
  for (const index of order) {
    if (!Number.isInteger(index) || index < 1 || index > references.length) {
      throw new OfficeToolError("INDEX_OUT_OF_RANGE",
        `order 中的 ${index} 超出范围 1..${references.length} / slide index out of range`);
    }
    if (seen.has(index)) {
      throw new OfficeToolError("INVALID_ARGUMENT", `order 中的 ${index} 重复 / duplicate slide index`);
    }
    seen.add(index);
  }
  if (order.length !== references.length) {
    const missing = references.map((reference) => reference.index).filter((index) => !seen.has(index));
    throw new OfficeToolError("INVALID_ARGUMENT",
      `order 必须列出全部 ${references.length} 页；缺少 ${missing.join(", ")} /` +
      ` order must list every slide exactly once, missing: ${missing.join(", ")}`);
  }
  const list = slideIdList(presentation);
  const nonSlideChildren = childrenOf(list).filter((node) => tagName(node) !== "p:sldId");
  const reordered = order.map((index) => (references[index - 1] as SlideReference).element);
  setChildren(list, [...nonSlideChildren, ...reordered]);
  writePartTree(pkg, PRESENTATION_PART, presentation);
  const bytes = await savePackage(pkg, outputPath);
  return { path: file, outputPath, slideCount: references.length, order: [...order], bytes };
}

export type PptxDeleteResult = {
  path: string;
  outputPath: string;
  deleted: { slide: number; part: string }[];
  remainingSlides: number;
  bytes: number;
};

/** Removes the `Override` entries of parts that no longer exist, so the package stays valid. */
async function dropContentTypeOverrides(pkg: OfficePackage, parts: ReadonlySet<string>): Promise<void> {
  const tree = await readPartTree(pkg, CONTENT_TYPES_PART);
  const root = tree.find((node) => tagName(node) === "Types");
  if (root === undefined) return;
  setChildren(root, childrenOf(root).filter((node) => {
    if (tagName(node) !== "Override") return true;
    const partName = attribute(node, "PartName");
    return partName === undefined || !parts.has(partName.replace(/^\//, ""));
  }));
  writePartTree(pkg, CONTENT_TYPES_PART, tree);
}

export async function pptxDeleteSlides(
  file: string, outputPath: string, slides: readonly number[],
): Promise<PptxDeleteResult> {
  if (slides.length === 0) throw new OfficeToolError("INVALID_ARGUMENT", "slides 不能为空 / must name at least one slide");
  const pkg = await openPackage(file);
  const presentation = await readPartTree(pkg, PRESENTATION_PART);
  const references = await slideReferences(pkg, presentation);
  const targets = [...new Set(slides)].sort((left, right) => left - right)
    .map((index) => requireSlide(references, index, "slides"));
  if (targets.length >= references.length) {
    throw new OfficeToolError("INVALID_ARGUMENT", "不能删除全部幻灯片 / cannot delete every slide of a presentation");
  }
  const removedParts = new Set<string>();
  const removedRelationshipIds = new Set<string>();
  for (const target of targets) {
    removedRelationshipIds.add(target.relationshipId);
    removedParts.add(target.part);
    const relationships = await readRelationships(pkg, target.part);
    for (const relationship of relationships) {
      if (relationship.type === NOTES_RELATIONSHIP) removedParts.add(resolveRelationshipTarget(target.part, relationship.target));
    }
  }
  const list = slideIdList(presentation);
  const keptElements = new Set(references.filter((reference) => !targets.includes(reference)).map((reference) => reference.element));
  setChildren(list, childrenOf(list).filter((node) => tagName(node) !== "p:sldId" || keptElements.has(node)));
  writePartTree(pkg, PRESENTATION_PART, presentation);

  const relationshipTree = await readRelationshipTree(pkg, PRESENTATION_PART);
  if (relationshipTree !== null) {
    removeRelationships(relationshipTree, removedRelationshipIds);
    writePartTree(pkg, relationshipsPartOf(PRESENTATION_PART), relationshipTree);
  }
  for (const part of removedParts) {
    removePart(pkg, part);
    removePart(pkg, relationshipsPartOf(part));
  }
  await dropContentTypeOverrides(pkg, removedParts);
  const bytes = await savePackage(pkg, outputPath);
  return {
    path: file,
    outputPath,
    deleted: targets.map((target) => ({ slide: target.index, part: target.part })),
    remainingSlides: references.length - targets.length,
    bytes,
  };
}
