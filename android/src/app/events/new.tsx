import { useState } from 'react';
import { router } from 'expo-router';
import { Alert } from 'react-native';
import { Timestamp } from '@react-native-firebase/firestore';
import { Screen } from '@/components/Screen';
import { TextField } from '@/components/TextField';
import { Button } from '@/components/Button';
import { Banner } from '@/components/Banner';
import { ChipSelect } from '@/components/ChipSelect';
import { SectionHeader } from '@/components/SectionHeader';
import { ConnectionPill } from '@/components/ConnectionPill';
import { createEvent } from '@/lib/firebase/events';
import { LANGUAGES, type LanguageCode, type LanguageMode, type PrivacyMode } from '@/types/models';
import { useSettingsStore } from '@/state/settingsStore';
import { useAuthStore } from '@/state/authStore';

export default function NewEvent() {
  const settings = useSettingsStore();
  const uid = useAuthStore(s => s.user?.uid);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [agenda, setAgenda] = useState('');
  const [speaker, setSpeaker] = useState('');
  const [speakers, setSpeakers] = useState<string[]>([]);
  const [languages, setLanguages] = useState<LanguageCode[]>([]);
  const [mode, setMode] = useState<LanguageMode>(settings.defaultLanguageMode);
  const [privacy, setPrivacy] = useState<PrivacyMode>(settings.privacyMode);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  function time(text: string) {
    if (!text.trim())
      return null;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text) || !Number.isFinite(Date.parse(text)))
      throw new Error('Use YYYY-MM-DDTHH:mm for local date and time');
    const date = new Date(text);
    const parts = [date.getFullYear(),date.getMonth()+1,date.getDate(),date.getHours(),date.getMinutes()];
    const entered = text.split(/[-T:]/).map(Number);
    if (parts.some((part,index) => part !== entered[index])) throw new Error('Enter a valid local date and time');
    return Timestamp.fromDate(date);
  }
  async function submit() {
    setBusy(true);
    setMessage('');
    try {
      if (!uid)
        throw new Error('Sign in to continue');
      const id = await createEvent(uid, {
        title,
        description,
        location,
        startTime: time(start),
        endTime: time(end),
        agenda,
        speakers,
        languages,
        languageMode: mode,
        privacyMode: privacy
      }, error => Alert.alert(
        'Event not saved to the cloud',
        `${error.message}\n\nIt is still on this phone. Check your account and the Firestore rules, then edit the event to retry.`
      ));
      router.replace({ pathname: '/events/[eventId]', params: { eventId: id } });
    }
    catch (e) {
      setMessage(e instanceof Error ? e.message : 'Could not create event');
    }
    finally {
      setBusy(false);
    }
  }
  return <Screen title="Set the scene">
    <ConnectionPill />
    <TextField label="Event title (required, up to 200 characters)" value={title} onChangeText={setTitle} />
    <TextField
      label="Description"
      value={description}
      onChangeText={setDescription}
      multiline
    />
    <TextField
      label="Start · YYYY-MM-DDTHH:mm (local time)"
      value={start}
      onChangeText={setStart}
      autoCapitalize="none"
    />
    <TextField
      label="End · YYYY-MM-DDTHH:mm (local time)"
      value={end}
      onChangeText={setEnd}
      autoCapitalize="none"
    />
    <TextField label="Location" value={location} onChangeText={setLocation} />
    <TextField
      label="Agenda"
      value={agenda}
      onChangeText={setAgenda}
      multiline
    />
    <SectionHeader title="Speakers" />
    <TextField label="Speaker name" value={speaker} onChangeText={setSpeaker} />
    <Button
      secondary
      label="Add speaker"
      disabled={!speaker.trim()}
      onPress={() => {
        setSpeakers([...speakers, speaker.trim()]);
        setSpeaker('');
      }}
    />
    {speakers.map((name, index) => <Button
      secondary
      key={`${name}-${index}`}
      label={`Remove ${name}`}
      onPress={() => setSpeakers(speakers.filter((_, i) => i !== index))}
    />)}
    <SectionHeader title="Expected languages" />
    <ChipSelect options={LANGUAGES.map(l => ({ value: l.code, label: l.name }))} selected={languages} onSelect={code => setLanguages(languages.includes(code) ? languages.filter(l => l !== code) : [...languages, code])} />
    <SectionHeader title="Language mode" />
    <ChipSelect options={[{ value: 'auto' as const, label: 'Auto' }, ...LANGUAGES.map(l => ({ value: l.code, label: l.name }))]} selected={[mode]} onSelect={setMode} />
    <SectionHeader title="Privacy" />
    <ChipSelect options={[{ value: 'local_only', label: 'Local only' }, { value: 'cloud_ai', label: 'Cloud AI enabled' }]} selected={[privacy]} onSelect={setPrivacy} />
    <Banner message={privacy === 'local_only' ? 'Audio stays on your laptop; transcripts and notes sync to Firebase.' : 'Optional cloud AI may process text when configured. Audio stays on your laptop.'} />
    {message && <Banner error message={message} />}
    <Button label="Create event" loading={busy} onPress={() => void submit()} />
  </Screen>;
}
