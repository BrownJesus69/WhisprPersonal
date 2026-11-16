import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { PixelRatio, ScrollView, StyleSheet } from 'react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Speak from '@/app/(app)/index';
import History from '@/app/(app)/history';
import Settings from '@/app/(app)/settings';
import Setup from '@/app/setup';
import KeyboardSetup from '@/app/keyboard-setup';
import { useSpeak } from '@/features/speak/useSpeak';
import { emptyView } from '@/lib/live/transcriptStore';
import { repositories } from '@/lib/db/repositories';
import { MemoryRepositories } from '@/lib/db/memoryRepositories';
import { defaults, useSettingsStore } from '@/state/settingsStore';
import { useAuthStore } from '@/state/authStore';
import { useConnectionStore } from '@/state/connectionStore';
import { t } from '@/i18n';
import { session } from './recordingFixtures';

jest.mock('@/features/speak/useSpeak', () => ({ useSpeak: jest.fn() }));
jest.mock('@/lib/db/repositories', () => ({ ...jest.requireActual('@/lib/db/repositories'), repositories: jest.fn() }));
const root = join(__dirname, '..');
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? entry.name === '__tests__' ? [] : files(join(directory, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(directory, entry.name)] : []);
}
beforeEach(() => {
  useSettingsStore.setState(defaults); useAuthStore.setState({ user: null });
  useConnectionStore.setState({ status: 'disconnected', health: null });
  jest.mocked(repositories).mockResolvedValue(new MemoryRepositories());
  jest.mocked(useSpeak).mockReturnValue({ state: 'idle', session: null, rows: [], live: emptyView, recording: { phase: 'idle', elapsedMs: 0 }, start: jest.fn(), stop: jest.fn() } as never);
});
test.each([Speak, History, Settings, Setup, KeyboardSetup])('%p buttons have explicit nonempty labels', async Component => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const view = await render(<QueryClientProvider client={client}><Component /></QueryClientProvider>);
  if (Component === History) {
    useAuthStore.setState({ user: { uid: 'owner', email: null, provider: 'password' } });
    const repo = await repositories(); await repo.putSession(session({ status: 'finalized' }));
    await client.invalidateQueries();
    await waitFor(() => expect(view.getAllByRole('button').length).toBeGreaterThan(1));
  }
  for (const button of view.getAllByRole('button')) expect(button.props.accessibilityLabel?.trim()).toBeTruthy();
  if (Component === Setup) {
    await fireEvent.press(view.getByLabelText(t('next')));
    for (const button of view.getAllByRole('button')) expect(button.props.accessibilityLabel?.trim()).toBeTruthy();
  }
  await view.unmount(); client.clear();
});
test('at 200% font scale Speak keeps its dock outside the shrinking transcript ScrollView', async () => {
  const scale = jest.spyOn(PixelRatio, 'getFontScale').mockReturnValue(2);
  const view = await render(<Speak />);
  let parent = view.getByTestId('speak-dock').parent;
  while (parent) { expect(parent.type).not.toBe(ScrollView); parent = parent.parent; }
  expect(StyleSheet.flatten(view.getByTestId('speak-dock').props.style).height).toBeUndefined();
  await view.unmount(); scale.mockRestore();
});
test('source guard: scaling remains enabled and content styles never add letter spacing', () => {
  for (const file of files(root)) expect(readFileSync(file, 'utf8')).not.toMatch(/allowFontScaling\s*=\s*\{\s*false\s*\}/);
  for (const file of ['components/TranscriptRow.tsx','components/TranscriptList.tsx','components/TranslationList.tsx','components/NoteRow.tsx','components/BriefEditor.tsx','components/Button.tsx','components/TextField.tsx','components/ui/TranscriptResult.tsx','app/(app)/history.tsx','app/(app)/index.tsx','app/history/[sessionId].tsx','app/search.tsx','theme/typography.ts','theme/fonts.ts']) {
    // Comments can explain why spacing is forbidden; actual style properties cannot set it.
    expect(readFileSync(join(root, file), 'utf8')).not.toMatch(/\bletterSpacing\s*:/);
  }
});
test('source guard: redesigned routes contain no English JSX text or literal labels', () => {
  for (const file of ['app/(app)/index.tsx','app/(app)/history.tsx','app/(app)/settings.tsx','app/history/[sessionId].tsx','app/setup/index.tsx','app/personal-words.tsx','app/keyboard-setup.tsx','app/connect.tsx','features/connect/ConnectComputer.tsx','app/captions.tsx']) {
    const source = ts.createSourceFile(file, readFileSync(join(root, file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function visit(node: ts.Node) {
      if (ts.isJsxText(node)) expect({ file, literal: node.text.trim().replace(/[^a-zA-Z]/g, '') }).toEqual({ file, literal: '' });
      if (ts.isJsxAttribute(node) && ['label','title','placeholder','accessibilityLabel'].includes(node.name.getText(source)) && node.initializer && ts.isStringLiteral(node.initializer)) expect({ file, literal: node.initializer.text }).toEqual({ file, literal: '' });
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
});
