export interface ProviderHealth {
  configured: boolean;
  status: 'not_configured' | 'configured_unchecked';
}

export interface ChunkUploadResponse {
  chunk_id: string; sequence: number; status: string; duplicate: boolean;
}
export interface SessionResponse {
  status: string;
  chunks: ({ chunk_id: string; sequence: number; status: 'queued' | 'processing' | 'done' | 'failed'; error_code?: string | null } & Partial<import('../live/events').FinalData>)[];
  last_event_seq?: number;
}
export interface FinalizeResponse { status: string; missing_sequences?: number[]; pending?: number }

export interface Health {
  status: 'ok' | 'degraded';
  version: string;
  server_time: string;
  uptime_s: number;
  model: {
    name: string;
    fallback_name: string | null;
    status: 'not_loaded' | 'loading' | 'ready' | 'error';
    device: string;
    loaded: string[];
    device_resolved: 'cuda' | 'cpu' | null;
    compute_type: string;
    load_s: number | null;
    error: string | null;
  };
  gpu: {
    available: boolean | null;
    name: string | null;
    vram_total_mb: number | null;
    detection: string;
  };
  queue: {
    status: 'not_started' | 'running' | 'stopping';
    depth: number;
    max_depth: number;
    workers: number;
  };
  providers: {
    groq: ProviderHealth;
    sambanova: ProviderHealth;
    local_llm: ProviderHealth;
  };
  firebase: {
    credentials_present: boolean;
    status: 'not_configured' | 'ready' | 'error';
    error_reason: string | null;
    project_id_set: boolean;
  };
  auth: {
    shared_secret_configured: boolean;
    token_verification: 'disabled' | 'firebase';
    allowlist_enabled: boolean;
    check_revoked: boolean;
    grants: {
      enabled: boolean;
      ttl_hours: number;
    };
  };
  features: {
    translation: boolean;
    calendar: boolean;
    drive: boolean;
    gmail: boolean;
    app_check: boolean;
    fcm: boolean;
    web_search: boolean;
    cloud_whisper: boolean;
  };
  languages: {
    supported: string[];
    default_mode: 'auto';
  };
}

export interface AuthCheck {
  uid: string;
  email: string | null;
  email_verified: boolean;
  sign_in_provider: string;
  server_version: string;
  auth_method: 'firebase' | 'grant';
  grant_expires_at: number | null;
}

export interface GrantResponse {
  grant: string;
  expires_at: number;
  ttl_s: number;
  grant_id: string;
}

export interface ServerErrorBody {
  error: {
    code: string;
    message: string;
    request_id: string;
    details?: unknown;
  };
}
