import { AccessibilityInfo } from 'react-native';
import { withDeadline } from '@/lib/deadline';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuthStore } from '@/state/authStore';
import { useSettingsStore } from '@/state/settingsStore';
import { useConnectionStore } from '@/state/connectionStore';
import { updateEventStatus } from '@/lib/firebase/events';
import { repositories, type LocalSession, type TranscriptRow } from '@/lib/db/repositories';
import { createLocalSession, useRecordingStore } from '@/lib/session/recordingStore';
import { emptyView, useTranscriptStore } from '@/lib/live/transcriptStore';
import { liveController } from '@/lib/live/liveController';
import { uploadService } from '@/lib/upload/uploadService';
import { aiRuntime } from '@/lib/ai/runtime';
import { kv } from '@/lib/storage/kv';
import { t } from '@/i18n';
import { ensureSpeakEvent } from './speakEvent';
import { applySpeakRetention, removeRecording } from './retention';
import { draftKey } from './drafts';
import { cleanupFailedFor } from './recovery';
import { requestDefaultCleanup } from './defaultCleanup';
export { draftKey } from './drafts';

export type SpeakState = 'idle' | 'starting' | 'permission_denied' | 'microphone_unavailable' | 'listening' | 'stopping' | 'processing' | 'slow' | 'complete' | 'failed';
export function sessionState(session: LocalSession, phase: string | undefined, stale: boolean): SpeakState {
  if (phase === 'error' || session.status === 'failed') return 'failed';
  if (phase === 'recording' || phase === 'paused') return 'listening';
  if (phase === 'stopping') return 'stopping';
  if (phase === 'requesting_permission') return 'starting';
  if (session.status === 'finalized') return 'complete';
  if (!session.consent_at) return 'idle';
  return stale ? 'slow' : 'processing';
}
export function useSpeak() {
  const uid = useAuthStore(s => s.user?.uid);
  const connection = useConnectionStore(s => s.status);
  const cleanupLevel = useSettingsStore(s => s.cleanupLevel);
  const recording = useRecordingStore();
  const [state, setState] = useState<SpeakState>('idle');
  const [session, setSession] = useState<LocalSession | null>(null);
  const [rows, setRows] = useState<TranscriptRow[]>([]);
  const [draft, setDraft] = useState('');
  const [cleaned, setCleaned] = useState(false);
  const [error, setError] = useState('');
  const [draftError, setDraftError] = useState(false);
  const [retentionNotice, setRetentionNotice] = useState('');
  const [cleanupNotice, setCleanupNotice] = useState('');
  const cleanupAttempts = useRef(new Set<string>());
  const cleanupSelected = useRef(new Set<string>());
  const latest = useRef<LocalSession | null>(null), busy = useRef(false);
  const retryAction = useRef<(() => Promise<void>) | null>(null);
  const lastChange = useRef(0), signature = useRef('');
  const edit = useRef<{ key: string; text: string } | null>(null);
  const draftWrites = useRef<Promise<void>>(Promise.resolve());
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const live = useTranscriptStore(s => session ? s.sessions[session.id] ?? emptyView : emptyView);
  const disconnected = !['connected','verified'].includes(connection) || ['offline','auth_required','not_allowed'].includes(live.status) && !!session;
  const flushDraft = useCallback(async () => {
    if (draftTimer.current) clearTimeout(draftTimer.current);
    const pending = edit.current;
    if (!pending) return;
    const write = draftWrites.current.catch(() => {}).then(() => kv.setItem(pending.key, pending.text));
    draftWrites.current = write;
    await write;
    if (edit.current === pending) edit.current = null;
    setDraftError(false);
  }, []);
  const editDraft = (text: string) => {
    if (!session || !uid) return;
    setDraft(text);
    edit.current = { key: draftKey(uid, session.id, cleaned), text };
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => { void flushDraft().then(() => setDraftError(false)).catch(() => setDraftError(true)); }, 350);
  };
  useEffect(() => () => { void flushDraft().catch(() => {}); }, [flushDraft]);
  useEffect(() => {
    let disposed = false;
    const restore = async () => {
      latest.current = null; setSession(null); setState('idle'); setRows([]); setDraft('');
      if (!uid) return;
      const settings = useSettingsStore.getState();
      const eventId = settings.speakEventIds[uid] || (settings.speakEventOwner === uid ? settings.speakEventId : '');
      if (!eventId) return;
      const sessions = (await (await repositories()).sessions(uid)).filter(s => s.event_id === eventId).sort((a,b) => b.created_at.localeCompare(a.created_at));
      const recent = sessions[0];
      if (!disposed && recent && ['recording','paused','stopped','finalizing','interrupted'].includes(recent.status)) {
        latest.current = recent; setSession(recent); lastChange.current = Date.now();
        const r = useRecordingStore.getState();
        setState(sessionState(recent, r.sessionId === recent.id ? r.phase : undefined, false));
      }
    };
    void restore().catch(() => { if (!disposed) { setError(t('failed')); setState('failed'); } });
    return () => { disposed = true; };
  }, [uid]);
  const sessionId = session?.id, sessionOwner = session?.owner_uid;
  useEffect(() => { if (sessionId && uid === sessionOwner) return liveController.acquire(sessionId); }, [sessionId, sessionOwner, uid]);
  useEffect(() => {
    if (!sessionId || !uid) return;
    let disposed = false, polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const repo = await repositories();
        const current = await repo.session(sessionId);
        const stored = (await repo.transcript(sessionId)).sort((a,b) => a.sequence - b.sequence);
        if (disposed || !current || current.owner_uid !== uid || latest.current?.id !== sessionId) return;
        const next = JSON.stringify(stored.map(r => [r.sequence, r.raw_text, r.polished_text, r.failed_code, r.polish_error]));
        if (signature.current !== next) { signature.current = next; lastChange.current = Date.now(); setRows(stored); }
        if (stored.some(row => !!row.polished_text) && useSettingsStore.getState().cleanupLevel !== 'none' && !cleanupSelected.current.has(current.id)) {
          cleanupSelected.current.add(current.id); setCleaned(true);
        }
        const jobs = await repo.aiJobs(uid, current.event_id);
        if (disposed) return;
        if (cleanupFailedFor(jobs, sessionId) || stored.some(row => !!row.polish_error)) setCleanupNotice(t('cleanupFailed'));
        latest.current = current; setSession(current);
        const r = useRecordingStore.getState();
        setState(old => (old === 'microphone_unavailable' || old === 'failed' && current.status !== 'failed' && current.status !== 'finalized' || busy.current && ['starting','stopping'].includes(old) || !current.consent_at && old === 'permission_denied') ? old : sessionState(current, r.sessionId === current.id ? r.phase : undefined, Date.now() - lastChange.current >= 60000));
      } catch { if (!disposed) { setError(t('failed')); setState('failed'); } }
      finally { polling = false; }
    };
    void poll(); const timer = setInterval(() => { void poll(); }, 1500);
    return () => { disposed = true; clearInterval(timer); };
  }, [sessionId, uid]);
  useEffect(() => useRecordingStore.subscribe(r => {
    const current = latest.current;
    if (current && r.sessionId === current.id && ['recording','paused','stopping','error'].includes(r.phase)) setState(sessionState(current, r.phase, false));
  }), []);
  const raw = rows.map(r => r.raw_text).join(' ');
  const polished = rows.map(r => r.polished_text ?? r.raw_text).join(' ');
  useEffect(() => {
    if (state !== 'complete' || !sessionId || !uid || cleanupLevel === 'none') return;
    if (cleanupAttempts.current.has(sessionId)) return;
    cleanupAttempts.current.add(sessionId);
    void withDeadline(requestDefaultCleanup(uid, sessionId, cleanupLevel)).then(result => {
      if (latest.current?.id === sessionId) setCleanupNotice(result === 'not_configured' ? t('notSetUpComputer') : '');
    }).catch(() => { if (latest.current?.id === sessionId) setCleanupNotice(t('cleanupFailed')); });
  }, [state, sessionId, uid, cleanupLevel]);
  useEffect(() => {
    if (!['complete','failed'].includes(state) || !sessionId || !uid) return;
    let disposed = false;
    const key = draftKey(uid, sessionId, cleaned);
    void kv.getItem(key).then(value => { if (!disposed) setDraft(edit.current?.key === key ? edit.current.text : value ?? (cleaned ? polished : raw)); }).catch(() => { if (!disposed) { setDraft(cleaned ? polished : raw); setDraftError(true); } });
    return () => { disposed = true; };
  }, [state, sessionId, uid, cleaned, raw, polished]);
  const run = async (action: () => Promise<void>) => {
    if (busy.current) return;
    busy.current = true; retryAction.current = action; setError('');
    try { await action(); } catch { setError(t('failed')); setState('failed'); }
    finally { busy.current = false; }
  };
  const start = () => run(async () => {
    if (!uid) return;
    const active = useRecordingStore.getState();
    if (active.sessionId && (['recording','paused','stopping','requesting_permission'].includes(active.phase) || active.phase === 'error' && !active.message.includes('nothing was recorded'))) { setError(t('otherRecording')); setState('failed'); return; }
    await flushDraft(); setState('starting'); setCleaned(false); setCleanupNotice('');
    const settings = useSettingsStore.getState();
    try {
      const result = await applySpeakRetention(uid, 'start');
      setRetentionNotice(result.failed ? t('retentionFailed') : result.pending ? t('deletePending') : '');
    } catch { setRetentionNotice(t('retentionFailed')); }
    const event = await withDeadline(ensureSpeakEvent(uid, () => setError(t('failed'))));
    const current = await createLocalSession({ ...event, languageMode: settings.defaultLanguageMode });
    latest.current = current; setSession(current); setRows([]); setDraft(''); signature.current = ''; lastChange.current = Date.now();
    await useRecordingStore.getState().start(current, t('speak'), true);
    const r = useRecordingStore.getState();
    if (r.phase === 'error' && r.message.includes('nothing was recorded')) { setState('microphone_unavailable'); }
    else if (r.message && r.phase === 'ready') { setError(t('recordingStartFailed')); setState(r.message.toLowerCase().includes('microphone') ? 'permission_denied' : 'failed'); }
    else { setState(sessionState(current, r.phase, false)); }
  });
  const stop = () => run(async () => {
    setState('stopping');
    await useRecordingStore.getState().stop();
    if (useRecordingStore.getState().phase === 'error') { setState('failed'); return; }
    lastChange.current = Date.now(); setState('processing');
  });
  const finish = () => run(async () => {
    if (!latest.current) return;
    if (recording.sessionId === latest.current.id && ['recording','paused','error'].includes(recording.phase)) await recording.stop();
    else {
      await (await repositories()).updateSession(latest.current.id, { status: 'stopped', finalize_status: null, last_error: null });
      updateEventStatus(latest.current.event_id, 'processing'); uploadService.notify();
    }
    lastChange.current = Date.now(); setState('processing');
  });
  const remove = () => run(async () => {
    const current = latest.current;
    if (!current || !uid) return;
    await flushDraft();
    if (useRecordingStore.getState().sessionId === current.id) await useRecordingStore.getState().stop();
    await uploadService.stop(); await aiRuntime.stop(); liveController.stopRuntime();
    try {
      const result = await removeRecording(uid, current.id);
      setRetentionNotice(result.pending ? t('deletePending') : '');
      latest.current = null; setSession(null); setRows([]); setDraft(''); setState('idle');
    } finally {
      liveController.startRuntime();
      if (useAuthStore.getState().user?.uid === uid) { void uploadService.start(uid); void aiRuntime.start(uid); }
    }
  });
  const changeCleaned = async (value: boolean) => { try { await flushDraft(); setCleaned(value); } catch { setDraftError(true); } };
  const previousState = useRef(state);
  useEffect(() => {
    if (previousState.current === state) return;
    const previous = previousState.current;
    previousState.current = state;
    const turning = ['stopping','processing'].includes(state);
    const key = state === 'listening' ? 'recordingAnnouncement' : turning && !['stopping','processing'].includes(previous) ? 'processingAnnouncement' : state === 'complete' ? 'readyAnnouncement' : null;
    if (key) AccessibilityInfo.announceForAccessibility(t(key));
  }, [state]);
  const retry = () => retryAction.current ? run(retryAction.current) : start();
  return { retry, state, disconnected, session, rows, draft, editDraft, cleaned, changeCleaned, error, draftError, retentionNotice, cleanupNotice, flushDraft, start, stop, finish, remove,
    interrupted: session?.finalize_status === 'interrupted', recording, live, raw };
}
