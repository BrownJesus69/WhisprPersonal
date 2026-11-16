import { light, dark } from '@/theme/colors';
import { contrastRatio } from '@/theme/contrast';
test.each([light, dark])('theme meets AA for reading and controls', theme => {
  for (const [a,b] of [['text','background'],['text','surface'],['muted','background'],['onPrimary','primary'],['onRecord','record']] as const) {
    expect(contrastRatio(theme[a], theme[b])).toBeGreaterThanOrEqual(4.5);
  }
});
test('black on white is 21:1', () => expect(contrastRatio('#000000', '#FFFFFF')).toBe(21));
