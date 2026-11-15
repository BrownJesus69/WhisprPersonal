import { useMemo, useRef, useState, useCallback } from 'react';
import { FlatList, Text, View } from 'react-native';
import type { TranscriptState } from '@/lib/live/transcriptModel';
import { spacing, typography, useTheme } from '@/theme';
import { TranscriptRow, type DisplayRow } from './TranscriptRow';
import { Button } from './Button';

export function TranscriptList({ model, chunkStarts, onAddNote }: { model: TranscriptState; chunkStarts: Record<number, number>; onAddNote?: (row: DisplayRow) => void }) {
  const t = useTheme();
  const list = useRef<FlatList<DisplayRow>>(null);
  const following = useRef(true);
  const [jump, setJump] = useState(false);
  const data = useMemo(() => {
    const rows = new Map<number, DisplayRow>();
    let previousLanguage: string | undefined;
    for (const row of model.finals.values()) {
      if (row.no_speech) continue;
      rows.set(row.sequence, { sequence: row.sequence, startMs: row.start_ms, text: row.raw_text,
        revision: row.revision, language: row.detected_language, divider: row.detected_language && row.detected_language !== previousLanguage ? row.detected_language : undefined });
      if (row.detected_language) previousLanguage = row.detected_language;
    }
    for (const [sequence, segments] of model.partials) if (!rows.has(sequence) && !model.finals.has(sequence)) rows.set(sequence, {
      sequence, startMs: (chunkStarts[sequence] ?? 0) + (segments[0]?.start_ms ?? 0), text: segments.map(s => s.text).join(' '), partial: true, revision: 0
    });
    for (const [sequence, failed] of model.failed) rows.set(sequence, { sequence, startMs: chunkStarts[sequence] ?? model.finals.get(sequence)?.start_ms ?? 0, text: '', failed, revision: 0 });
    return [...rows.values()].sort((a,b) => a.sequence - b.sequence);
  }, [model.finals, model.partials, model.failed, chunkStarts]);
  const silent = [...model.finals.values()].filter(r => r.no_speech).length;
  const render = useCallback(({ item }: { item: DisplayRow }) => <TranscriptRow row={item} onAddNote={onAddNote} />, [onAddNote]);
  return <View style={{ flex: 1 }}>
    <FlatList ref={list} data={data} keyExtractor={row => String(row.sequence)} renderItem={render}
      accessibilityLabel="Raw transcript" contentContainerStyle={{ paddingHorizontal: spacing.sm, flexGrow: 1 }}
      onScroll={e => {
        const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
        following.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 80;
        setJump(!following.current);
      }} scrollEventThrottle={100}
      onContentSizeChange={() => { if (following.current) list.current?.scrollToEnd({ animated: false }); }}
      ListEmptyComponent={<Text style={{ ...typography.body, color: t.muted, paddingVertical: spacing.md }}>Your transcript will appear here as the laptop decodes saved chunks.</Text>}
      ListFooterComponent={<Text style={{ ...typography.label, color: t.muted, paddingVertical: spacing.sm }}>{silent ? `${silent} silent chunks` : ''}{model.finalized ? ` · ${model.finalized.transcriptStatus}${model.finalized.missing.length ? ` · ${model.finalized.missing.length} missing parts` : ''}${model.finalized.failed.length ? ` · ${model.finalized.failed.length} failed parts` : ''}` : ''}</Text>}
    />
    {jump && <Button label="Jump to live" onPress={() => { following.current = true; setJump(false); list.current?.scrollToEnd({ animated: false }); }} />}
  </View>;
}
