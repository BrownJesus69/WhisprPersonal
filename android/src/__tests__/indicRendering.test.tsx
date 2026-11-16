import { render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { TranscriptRow } from '@/components/TranscriptRow';
import { BriefEditor } from '@/components/BriefEditor';
import { fontFor, lineHeightFor } from '@/theme/fonts';
import type { BriefDraft } from '@/lib/ai/types';
const examples = [
  ['ನಾಳೆ ಬೆಳಗ್ಗೆ ಹತ್ತು ಗಂಟೆಗೆ ಸಭೆ ಇದೆ, ದಯವಿಟ್ಟು ಎಲ್ಲರೂ ಸಮಯಕ್ಕೆ ಬನ್ನಿ; ನಾವು ಮುಂದಿನ ಕೆಲಸಗಳ ಬಗ್ಗೆ ಮಾತನಾಡೋಣ.', 'NotoSansKannada'],
  ['நாளை காலை பத்து மணிக்கு கூட்டம் இருக்கிறது; அனைவரும் நேரத்திற்கு வந்து அடுத்த வேலைகளைப் பற்றி பேசுவோம்.', 'NotoSansTamil'],
  ['कल सुबह दस बजे बैठक है, कृपया सभी समय पर आएं। हम अगले सप्ताह के काम की योजना बनाएंगे।', 'NotoSansDevanagari'],
  ['Meeting at 10 ನಾಳೆ, please confirm. फिर हम आगे बढ़ेंगे, நன்றி.', 'NotoSansKannada'],
  ['पहले हिंदी, ನಂತರ ಕನ್ನಡ, and English at the end.', 'NotoSansDevanagari'],
] as const;
test.each(examples)('renders readable transcript and brief: %s', async (text, family) => {
  expect(fontFor(text)).toBe(`${family}_400Regular`); expect(lineHeightFor(text, 19)).toBe(29);
  const view = await render(<TranscriptRow row={{ text, sequence: 0, startMs: 0, revision: 0 }} />);
  expect(StyleSheet.flatten(view.getByText(text).props.style)).toMatchObject({ fontFamily: `${family}_400Regular`, lineHeight: 24 });
  await view.unmount();
  const brief = await render(<BriefEditor draft={{ edited_text: text } as BriefDraft} persist={jest.fn()} save={jest.fn()} discard={jest.fn()} />);
  const input = brief.getByLabelText('Brief draft');
  expect(StyleSheet.flatten(input.props.style)).toMatchObject({ fontFamily: `${family}_400Regular`, lineHeight: 24 });
  // The labels are ordinary UI text and are unaffected by the script in the draft.
  expect(brief.getByText('Save')).toBeTruthy();
});
