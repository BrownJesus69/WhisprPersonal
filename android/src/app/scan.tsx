import { useState } from 'react';
import { Linking } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { router } from 'expo-router';
import { Screen } from '@/components/Screen';
import { Banner } from '@/components/Banner';
import { Button } from '@/components/Button';
import { parseServerUrl } from '@/lib/server/serverUrl';
import { useConnectionStore } from '@/state/connectionStore';

export default function Scan() {
  const [permission, request] = useCameraPermissions();
  const [message, setMessage] = useState('');
  const [scanned, setScanned] = useState(false);
  return <Screen title="Scan laptop QR">
    <Banner message="Scan a plain laptop URL. QR codes must never contain server keys." />
    {permission?.granted ? <CameraView style={{ height: 320 }} barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={scanned ? undefined : ({ data }) => {
      setScanned(true);
      try {
        useConnectionStore.getState().set({ scannedUrl: parseServerUrl(data).url });
        router.back();
      }
      catch {
        setMessage('This QR is not a valid laptop URL.');
      }
    }} /> : permission?.canAskAgain === false
      ? <><Banner message="Camera permission is disabled. Enable it in Android settings, or enter the laptop URL manually."/><Button label="Open Android settings" onPress={() => void Linking.openSettings().catch(() => setMessage('Open app permissions in Android settings.'))}/></>
      : <Button label="Allow camera" onPress={() => void request().catch(() => setMessage('Could not request camera permission. You can enter the URL manually.'))} />}
    <Banner message={message || 'Point your camera at the laptop connection QR.'} />
    {scanned && <Button label="Try another QR" onPress={() => {
      setScanned(false);
      setMessage('');
    }} />}
    <Button secondary label="Cancel" onPress={() => router.back()} />
  </Screen>;
}
