import { en } from './en';
export type StringKey = keyof typeof en;
export function t(key: StringKey, params: Record<string, string | number> = {}): string {
  return en[key].replace(/\{(\w+)\}/g, (match, name: string) => String(params[name] ?? match));
}
