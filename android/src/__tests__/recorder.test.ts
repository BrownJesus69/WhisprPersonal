import type { RecordingConfig } from '@siteed/audio-studio';
import { File } from 'expo-file-system';
import { recorderAdapter } from '@/lib/audio/recorder';
import { wavHeader } from '@/lib/audio/pcm';

test('pause and stop reconcile master bytes and suppress late duplicate native events', async () => {
  let config: RecordingConfig;
  const file = new File('file:///recorder-test','master.wav'); file.create();
  const handle = file.open(); await handle.writeBytes(wavHeader(32000));
  const pcm = Uint8Array.from({ length: 32000 }, (_,i) => i % 251);
  await handle.writeBytes(pcm.subarray(0,16000));
  const native = { startRecording: async (c: RecordingConfig) => { config = c; }, pauseRecording: async () => {}, resumeRecording: async () => {},
    stopRecording: async () => { await handle.writeBytes(pcm.subarray(24000)); handle.close(); } };
  const received: Uint8Array[] = [];
  const recorder = recorderAdapter(() => native);
  await recorder.start({ directory: 'file:///recorder-test', filename: 'master.wav', title: 'Event', onPcm: p => received.push(p), onInterrupted: jest.fn() });
  const stream = async (from: number, to: number) => config.onAudioStream!({ data: Buffer.from(pcm.subarray(from,to)).toString('base64') } as never);
  await stream(0,8000);
  await recorder.pause(); // master has 16000 bytes; native emitted only 8000
  await recorder.resume();
  await handle.writeBytes(pcm.subarray(16000,24000));
  await stream(8000,24000); // includes the pause-drained bytes
  await recorder.stop(); // no final callback, but master has all 32000 bytes
  expect(Buffer.concat(received).equals(Buffer.from(pcm))).toBe(true);
  expect(config!.notification?.android?.showPauseResumeActions).toBe(false);
});
