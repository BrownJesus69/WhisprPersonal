import { PermissionsAndroid, Platform } from 'react-native';
import type { RecordingConfig } from '@siteed/audio-studio';
import { base64ToBytes } from './pcm';
import { File } from 'expo-file-system';
import { readWavPcm } from './chunkFiles';

export interface Recorder {
  start(config: { directory: string; filename: string; title: string; onPcm: (bytes: Uint8Array) => void; onInterrupted: (reason: string) => void }): Promise<void>;
  pause(): Promise<void>; resume(): Promise<void>; stop(): Promise<void>;
}
interface NativeRecorder {
  startRecording(config: RecordingConfig): Promise<unknown>;
  pauseRecording(): Promise<void>; resumeRecording(): Promise<void>; stopRecording(): Promise<unknown>;
}
export function recorderAdapter(native: () => NativeRecorder): Recorder {
  let delivered = 0;
  let emitted = 0;
  let options: Parameters<Recorder['start']>[0] | undefined;
  let masterUri = '';
  const deliver = (bytes: Uint8Array, start: number) => {
    const skip = Math.max(0, delivered - start);
    if (skip < bytes.length) { options!.onPcm(bytes.subarray(skip)); delivered = start + bytes.length; }
  };
  // Native pause does not flush its 500ms stream accumulator, and stop's final event
  // can arrive after the hook clears its callback. Fill from the durable WAV and
  // suppress those same bytes when a delayed native event arrives.
  const drainMaster = async () => {
    let position = delivered;
    for await (const bytes of readWavPcm(masterUri, position / 32)) { deliver(bytes, position); position += bytes.length; }
  };
  return {
    async start(o) {
      options = o; delivered = 0; emitted = 0;
      masterUri = new File(o.directory, o.filename).uri;
      await native().startRecording({ sampleRate: 16000, channels: 1, encoding: 'pcm_16bit',
        interval: 500, streamFormat: 'raw', keepAwake: true, showNotification: true,
        keepFullAnalysis: false, enableProcessing: false,
        // Keep pause/resume inside the app's durable state machine. Native notification
        // actions bypass JS and do not emit a pause boundary in this library version.
        notification: { title: 'WhisprPersonal is recording', text: o.title, android: { showPauseResumeActions: false } },
        output: { primary: { enabled: true, format: 'wav' } },
        outputDirectory: o.directory, filename: o.filename,
        autoResumeAfterInterruption: false, android: { audioFocusStrategy: 'background' },
        onAudioStream: async e => {
          if (typeof e.data !== 'string') throw new Error('Expected native PCM');
          const bytes = base64ToBytes(e.data);
          deliver(bytes, emitted); emitted += bytes.length;
        },
        onRecordingInterrupted: e => {
          if (e.isPaused) void drainMaster().then(() => o.onInterrupted(e.reason)).catch(() => o.onInterrupted('audio_read_failed'));
        }
      });
    },
    async pause() { await native().pauseRecording(); await drainMaster(); },
    async resume() { await drainMaster(); await native().resumeRecording(); },
    async stop() { await native().stopRecording(); await drainMaster(); }
  };
}
export async function requestRecordingPermissions(): Promise<{ microphone: boolean; notifications: boolean }> {
  if (Platform.OS !== 'android') return { microphone: false, notifications: false };
  const mic = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
  if (mic !== PermissionsAndroid.RESULTS.GRANTED) return { microphone: false, notifications: false };
  const notification = Number(Platform.Version) >= 33
    ? await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS) : PermissionsAndroid.RESULTS.GRANTED;
  return { microphone: true, notifications: notification === PermissionsAndroid.RESULTS.GRANTED };
}
