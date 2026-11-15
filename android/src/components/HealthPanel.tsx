import type { Health } from '@/lib/server/types';
import { Card } from './Card';
import { KeyValueRow } from './KeyValueRow';

export function HealthPanel({ health: h }: {
  health: Health;
}) {
  const rows: Record<string, unknown> = {
    'Server version': h.version,
    'Overall status': h.status,
    'Model': h.model.name,
    'Model status': h.model.status,
    'Device': h.model.device_resolved ?? h.model.device,
    'GPU': h.gpu.name,
    'VRAM (MB)': h.gpu.vram_total_mb,
    'Queue': `${h.queue.status} · ${h.queue.depth}/${h.queue.max_depth}`,
    'Firebase': h.firebase.status,
    'Offline passes': `${h.auth.grants.enabled ? 'Enabled' : 'Disabled'} · ${h.auth.grants.ttl_hours} h`,
    'Groq configured': h.providers.groq.configured ? 'Yes' : 'No',
    'SambaNova configured': h.providers.sambanova.configured ? 'Yes' : 'No',
    'Supported languages': h.languages.supported.join(', ')
  };
  return <Card>
    {Object.entries(rows).map(([label, value]) => <KeyValueRow key={label} label={label} value={value} />)}
  </Card>;
}
