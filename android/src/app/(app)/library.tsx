import { View } from 'react-native';
import { router } from 'expo-router';
import { EventList } from '@/components/EventList';
import { Button } from '@/components/Button';

export default function Library() {
  return <View style={{ flex: 1 }}>
    <Button label="Search notes and transcripts" onPress={() => router.push('/search')} />
    <EventList past />
  </View>;
}
