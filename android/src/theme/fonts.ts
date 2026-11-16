export type FontWeight = 400 | 600 | 700;
let available = true;
export function setFontsAvailable(value: boolean) { available = value; }
// Choose the first Indic script in reading order for mixed lines. Android supplies
// fallback glyphs for subsequent scripts; do not apply letter spacing to these lines.
function indicFamily(text: string): string | undefined {
  const first = text.match(/[\u0900-\u097F\u0B80-\u0BFF\u0C80-\u0CFF]/)?.[0];
  if (!first) return undefined;
  return first >= '\u0C80' ? 'NotoSansKannada' : first >= '\u0B80' ? 'NotoSansTamil' : 'NotoSansDevanagari';
}
export function fontFor(text: string, weight: FontWeight = 400): string | undefined {
  if (!available) return undefined;
  return `${indicFamily(text) ?? 'Manrope'}_${weight}${weight === 700 ? 'Bold' : weight === 600 ? 'SemiBold' : 'Regular'}`;
}
export function lineHeightFor(text: string, size: number): number {
  return Math.ceil(size * (indicFamily(text) ? 1.5 : 1.4));
}
