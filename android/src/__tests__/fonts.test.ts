import { fontFor, setFontsAvailable } from '@/theme/fonts';
test.each([
  ['\u0c95\u0ca8\u0ccd\u0ca8\u0ca1', 'NotoSansKannada'],
  ['\u0ba4\u0bae\u0bbf\u0bb4\u0bcd', 'NotoSansTamil'],
  ['\u0939\u093f\u0928\u094d\u0926\u0940', 'NotoSansDevanagari'],
  ['English', 'Manrope'], ['Hello \u0c95', 'NotoSansKannada'], ['Hello \u0ba4', 'NotoSansTamil'], ['Hello \u0939', 'NotoSansDevanagari']
])('selects script family for %s', (text, family) => {
  expect(fontFor(text)).toBe(`${family}_400Regular`);
  expect(fontFor(text, 600)).toBe(`${family}_600SemiBold`);
  expect(fontFor(text, 700)).toBe(`${family}_700Bold`);
});
test('font failure falls back to system fonts', () => {
  setFontsAvailable(false); expect(fontFor('Hello')).toBeUndefined(); setFontsAvailable(true);
});
