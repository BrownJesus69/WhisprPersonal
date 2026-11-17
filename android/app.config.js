// WhisprPersonal Expo config. Nothing secret belongs here: everything in this file and in
// EXPO_PUBLIC_* variables is bundled into the APK.

module.exports = {
  expo: {
    name: 'WhisprPersonal',
    slug: 'whisprpersonal',
    scheme: 'whisprpersonal',
    version: '1.1.3',
    platforms: ['android'],
    orientation: 'portrait',
    userInterfaceStyle: 'automatic',
    icon: './assets/images/icon.png',
    android: {
      package: 'com.aditya.whisprpersonal',
      // Bump with every installable build so a newer APK installs over an older one.
      versionCode: 18,
      // EAS cloud builds: provide google-services.json as an EAS *file* env var named
      // GOOGLE_SERVICES_JSON (the local file is git-ignored and not uploaded).
      googleServicesFile: process.env.GOOGLE_SERVICES_JSON ?? './app/google-services.json',
      permissions: ['CAMERA', 'RECORD_AUDIO'],
      blockedPermissions: [
        'android.permission.READ_PHONE_STATE',
        'android.permission.BLUETOOTH',
        'android.permission.BLUETOOTH_ADMIN',
        'android.permission.BLUETOOTH_CONNECT',
        'android.permission.READ_EXTERNAL_STORAGE',
        'android.permission.WRITE_EXTERNAL_STORAGE',
        'android.permission.SYSTEM_ALERT_WINDOW',
      ],
      adaptiveIcon: {
        backgroundColor: '#E6F4FE',
        foregroundImage: './assets/images/android-icon-foreground.png',
        backgroundImage: './assets/images/android-icon-background.png',
        monochromeImage: './assets/images/android-icon-monochrome.png',
      },
    },
    plugins: [
      'expo-router',
      [
        'expo-splash-screen',
        { backgroundColor: '#208AEF', image: './assets/images/splash-icon.png', imageWidth: 76 },
      ],
      '@react-native-firebase/app',
      '@react-native-firebase/auth',
      '@react-native-google-signin/google-signin',
      [
        'expo-camera',
        {
          cameraPermission:
            'WhisprPersonal uses the camera only to scan the laptop connection QR code.',
          recordAudioAndroid: false,
        },
      ],
      'expo-secure-store',
      'expo-sqlite',
      ['@siteed/audio-studio', {
        // Calls are detected through audio-focus interruptions without reading phone state.
        enablePhoneStateHandling: false,
        // Visible recording notification and foreground microphone service for screen lock.
        enableNotifications: true,
        enableBackgroundAudio: true,
        // Built-in microphone only; no Bluetooth/USB discovery permissions.
        enableDeviceDetection: false,
      }],
      [
        'expo-build-properties',
        {
          android: {
            // The laptop serves plain HTTP on the LAN/Tailscale. The app itself refuses
            // plain-HTTP URLs to public hosts (src/lib/server/serverUrl.ts).
            usesCleartextTraffic: true,
            // Verified by a native build (2026-11-15): RN 0.88 defaults to Kotlin 2.2.0, but
            // firebase-auth 25.0.0 (pulled by @react-native-firebase 27.1.1) ships Kotlin 2.4
            // metadata, which a 2.2 compiler rejects. A 2.3 compiler reads 2.4 metadata.
            kotlinVersion: '2.3.21',
          },
        },
      ],
      './plugins/withWindowsCmakePaths',
      // Must run last: Android-only introspection and removal of Phase 4's stale mic block.
      './plugins/withAndroidRecording',
    ],
    extra: {
      features: {
        // Off until Google Sign-In is configured in Firebase (see android/README.md).
        googleSignIn: Boolean(process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID),
        translation: false,
        calendar: false,
        drive: false,
        gmail: false,
        appCheck: false,
        fcm: false,
        webSearch: false,
        cloudWhisper: false,
      },
      consentVersion: '2026-11-15',
    },
    experiments: { typedRoutes: true, reactCompiler: true },
  },
};
