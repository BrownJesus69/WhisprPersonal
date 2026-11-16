import { t } from '@/i18n';
import { providerStatus } from '@/lib/ai/messages';
import type { Health } from '@/lib/server/types';
import { Card } from './Card';
import { KeyValueRow } from './KeyValueRow';

export function HealthPanel({ health: h }: {
  health: Health;
}) {
  const rows: Record<string, unknown> = {
    [t('healthServerVersion')]: h.version,
    [t('healthOverallStatus')]: h.status,
    [t('healthModel')]: h.model.name,
    [t('healthModelStatus')]: h.model.status,
    [t('healthDevice')]: h.model.device_resolved ?? h.model.device,
    [t('healthGpu')]: h.gpu.name,
    [t('healthVram')]: h.gpu.vram_total_mb,
    [t('healthQueue')]: `${h.queue.status} · ${h.queue.depth}/${h.queue.max_depth}`,
    [t('healthFirebase')]: h.firebase.status,
    [t('healthOfflinePasses')]: `${h.auth.grants.enabled ? t('enabled') : t('disabled')} · ${h.auth.grants.ttl_hours} h`,
    [t('healthGroq')]: providerStatus(h.providers.groq.status),
    [t('healthSambaNova')]: providerStatus(h.providers.sambanova.status),
    [t('healthLocalModel')]: providerStatus(h.providers.local_llm.status),
    [t('healthSupportedLanguages')]: h.languages.supported.join(', ')
  };
  return <Card>
    {Object.entries(rows).map(([label, value]) => <KeyValueRow key={label} label={label} value={value} />)}
  </Card>;
}
