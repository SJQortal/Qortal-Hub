import { ThemeProvider } from '@mui/material/styles';
import { act, cleanup, render, screen } from '@testing-library/react';
import { getDefaultStore } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Initialises the shared i18n instance so useTranslation resolves real strings.
import '../../i18n/i18n';
import {
  nodeInfosAtom,
  reticulumEnabledAtom,
  selectedNodeInfoAtom,
} from '../../atoms/global';
import { appLockedAtom } from '../../atoms/presence';
import { HTTPS_EXT_NODE_QORTAL_LINK } from '../../constants/constants';
import { darkTheme } from '../../styles/theme-dark';

const NODE = 'https://127.0.0.1:12391';

vi.mock('../../background/background', () => ({
  getApiKeyFromStorage: vi.fn(async () => ({
    apikey: 'test-key',
    url: 'https://127.0.0.1:12391',
  })),
}));

import { NodeManagerHost } from './NodeManager';
import { openNodeManager } from './nodeManagerEvents';

const respond = (body: unknown, status = 200) =>
  ({
    json: async () => body,
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }) as Response;

const fetchMock = vi.fn(async (url: string) => {
  const { pathname } = new URL(url);
  if (pathname === '/lists/followedNames') return respond([]);
  if (pathname === '/arbitrary/hosted/transactions')
    return respond({ count: 0, items: [], totalSpace: 0 });
  if (pathname === '/arbitrary/resources/search') return respond([]);
  return respond('', 404);
});

const store = getDefaultStore();

const renderHost = () =>
  render(
    <ThemeProvider theme={darkTheme}>
      <NodeManagerHost />
    </ThemeProvider>
  );

beforeEach(() => {
  store.set(appLockedAtom, false);
  store.set(reticulumEnabledAtom, false);
  store.set(nodeInfosAtom, {});
  store.set(selectedNodeInfoAtom, { apikey: 'test-key', url: NODE });
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Node Manager: Data', () => {
  it('opens the Data section at the name it was asked for', async () => {
    renderHost();
    act(() => openNodeManager('data', { name: 'Publisher' }));

    // Neither followed nor held here: it says so.
    expect(
      await screen.findByText("Your node holds none of Publisher's files.")
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Data' })).toHaveAttribute(
      'aria-current',
      'page'
    );
  });

  it('leaves out a name that cannot be one', async () => {
    renderHost();
    act(() => openNodeManager('data', { name: ' spaced ' }));

    expect(
      await screen.findByText('Names your node follows')
    ).toBeInTheDocument();
    expect(screen.queryByText(/holds none of/)).toBeNull();
  });

  it('has no Data section on the public node', async () => {
    store.set(selectedNodeInfoAtom, {
      apikey: '',
      url: HTTPS_EXT_NODE_QORTAL_LINK,
    });
    renderHost();
    act(() => openNodeManager('data', { name: 'Publisher' }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Data' })).toBeNull();
    expect(screen.queryByText(/holds none of/)).toBeNull();
    expect(
      fetchMock.mock.calls.some(([url]) =>
        new URL(url).pathname.startsWith('/lists/')
      )
    ).toBe(false);
  });
});
