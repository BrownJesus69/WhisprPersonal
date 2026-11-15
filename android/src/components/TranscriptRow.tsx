import { memo, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Text, View } from 'react-native';
import { spacing, typography, useTheme } from '@/theme';
import { languageName } from './LanguageBadge';

export interface DisplayRow { sequence: number; startMs: number; text: string; partial?: boolean; failed?: string; divider?: string; revision: number }
export const timestamp = (ms: number) => `${Math.floor(ms / 60_000).toString().padStart(2, '0')}:${Math.floor(ms / 1000 % 60).toString().padStart(2, '0')}`;
export const TranscriptRow = memo(function TranscriptRow({ row }: { row: DisplayRow }) {
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
  return <View style={{ paddingVertical: spacing.sm, gap: spacing.xs, borderBottomWidth: 1, borderBottomColor: t.border, backgroundColor: updated && !reduce ? t.surface : 'transparent' }}>
    {row.divider && <Text accessibilityRole="header" style={{ ...typography.label, color: t.primary }}>— {languageName(row.divider)} —</Text>}
    <Text style={{ ...typography.label, color: t.muted, fontVariant: ['tabular-nums'] }}>{timestamp(row.startMs)}{updated && !reduce ? ' · updated' : ''}</Text>
    <Text selectable accessibilityLabel={row.partial ? `Partial transcript: ${row.text}` : undefined} style={{ ...typography.body, color: row.failed ? t.danger : row.partial ? t.muted : t.text, fontStyle: row.partial ? 'italic' : 'normal' }}>
      {row.failed ? `Could not transcribe this part (${row.failed}). Audio is kept on the phone.` : `${row.text}${row.partial ? ' …' : ''}`}
    </Text>
  </View>;
}, ({ row: a }, { row: b }) => a.sequence === b.sequence && a.startMs === b.startMs && a.text === b.text && a.partial === b.partial && a.failed === b.failed && a.divider === b.divider && a.revision === b.revision);
