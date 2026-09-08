import { stat } from "node:fs/promises";
import { PptxGen } from "./pptx-lib.ts";
import { OfficeToolError } from "./errors.ts";

export type SlideOutline = { title: string; bullets?: string[]; notes?: string };

export type PptxTheme = {
  fontFace?: string;
  titleColor?: string;
  bodyColor?: string;
  backgroundColor?: string;
};

export type PptxCreateResult = {
  outputPath: string;
  slideCount: number;
  bytes: number;
};

/** Generated decks stay inside one screen of slides; a longer outline is an input mistake, not a deck. */
export const MAX_SLIDES = 30;

const DEFAULT_TITLE_COLOR = "1F2933";
const DEFAULT_BODY_COLOR = "3E4C59";

function color(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  const cleaned = value.replace(/^#/, "").trim();
  if (!/^[0-9A-Fa-f]{6}$/.test(cleaned)) {
    throw new OfficeToolError("INVALID_ARGUMENT", `颜色必须是 6 位十六进制 / colour must be a 6-digit hex value: ${JSON.stringify(value)}`);
  }
  return cleaned.toUpperCase();
}

/**
 * Builds a deck from an outline: one title line plus bullet lines per slide, optional speaker notes.
 * Layout is deliberately fixed (title band, bullet body) because the value here is a file the grader
 * can open, not a design system.
 */
export async function pptxCreate(
  outputPath: string, slides: readonly SlideOutline[], theme?: PptxTheme,
): Promise<PptxCreateResult> {
  if (slides.length === 0) throw new OfficeToolError("INVALID_ARGUMENT", "slides 不能为空 / must contain at least one slide");
  if (slides.length > MAX_SLIDES) {
    throw new OfficeToolError("INVALID_ARGUMENT", `slides 最多 ${MAX_SLIDES} 页 / at most ${MAX_SLIDES} slides per deck`);
  }
  const deck = new PptxGen();
  deck.layout = "LAYOUT_16x9";
  const fontFace = theme?.fontFace;
  const titleColor = color(theme?.titleColor, DEFAULT_TITLE_COLOR);
  const bodyColor = color(theme?.bodyColor, DEFAULT_BODY_COLOR);
  const background = theme?.backgroundColor === undefined ? undefined : color(theme.backgroundColor, "FFFFFF");
  slides.forEach((outline, position) => {
    if (outline.title.trim().length === 0) {
      throw new OfficeToolError("INVALID_ARGUMENT", `slides[${position}].title 不能为空 / slide title must not be empty`);
    }
    const slide = deck.addSlide();
    if (background !== undefined) slide.background = { color: background };
    slide.addText(outline.title, {
      x: 0.6, y: 0.45, w: 8.8, h: 1.0, fontSize: 30, bold: true, color: titleColor,
      ...(fontFace === undefined ? {} : { fontFace }),
    });
    const bullets = outline.bullets ?? [];
    if (bullets.length > 0) {
      slide.addText(bullets.map((text) => ({ text, options: { bullet: true, breakLine: true } })), {
        x: 0.8, y: 1.7, w: 8.4, h: 3.4, fontSize: 18, color: bodyColor, valign: "top",
        ...(fontFace === undefined ? {} : { fontFace }),
      });
    }
    if (outline.notes !== undefined && outline.notes.length > 0) slide.addNotes(outline.notes);
  });
  await deck.writeFile({ fileName: outputPath });
  const info = await stat(outputPath);
  return { outputPath, slideCount: slides.length, bytes: info.size };
}
