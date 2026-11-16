import { fontFor, type FontWeight } from './fonts';

type Weight = '400' | '600' | '700';
/**
 * Bundled fonts encode the weight in the family name (e.g. Manrope_700Bold). On Android, also
 * setting fontWeight on such a family can make React Native fall back to the system font, so
 * fontWeight is only set when the bundled fonts are unavailable.
 */
function role(fontSize: number, lineHeight: number, weight: FontWeight) {
  return {
    fontSize, lineHeight,
    get fontFamily() { return fontFor('', weight); },
    get fontWeight(): Weight | undefined { return fontFor('', weight) ? undefined : String(weight) as Weight; }
  };
}

export const typography = {
  title: role(26, 32, 700),
  heading: role(20, 28, 600),
  body: role(16, 24, 400),
  transcript: role(19, 30, 400),
  label: role(14, 20, 600),
  caption: role(13, 18, 400)
};
