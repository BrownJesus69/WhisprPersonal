import Constants from 'expo-constants';
interface Features {
  googleSignIn: boolean;
  translation: boolean;
  calendar: boolean;
  drive: boolean;
  gmail: boolean;
  appCheck: boolean;
  fcm: boolean;
  webSearch: boolean;
  cloudWhisper: boolean;
}
const extra = Constants.expoConfig?.extra;

export const config = {
  features: {
    googleSignIn: false,
    translation: false,
    calendar: false,
    drive: false,
    gmail: false,
    appCheck: false,
    fcm: false,
    webSearch: false,
    cloudWhisper: false,
    ...extra?.features
  } as Features,
  consentVersion: String(extra?.consentVersion ?? '2026-11-15'),
  version: Constants.expoConfig?.version ?? '0.4.0',
  sdk: Constants.expoConfig?.sdkVersion ?? '58'
};

export class FeatureDisabledError extends Error {
  constructor() {
    super('Not configured');
  }
}
