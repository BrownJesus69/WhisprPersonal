// Deliberately uses production RN-free code. Run with Node 24 type stripping.
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { StreamClient } from '../src/lib/live/streamClient.ts';
import { apply, initialTranscript } from '../src/lib/live/transcriptModel.ts';
import { isMode } from '../src/lib/live/events.ts';
import { parseServerUrl } from '../src/lib/server/serverUrl.ts';
import type { WebSocketLike } from '../src/lib/live/socket.ts';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
function required(name: string) { const v = args.get(`--${name}`); if (!v) throw new Error(`Missing --${name}`); return v; }
async function main() {
  const server = parseServerUrl(required('server')).url;
  const key = required('key'), token = required('token'), session = required('session'), event = required('event');
  const directory = required('chunks'), overlap = Number(required('overlap'));
  const language = args.get('--language');
  if (!Number.isSafeInteger(overlap) || overlap < 0 || (language && (!isMode(language) || language === 'auto'))) throw new Error('Invalid options');
  const headers = { 'X-WhisprPersonal-Server-Key': key, Authorization: `Bearer ${token}` };
  async function post(path: string, body: object | FormData) {
    const multipart = body instanceof FormData;
    const response = await fetch(`${server}${path}`, { method: 'POST', headers: multipart ? headers : { ...headers, 'Content-Type': 'application/json' }, body: multipart ? body : JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`http_${response.status}`);
    return response.json();
  }
  const files = (await readdir(directory)).filter(f => /^\d+_\d+_\d+_\d+_[ce]\.wav$/.test(f)).sort((a,b) => Number(a.split('_')[0]) - Number(b.split('_')[0]));
  if (!files.length) throw new Error('No test chunks');
  const sequences = files.map(f => Number(f.split('_')[0]));
  if (sequences.some((s,i) => s !== i)) throw new Error('Chunks must start at zero and be contiguous');
  await post('/api/v1/sessions', { session_id: session, event_id: event, language_mode: 'auto', expected_languages: [], model_profile: 'turbo', overlap_ms: overlap });
  let state = initialTranscript(), cursor = 0, live = false, connections = 0;
  const seqs: number[] = [];
  const client = new StreamClient({ serverUrl: server,
    socket: (url, requestHeaders) => {
      // Node 24's global constructor accepts headers; DOM TS types lack this overload.
      const Constructor = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocketLike;
      connections++;
      return new Constructor(url, { headers: requestHeaders });
    },
    getServerKey: async () => key, getBearer: async () => token,
    onAuthExpired: async () => { throw new Error('Supply a valid token'); },
    session: async () => ({ server_created: 1, last_event_seq: cursor }),
    persist: async e => { cursor = e.seq; }, resetLastEventSeq: async () => { cursor = 0; seqs.length = 0; },
    onReset: () => { state = initialTranscript(); },
    apply: e => {
      state = apply(state, e);
      if ('seq' in e) {
        if (seqs.includes(e.seq)) throw new Error('Duplicate applied event');
        seqs.push(e.seq); console.log(`${e.type} ${e.seq}`);
      }
    }, status: s => { live = s === 'live'; }, log: code => console.log(`stream: ${code}`)
  });
  async function until(check: () => boolean, description: string) {
    const deadline = Date.now() + 180_000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`Timeout: ${description}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  try {
    await client.start(session);
    await until(() => live, 'stream hello');
    for (let i = 0; i < files.length; i++) {
      const filename = files[i];
      const [sequence, start, end, head, continuation] = filename.replace('.wav', '').split('_');
      const file = await readFile(join(directory, filename));
      const hash = createHash('sha256').update(file).digest('hex');
      const chunkId = `chk_${createHash('sha256').update(`${session}:${sequence}:${hash}`).digest('hex').slice(0, 24)}`;
      const form = new FormData();
      for (const [name, value] of Object.entries({ chunk_id: chunkId, sequence, start_ms: start, end_ms: end, overlap_ms: head, continues: continuation === 'c', sha256: hash })) form.append(name, String(value));
      if (language) form.append('language', language);
      form.append('file', new Blob([file]), filename);
      await post(`/api/v1/sessions/${encodeURIComponent(session)}/chunks`, form);
      if (i === Math.floor(files.length / 2)) {
        const before = connections; live = false;
        client.forceReconnectForCheck();
        await until(() => connections > before && live, 'forced reconnect');
      }
    }
    await until(() => sequences.every(n => state.finals.has(n)), 'all transcript finals');
    await post(`/api/v1/sessions/${encodeURIComponent(session)}/finalize`, { expected_chunk_count: files.length, force: false });
    await until(() => !!state.finalized, 'session_finalized');
    if (seqs.some((s,i) => s !== i + 1)) throw new Error('Event lost or unordered');
    console.log('seqs:', JSON.stringify(seqs));
    console.log('raw:', [...state.finals.values()].filter(r => !r.no_speech).map(r => r.raw_text).join('\n'));
    console.log('language:', JSON.stringify(state.language));
  } finally { client.stop(); }
}
// Messages here are the driver's own (timeouts, http_<status>, invariants) — never headers.
main().catch(error => { console.error('live_stream_check_failed:', error instanceof Error ? error.message : 'unknown'); process.exitCode = 1; });
