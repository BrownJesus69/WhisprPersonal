import { ChipSelect } from './ChipSelect';
import type { LanguageMode } from '@/lib/live/events';

export function LanguagePicker({ mode, onSelect }: { mode: LanguageMode; onSelect: (mode: LanguageMode) => void }) {
  return <ChipSelect selected={[mode]} onSelect={onSelect} options={[
    { value: 'auto', label: 'Auto' }, { value: 'kn', label: 'Kannada' }, { value: 'ta', label: 'Tamil' },
    { value: 'hi', label: 'Hindi' }, { value: 'en', label: 'English' }
  ]} />;
}
