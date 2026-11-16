import { useState } from 'react';
import { router } from 'expo-router';
import { Alert } from 'react-native';
import { Screen } from '@/components/Screen';
import { TextField } from '@/components/TextField';
import { Button } from '@/components/Button';
import { Banner } from '@/components/Banner';
import { ChipSelect } from '@/components/ChipSelect';
import { SectionHeader } from '@/components/SectionHeader';
import { Collapsible } from '@/components/Collapsible';
import { createEvent } from '@/lib/firebase/events';
import { LANGUAGE_MODE_OPTIONS, type LanguageMode } from '@/types/models';
import { useSettingsStore } from '@/state/settingsStore';
import { useAuthStore } from '@/state/authStore';

/** A title is all an event needs; everything else is optional and tucked away. */
export default function NewEvent() {
  const settings = useSettingsStore();
  const uid = useAuthStore(s => s.user?.uid);
  const [title, setTitle] = useState('');
  const [language, setLanguage] = useState<LanguageMode>(settings.defaultLanguageMode);
  const [location, setLocation] = useState('');
  const [description, setDescription] = useState('');
  const [speakers, setSpeakers] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
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
        startTime: null,
        endTime: null,
        agenda: '',
        speakers: speakers.split(',').map(s => s.trim()).filter(Boolean),
        languages: language === 'auto' ? [] : [language],
        languageMode: language,
        privacyMode: settings.privacyMode
      }, error => Alert.alert(
        'Event not saved to the cloud',
        `${error.message}\n\nIt is still on this phone. Check your account and the Firestore rules, then try again.`
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
  return <Screen title="New event">
    <TextField label="Event name" value={title} onChangeText={setTitle} placeholder="e.g. Team offsite" />
    <SectionHeader title="Language" />
    <ChipSelect options={LANGUAGE_MODE_OPTIONS} selected={[language]} onSelect={setLanguage} />
    <Collapsible title="More details (optional)">
      <TextField label="Location" value={location} onChangeText={setLocation} />
      <TextField label="Description" value={description} onChangeText={setDescription} multiline />
      <TextField label="Speakers (separate with commas)" value={speakers} onChangeText={setSpeakers} />
    </Collapsible>
    {message && <Banner error message={message} />}
    <Button large label="Create event" disabled={!title.trim()} loading={busy} onPress={() => void submit()} />
  </Screen>;
}
