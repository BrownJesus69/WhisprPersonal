import { render, fireEvent } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Alert } from 'react-native';
import Settings from '@/app/(app)/settings';
import { defaults, useSettingsStore } from '@/state/settingsStore';
import { useAuthStore } from '@/state/authStore';
import { useConnectionStore } from '@/state/connectionStore';
import { t } from '@/i18n';
import licenses from '@/generated/licenses.json';
import pkg from '../../package.json';
test('Settings groups are visible and technical settings stay collapsed', async () => {
  useSettingsStore.setState(defaults); useConnectionStore.setState({ status: 'disconnected' }); useAuthStore.setState({ user: null });
  const client = new QueryClient(); const v = await render(<QueryClientProvider client={client}><Settings /></QueryClientProvider>);
  for (const key of ['speech', 'privacy', 'appearance', 'account', 'about'] as const) expect(v.getByRole('header', { name: t(key) })).toBeTruthy();
  expect(v.queryByText(t('chunkLength'))).toBeNull(); expect(v.queryByText(t('integrationsHeading'))).toBeNull();
  expect(v.getByLabelText(t('textCleanup'))).toBeDisabled(); expect(v.getByText(t('notSetUpComputer'))).toBeTruthy();
  await fireEvent.press(v.getByLabelText(t('advanced')));
  expect(v.getByText(t('chunkLength'))).toBeTruthy(); expect(v.getByText(t('integrationsHeading'))).toBeTruthy();
  const alert = jest.spyOn(Alert, 'alert');
  await fireEvent.press(v.getByLabelText(t('deleteAll')));
  expect(alert).toHaveBeenCalledWith(t('deleteAllTitle'), t('deleteAllBody'), expect.any(Array));
  await v.unmount(); client.clear(); alert.mockRestore();
});
test('generated licences contain exactly the direct production dependencies', () => {
  expect(licenses.map(l => l.name).sort()).toEqual(Object.keys(pkg.dependencies).sort());
  for (const entry of licenses) { expect(typeof entry.name).toBe('string'); expect(entry.license.length).toBeGreaterThan(0); }
});
