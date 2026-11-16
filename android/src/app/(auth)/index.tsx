import { router } from 'expo-router';
import { Screen } from '@/components/Screen';
import { Card } from '@/components/Card';
import { Banner } from '@/components/Banner';
import { Button } from '@/components/Button';

export default function Welcome() {
  return <Screen title="Be present. Keep the words.">
    <Card>
      <Banner message="Audio goes ONLY to your own laptop. Transcripts and notes sync to your Firebase. Cloud AI is optional and off by default." />
    </Card>
    <Button label="Sign in" onPress={() => router.push('/(auth)/sign-in')} />
    <Button secondary label="Create account" onPress={() => router.push('/(auth)/sign-up')} />
  </Screen>;
}
