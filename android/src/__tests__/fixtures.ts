import type { Health } from '@/lib/server/types';

export const health: Health = {
  status: 'ok',
  version: 'test-version',
  server_time: '2026-11-15T10:00:00Z',
  uptime_s: 10,
  model: {
    name: 'test fixture model',
    fallback_name: null,
    status: 'ready',
    device: 'cpu',
    loaded: [],
    device_resolved: 'cpu',
    compute_type: 'test',
    load_s: 1,
    error: null
  },
  gpu: {
    available: false,
    name: null,
    vram_total_mb: null,
    detection: 'test'
  },
  queue: {
    status: 'running',
    depth: 0,
    max_depth: 8,
    workers: 1
  },
  providers: { groq: { configured: false, status: 'not_configured' }, sambanova: { configured: false, status: 'not_configured' }, local_llm: { configured: false, status: 'not_configured' } },
  firebase: {
    credentials_present: true,
    status: 'ready',
    error_reason: null,
    project_id_set: true
  },
  auth: {
    shared_secret_configured: true,
    token_verification: 'firebase',
    allowlist_enabled: true,
    check_revoked: false,
    grants: { enabled: true, ttl_hours: 12 }
  },
  features: {
    translation: false,
    calendar: false,
    drive: false,
    gmail: false,
    app_check: false,
    fcm: false,
    web_search: false,
    cloud_whisper: false
  },
  languages: { supported: ['kn', 'ta', 'hi', 'en'], default_mode: 'auto' }
};
