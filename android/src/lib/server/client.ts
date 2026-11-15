import { parseServerUrl } from './serverUrl';
import type { ServerErrorBody } from './types';
import { serverMessage } from './messages';

export class ServerError extends Error {
  constructor(public status: number, public code: string, message: string, public requestId?: string, public retryAfterS?: number) {
    super(message);
    this.name = 'ServerError';
  }
}
interface Options {
  auth: boolean;
  timeoutMs?: number;
}
interface Dependencies {
  baseUrl: string;
  getServerKey: () => Promise<string | null>;
  getBearer: () => Promise<string>;
  onAuthExpired: () => Promise<void>;
}

export class ServerClient {
  private baseUrl: string;
  constructor(private deps: Dependencies) {
    this.baseUrl = parseServerUrl(deps.baseUrl).url;
  }
  get<T>(path: string, options: Options = { auth: true }): Promise<T> {
    return this.request(path, undefined, options);
  }
  post<T>(path: string, body?: unknown, options: Options = { auth: true }): Promise<T> {
    return this.request(path, body, options, true);
  }
  private async request<T>(path: string, body: unknown, options: Options, post = false, retried = false): Promise<T> {
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('://'))
      throw new ServerError(0, 'invalid_path', 'Invalid server endpoint');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (options.auth) {
      const key = await this.deps.getServerKey();
      if (!key)
        throw new ServerError(0, 'missing_server_key', 'Enter the laptop server key');
      headers['X-WhisprPersonal-Server-Key'] = key;
      headers.Authorization = `Bearer ${await this.deps.getBearer()}`;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10000);
    let response: Response;
    let data: unknown;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: post ? 'POST' : 'GET',
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal
      });
      data = await response.json().catch(() => null);
    }
    catch {
      throw new ServerError(0, controller.signal.aborted ? 'timeout' : 'network_unreachable', controller.signal.aborted ? 'The laptop took too long to respond' : "Can't reach the laptop. Same Wi-Fi/Tailscale? Server running?");
    }
    finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      const envelope = data as Partial<ServerErrorBody> | null;
      const code = typeof envelope?.error?.code === 'string' && /^[a-z_]+$/.test(envelope.error.code)
        ? envelope.error.code : 'server_error';
      if (code === 'auth_token_expired' && options.auth && !retried) {
        await this.deps.onAuthExpired();
        return this.request(path, body, options, post, true);
      }
      const retry = response.headers.get('Retry-After');
      const parsedSeconds = retry ? (Number.isFinite(Number(retry)) ? Math.max(0, Number(retry)) : Math.max(0, Math.ceil((Date.parse(retry) - Date.now()) / 1000))) : undefined;
      const seconds = parsedSeconds !== undefined && Number.isFinite(parsedSeconds) ? parsedSeconds : undefined;
      // Preserve the error envelope while removing any reflected request credentials.
      const redact = (text: string) => {
        for (const secret of [headers['X-WhisprPersonal-Server-Key'], headers.Authorization?.slice(7)]) {
          if (secret) text = text.split(secret).join('[redacted]');
        }
        return text;
      };
      const message = typeof envelope?.error?.message === 'string'
        ? redact(envelope.error.message) : serverMessage(code, response.status, seconds);
      const requestId = typeof envelope?.error?.request_id === 'string'
        ? redact(envelope.error.request_id) : undefined;
      throw new ServerError(response.status, code, message, requestId, seconds);
    }
    return data as T;
  }
}
