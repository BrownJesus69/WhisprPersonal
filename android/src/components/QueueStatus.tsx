import { Text } from 'react-native';
import { useState } from 'react';
import type { LocalChunk } from '@/lib/db/repositories';
import { Card } from './Card';
import { KeyValueRow } from './KeyValueRow';
import { Button } from './Button';
import { useTheme, typography } from '@/theme';

export function QueueStatus({ chunks, offline, retry }: { chunks: LocalChunk[]; offline: boolean; retry: () => void }) {
  const t = useTheme();
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(chunks.length / 20));
  const current = Math.min(page, pages - 1);
  const failed = chunks.filter(c => c.status === 'failed_permanent');
  const waiting = chunks.filter(c => ['pending','uploading'].includes(c.status)).length;
  return <Card>
    <KeyValueRow label="Recorded" value={String(chunks.length)} />
    <KeyValueRow label="Uploaded" value={String(chunks.filter(c => ['uploaded','transcribed'].includes(c.status)).length)} />
    <KeyValueRow label="Transcribed" value={String(chunks.filter(c => c.status === 'transcribed').length)} />
    <KeyValueRow label="Failed" value={String(chunks.filter(c => c.status === 'failed_permanent' || c.server_status === 'failed').length)} />
    {waiting > 0 && <Text style={{ ...typography.body, color: t.muted }}>{waiting} chunks waiting{offline ? ' — offline' : ''}</Text>}
    {chunks.slice(current * 20, (current + 1) * 20).map(c => <Text key={c.chunk_id} style={{ ...typography.label, color: c.last_error ? t.danger : t.muted }}>Chunk {c.sequence + 1}: {c.status} · laptop: {c.server_status ?? 'not sent'}{c.last_error ? ` · ${c.last_error}` : ''}</Text>)}
    {pages > 1 && <>
      <KeyValueRow label="Chunk pages" value={`${current + 1} of ${pages}`} />
      <Button secondary label="Previous chunks" disabled={current === 0} onPress={() => setPage(current - 1)} />
      <Button secondary label="Next chunks" disabled={current === pages - 1} onPress={() => setPage(current + 1)} />
    </>}
    {!!failed.length && <Button secondary label="Retry failed uploads" onPress={retry} />}
  </Card>;
}
