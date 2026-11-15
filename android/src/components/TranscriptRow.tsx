import { memo, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Pressable, Text } from 'react-native';
import { spacing, typography, useTheme } from '@/theme';
import { languageName } from './LanguageBadge';

export interface DisplayRow { sequence: number; startMs: number; text: string; notCleaned?: boolean; partial?: boolean; failed?: string; divider?: string; revision: number; language?: string | null }
export const timestamp = (ms: number) => `${Math.floor(ms / 60_000).toString().padStart(2, '0')}:${Math.floor(ms / 1000 % 60).toString().padStart(2, '0')}`;
export const TranscriptRow = memo(function TranscriptRow({ row, onAddNote }: { row: DisplayRow; onAddNote?: (row: DisplayRow) => void }) {
  const t = useTheme();
  const previous = useRef(row.revision);
  const [updated, setUpdated] = useState(false);
  const [reduce, setReduce] = useState(true);
  useEffect(() => {
    let disposed = false;
    void AccessibilityInfo.isReduceMotionEnabled().then(v => { if (!disposed) setReduce(v); }).catch(() => {});
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduce);
    return () => { disposed = true; subscription.remove(); };
  }, []);
  useEffect(() => {
    const changed = row.revision > previous.current; previous.current = row.revision;
    if (!changed || reduce) return;
    setUpdated(true);
    const timer = setTimeout(() => setUpdated(false), 550);
    return () => clearTimeout(timer);
  }, [row.revision, reduce]);
  const canAdd = !!onAddNote && !row.partial && !row.failed;
  return <Pressable accessible={canAdd} accessibilityLabel={canAdd ? `Transcript: ${row.text}` : undefined}
    accessibilityActions={canAdd ? [{ name: 'addNote', label: 'Add to notes' }] : undefined}
    onAccessibilityAction={e => { if (canAdd && e.nativeEvent.actionName === 'addNote') onAddNote?.(row); }}
    onLongPress={canAdd ? () => onAddNote?.(row) : undefined} style={{ minHeight: 48, paddingVertical: spacing.sm, gap: spacing.xs, borderBottomWidth: 1, borderBottomColor: t.border, backgroundColor: updated && !reduce ? t.surface : 'transparent' }}>
    {row.divider && <Text accessibilityRole="header" style={{ ...typography.label, color: t.primary }}>— {languageName(row.divider)} —</Text>}
    <Text style={{ ...typography.label, color: t.muted, fontVariant: ['tabular-nums'] }}>{timestamp(row.startMs)}{updated && !reduce ? ' · updated' : ''}</Text>
    {row.notCleaned && <Text style={{ ...typography.label, color: t.muted }}>Not cleaned</Text>}
    <Text selectable accessibilityLabel={row.partial ? `Partial transcript: ${row.text}` : undefined} style={{ ...typography.body, color: row.failed ? t.danger : row.partial ? t.muted : t.text, fontStyle: row.partial ? 'italic' : 'normal' }}>
      {row.failed ? `Could not transcribe this part (${row.failed}). Audio is kept on the phone.` : `${row.text}${row.partial ? ' …' : ''}`}
    </Text>
  </Pressable>;
}, (a, b) => a.onAddNote === b.onAddNote && a.row.sequence === b.row.sequence && a.row.startMs === b.row.startMs && a.row.text === b.row.text && a.row.partial === b.row.partial && a.row.failed === b.row.failed && a.row.divider === b.row.divider && a.row.revision === b.row.revision && a.row.language === b.row.language && a.row.notCleaned === b.row.notCleaned);
