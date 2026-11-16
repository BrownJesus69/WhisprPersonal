import { requireNativeModule } from 'expo-modules-core';
import type { LanguageMode } from '../../src/types/models';
export interface KeyboardConfig {
  serverUrl: string;
  serverKey: string;
  languageMode: LanguageMode;
  reviewBeforeInsert: boolean;
  haptics: boolean;
  speakEventId: string;
}
export interface KeyboardModule {
  setConfig(config: KeyboardConfig): Promise<void>;
  clearConfig(): Promise<void>;
  isEnabled(): Promise<boolean>;
  isSelected(): Promise<boolean>;
  openInputMethodSettings(): Promise<void>;
  showPicker(): Promise<void>;
}
export default requireNativeModule<KeyboardModule>('WhisprKeyboard');
