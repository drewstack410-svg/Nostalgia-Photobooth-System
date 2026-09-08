export const FONT_FILE_ACCEPT = ".woff2,.woff,.ttf,.otf";

export interface ImportedFont {
  id: string;
  family: string;
  dataUrl: string;
}

export function isFontFile(file: File): boolean {
  return file.type.startsWith("font/") || /\.(woff2?|ttf|otf)$/i.test(file.name);
}

export function familyNameFromFileName(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, "").replace(/[_]+/g, " ").trim();
  const cleaned = base.replace(/["']/g, "").replace(/\s+/g, " ").slice(0, 60);
  return cleaned || "Custom Font";
}

export function cssFontFamilyForImported(family: string): string {
  const safe = family.replace(/\\/g, "").replace(/"/g, "");
  return `"${safe}", sans-serif`;
}

/** Get @font-face format from a data URL (e.g. data:font/woff2;base64,...) */
export function getFontFormat(dataUrl: string): string {
  const fontMatch = dataUrl.match(/^data:font\/(\w+);/);
  if (fontMatch) {
    const subtype = fontMatch[1].toLowerCase();
    if (subtype === "ttf") return "truetype";
    if (subtype === "otf") return "opentype";
    return subtype;
  }
  const appMatch = dataUrl.match(/^data:application\/(?:x-)?font-(\w+);/);
  if (appMatch) {
    const subtype = appMatch[1].toLowerCase();
    if (subtype === "ttf" || subtype === "truetype") return "truetype";
    if (subtype === "otf" || subtype === "opentype") return "opentype";
    return subtype;
  }
  const nameMatch = dataUrl.match(/^data:[^;]+;base64,/);
  if (nameMatch) return "woff2";
  return "woff2";
}

export function fontFaceCss(family: string, dataUrl: string, maxWeight = 900): string {
  const format = getFontFormat(dataUrl);
  const safeUrl = dataUrl.replace(/"/g, '\\"');
  const safeFamily = family.replace(/\\/g, "").replace(/"/g, "");
  return `
@font-face {
  font-family: "${safeFamily}";
  src: url("${safeUrl}") format("${format}");
  font-style: normal;
  font-weight: 400 ${maxWeight};
  font-display: swap;
}`;
}

export function parseImportedFonts(raw: unknown): ImportedFont[] {
  if (!Array.isArray(raw)) return [];
  const out: ImportedFont[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.id !== "string" || !rec.id.trim()) continue;
    if (typeof rec.family !== "string" || !rec.family.trim()) continue;
    if (typeof rec.dataUrl !== "string" || !rec.dataUrl.startsWith("data:")) continue;
    out.push({
      id: rec.id.trim(),
      family: rec.family.trim().slice(0, 60),
      dataUrl: rec.dataUrl,
    });
  }
  return out;
}
