export type FontWeight = 400 | 600 | 700;
let available = true;
export function setFontsAvailable(value: boolean) { available = value; }
export function fontFor(text: string, weight: FontWeight = 400): string | undefined {
  if (!available) return undefined;
  const family = /[\u0C80-\u0CFF]/.test(text) ? 'NotoSansKannada' :
    /[\u0B80-\u0BFF]/.test(text) ? 'NotoSansTamil' :
    /[\u0900-\u097F]/.test(text) ? 'NotoSansDevanagari' : 'Manrope';
  return `${family}_${weight}${weight === 400 ? 'Regular' : weight === 600 ? 'SemiBold' : 'Bold'}`;
}
