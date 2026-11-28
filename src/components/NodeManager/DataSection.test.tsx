import { ThemeProvider } from '@mui/material/styles';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Initialises the shared i18n instance so useTranslation resolves real strings.
import '../../i18n/i18n';
import {
  blockedAddressesAtom,
  rawWalletAtom,
  selectedNodeInfoAtom,
  userInfoAtom,
} from '../../atoms/global';
import { darkTheme } from '../../styles/theme-dark';

const keyed = vi.hoisted(() => ({ url: '' }));

vi.mock('../../background/background', () => ({
  getApiKeyFromStorage: vi.fn(async () => ({
    apikey: 'test-key',
    url: keyed.url,
  })),
}));

import { DataSection, type DataFocus } from './DataSection';

const respond = (body: unknown, status = 200) =>
  ({
    json: async () => body,
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }) as Response;

const hosted = (
  name: string,
  service: string,
  identifier: string,
  totalSpace: number,
  creatorAddress = 'QSomeoneElse'
) => ({
  chunkCount: 1,
  creatorAddress,
  identifier,
  name,
  service,
  signature: `${name}-${service}-${identifier}`,
  size: totalSpace,
  timestamp: 1_700_000_000_000,
  totalSpace,
});

const HOSTED = [
  hosted('Other', 'AUDIO', 'old', 300_000),
  hosted('Mine', 'IMAGE', 'self', 1_000, 'QMine'),
  hosted('Publisher', 'VIDEO', 'film', 2_000_000_000),
  hosted('Publisher', 'IMAGE', 'pic', 2_000_000),
  hosted('Publisher', 'MAIL_PRIVATE', 'mail', 1_000_000),
  hosted('Other', 'VIDEO', 'clip', 500_000),
];

let port = 30_000;
let node = '';
let list: string[] = [];
let deleted = new Set<string>();
let alsoFollowed = false;

const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  const parsed = new URL(url);
  const { pathname, searchParams } = parsed;
  const method = init?.method ?? 'GET';
  if (pathname === '/lists/followedNames') {
    if (method === 'GET') return respond(list);
    const { items } = JSON.parse(String(init?.body)) as { items: string[] };
    list =
      method === 'DELETE'
        ? list.filter((entry) => !items.includes(entry))
        : [...list, ...items];
    return respond('true');
  }
  if (pathname === '/arbitrary/hosted/transactions') {
    const name = searchParams.get('name');
    const items = name
      ? HOSTED.filter((entry) => entry.name.startsWith(name))
      : HOSTED;
    return respond({
      count: items.length,
      items: Number(searchParams.get('offset')) === 0 ? items : [],
      totalSpace: items.reduce((sum, entry) => sum + entry.totalSpace, 0),
    });
  }
  if (pathname === '/arbitrary/resources/search') {
    if (searchParams.get('followedonly') === 'true')
      return respond(alsoFollowed ? [{ name: searchParams.get('name') }] : []);
    if (searchParams.get('service'))
      return respond([
        {
          identifier: searchParams.get('identifier'),
          latestSignature:
            searchParams.get('identifier') === 'old'
              ? 'a-newer-version'
              : `${searchParams.get('name')}-${searchParams.get('service')}-${searchParams.get('identifier')}`,
          name: searchParams.get('name'),
          service: searchParams.get('service'),
        },
      ]);
    if (searchParams.get('name') === 'Other')
      return respond([
        {
          identifier: 'clip',
          latestSignature: 'Other-VIDEO-clip',
          name: 'Other',
          service: 'VIDEO',
          size: 500_000,
        },
        // Its newest version is one the node doesn't hold.
        {
          identifier: 'old',
          latestSignature: 'a-newer-version',
          name: 'Other',
          service: 'AUDIO',
          size: 300_000,
        },
      ]);
    return respond([{ name: searchParams.get('name'), size: 4_000_000 }]);
  }
  if (method === 'DELETE' && pathname.startsWith('/arbitrary/resource/')) {
    deleted.add(pathname);
    return respond('true');
  }
  if (pathname.startsWith('/arbitrary/resource/status/'))
    return respond({
      localChunkCount: deleted.has(
        pathname.replace('/arbitrary/resource/status/', '/arbitrary/resource/')
      )
        ? 1
        : 1,
      // The film is held as chunks only; the rest is built already.
      status: deleted.has(
        pathname.replace('/arbitrary/resource/status/', '/arbitrary/resource/')
      )
        ? 'PUBLISHED'
        : pathname.endsWith('/film')
          ? 'DOWNLOADED'
          : 'READY',
      totalChunkCount: 1,
    });
  if (pathname.startsWith('/names/')) {
    const name = decodeURIComponent(pathname.slice('/names/'.length));
    if (name === 'Broken') return respond('', 500);
    const owner = ({ Quiet: 'QQuiet', Spammer: 'QSpammer' } as const)[
      name as 'Quiet' | 'Spammer'
    ];
    return owner ? respond({ name, owner }) : respond({ error: 401 }, 404);
  }
  return respond('', 404);
});

let store: ReturnType<typeof createStore>;

const renderSection = (focus: DataFocus | null = null) =>
  render(
    <Provider store={store}>
      <ThemeProvider theme={darkTheme}>
        <DataSection focus={focus} nodeBase={node} />
      </ThemeProvider>
    </Provider>
  );

const followedRow = async (name: string) => {
  await waitFor(() =>
    expect(
      document.querySelector(`[data-followed-name="${name}"]`)
    ).not.toBeNull()
  );
  return within(
    document.querySelector(`[data-followed-name="${name}"]`) as HTMLElement
  );
};

beforeEach(() => {
  port += 1;
  node = `http://127.0.0.1:${port}`;
  keyed.url = node;
  list = ['Publisher'];
  deleted = new Set();
  alsoFollowed = false;
  store = createStore();
  store.set(selectedNodeInfoAtom, { apikey: 'test-key', url: node });
  store.set(userInfoAtom, { address: 'QMine' });
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('DataSection', () => {
  it('lists each followed name with what the node holds and what they published', async () => {
    renderSection();
    const row = await followedRow('Publisher');
    expect(
      await row.findByText(/Held here: 3 items · 2 GB/)
    ).toBeInTheDocument();
    expect(
      await row.findByText(/Published: 1 items · 4 MB/)
    ).toBeInTheDocument();
    // The whole list, by name: both names, the followed one marked.
    expect(
      await screen.findByRole('row', { name: 'Other' })
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Your node shares 6 items, 2 GB on disk/)
    ).toBeInTheDocument();
  });

  it("opens a name's files right under it in the shared list", async () => {
    renderSection();
    const other = await screen.findByRole('row', { name: 'Other' });
    fireEvent.click(other);

    const opened = await waitFor(() => {
      const row = document.querySelector('[data-expanded-row="other"]');
      expect(row).not.toBeNull();
      return row as HTMLElement;
    });
    // Under the name clicked, not in a card above the followed names.
    expect(other.nextElementSibling).toBe(opened);
    expect(other).toHaveAttribute('aria-expanded', 'true');
    expect(
      await within(opened).findByRole('row', { name: 'VIDEO clip' })
    ).toBeInTheDocument();
    expect(
      document.querySelector('[data-overview-card="name_files"]')
    ).toBeNull();

    fireEvent.click(other);
    await waitFor(() =>
      expect(document.querySelector('[data-expanded-row="other"]')).toBeNull()
    );
  });

  it("opens a followed name's files under that name", async () => {
    renderSection();
    const row = await followedRow('Publisher');
    fireEvent.click(row.getByRole('button', { name: 'Show files' }));

    expect(
      await row.findByRole('row', { name: 'IMAGE pic' })
    ).toBeInTheDocument();
    expect(row.getByRole('button', { name: 'Hide files' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    expect(
      document.querySelector('[data-overview-card="name_files"]')
    ).toBeNull();
  });

  it('removes a file of a name the node does not follow, after asking', async () => {
    renderSection({ name: 'Other', seq: 1 });
    const remove = await screen.findByRole('button', {
      name: 'Remove VIDEO clip from your node',
    });
    // Enter on the × is the ×'s own, not the row's (which opens the file).
    fireEvent.keyDown(remove, { key: 'Enter' });
    expect(screen.queryByRole('dialog', { name: 'VIDEO · Other' })).toBeNull();

    fireEvent.click(remove);
    const dialog = within(
      await screen.findByRole('dialog', {
        name: 'Remove this file from your node?',
      })
    );
    expect(
      dialog.getByText(/deletes its copy of VIDEO clip/)
    ).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(dialog.getByRole('button', { name: 'Remove' }));
    });

    expect(
      await screen.findByText(/Removed from your node: 500 kB freed/)
    ).toBeInTheDocument();
    expect(deleted.has('/arbitrary/resource/VIDEO/Other/clip')).toBe(true);
    expect(screen.getByText('removed')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Remove VIDEO clip from your node' })
    ).toBeNull();
  });

  it('says in the row why a removal did nothing', async () => {
    // A Q-App's list follows the name: Core would fetch the file back.
    alsoFollowed = true;
    renderSection({ name: 'Other', seq: 1 });
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Remove VIDEO clip from your node',
      })
    );
    const dialog = within(
      await screen.findByRole('dialog', {
        name: 'Remove this file from your node?',
      })
    );
    await act(async () => {
      fireEvent.click(dialog.getByRole('button', { name: 'Remove' }));
    });
    // The dialog hides the page while it closes.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(
      await within(screen.getByRole('row', { name: 'VIDEO clip' })).findByRole(
        'button',
        {
          name: /still follows Other, so Core would fetch this again/,
        }
      )
    ).toBeInTheDocument();
    expect(deleted.size).toBe(0);
  });

  it("sorts a name's files by the column clicked, and back on a second click", async () => {
    renderSection({ name: 'Publisher', seq: 1 });
    // Publisher is followed: its files open under its row there.
    const card = () =>
      document.querySelector('[data-followed-name="Publisher"]') as HTMLElement;
    const order = () =>
      [...card().querySelectorAll('tr[aria-label]')].map((row) =>
        row.getAttribute('aria-label')
      );
    await waitFor(() => expect(order()).toHaveLength(3));
    // Biggest on disk first, at first.
    expect(order()).toEqual(['VIDEO film', 'IMAGE pic', 'MAIL_PRIVATE mail']);

    fireEvent.click(
      within(card()).getByRole('button', { name: /^Identifier/ })
    );
    expect(order()).toEqual(['VIDEO film', 'MAIL_PRIVATE mail', 'IMAGE pic']);
    fireEvent.click(
      within(card()).getByRole('button', { name: /^Identifier/ })
    );
    expect(order()).toEqual(['IMAGE pic', 'MAIL_PRIVATE mail', 'VIDEO film']);
  });

  const withFolders = async (
    folderState: (signature: string) => Promise<string>,
    test: (showFolder: ReturnType<typeof vi.fn>) => Promise<void>
  ) => {
    const showFolder = vi.fn(async () => 'shown');
    (window as unknown as { nodeData?: unknown }).nodeData = {
      folderState: vi.fn(folderState),
      showFolder,
    };
    try {
      await test(showFolder);
    } finally {
      delete (window as unknown as { nodeData?: unknown }).nodeData;
    }
  };

  it("opens a file's folder on this PC, and says once it's gone", () =>
    withFolders(
      async () => 'present',
      async (showFolder) => {
        renderSection({ name: 'Other', seq: 1 });
        fireEvent.click(
          await screen.findByRole('button', {
            name: 'Show VIDEO clip in its folder',
          })
        );
        await waitFor(() =>
          expect(showFolder).toHaveBeenCalledWith('Other-VIDEO-clip')
        );

        showFolder.mockResolvedValueOnce('missing');
        fireEvent.click(
          screen.getByRole('button', { name: 'Show VIDEO clip in its folder' })
        );
        const row = screen.getByRole('row', { name: 'VIDEO clip' });
        expect(
          await within(row).findByText('gone from this PC')
        ).toBeInTheDocument();
        expect(within(row).queryAllByRole('button')).toEqual([]);
      }
    ));

  it("says a file is gone from this PC when its folder isn't there", () =>
    withFolders(
      async (signature) =>
        signature === 'Other-VIDEO-clip' ? 'missing' : 'present',
      async () => {
        renderSection({ name: 'Other', seq: 1 });
        const row = await screen.findByRole('row', { name: 'VIDEO clip' });
        const gone = await within(row).findByText('gone from this PC');
        // No folder to open, and nothing left to remove.
        expect(within(row).queryAllByRole('button')).toEqual([]);
        expect(
          await screen.findByRole('button', {
            name: 'Show AUDIO old in its folder',
          })
        ).toBeInTheDocument();

        fireEvent.mouseOver(gone);
        expect(await screen.findByRole('tooltip')).toHaveTextContent(
          "Its folder isn't on this PC any more."
        );

        fireEvent.click(row);
        const dialog = await screen.findByRole('dialog', {
          name: 'VIDEO · Other',
        });
        expect(
          within(dialog).getByText(/^Its folder isn't on this PC any more/)
        ).toBeInTheDocument();
        expect(
          within(dialog).queryByRole('button', { name: 'Show in folder' })
        ).toBeNull();
      }
    ));

  it("offers no folder when Hub can't see Core's data folder", () =>
    withFolders(
      async () => 'unknown',
      async () => {
        renderSection({ name: 'Other', seq: 1 });
        expect(
          await screen.findByRole('button', {
            name: 'Remove VIDEO clip from your node',
          })
        ).toBeInTheDocument();
        expect(
          screen.queryByRole('button', { name: /in its folder$/ })
        ).toBeNull();
        expect(screen.queryByText('gone from this PC')).toBeNull();
      }
    ));

  it('lists the names the node blocks, and unblocks a name with its account', async () => {
    let names = ['Broken', 'Ghost', 'Quiet', 'Spammer'];
    // The Explorer's Block takes Spammer's account as well.
    let addresses = ['QSpammer'];
    let failRead = true;
    let failRemove = true;
    const sendMessage = vi.fn(
      async (
        type: string,
        payload: { items?: string[]; listName: string; type: string }
      ) => {
        if (type !== 'listActions') return {};
        if (payload.type === 'get') {
          if (failRead) return { error: true, message: 'down' };
          return payload.listName === 'blockedNames' ? names : addresses;
        }
        if (failRemove) return { error: true, message: 'down' };
        const keep = (entry: string) => !payload.items?.includes(entry);
        if (payload.listName === 'blockedNames') names = names.filter(keep);
        else addresses = addresses.filter(keep);
        return true;
      }
    );
    const removed = (listName: string, item: string) =>
      sendMessage.mock.calls.some(
        ([, payload]) =>
          payload.type === 'remove' &&
          payload.listName === listName &&
          !!payload.items?.includes(item)
      );
    vi.stubGlobal('sendMessage', sendMessage);
    store.set(rawWalletAtom, { address0: 'QMine' });
    renderSection();
    const card = () =>
      within(
        document.querySelector(
          '[data-overview-card="blocked_names"]'
        ) as HTMLElement
      );
    const gone = (name: string) =>
      waitFor(() =>
        expect(
          card().queryByRole('button', { name: `Unblock ${name}` })
        ).toBeNull()
      );

    // A failed read isn't "no names": it says so, with Retry.
    expect(
      await card().findByText("Hub couldn't read the names your node blocks.")
    ).toBeInTheDocument();
    expect(card().queryByText('Your node blocks no names.')).toBeNull();
    failRead = false;
    fireEvent.click(card().getByRole('button', { name: 'Retry' }));

    // A failed unblock keeps the name, and says so.
    fireEvent.click(
      await card().findByRole('button', { name: 'Unblock Spammer' })
    );
    expect(
      await card().findByText("Hub couldn't unblock Spammer.")
    ).toBeInTheDocument();
    failRemove = false;

    // Its owner's account is blocked too: both go, as in the Explorer.
    fireEvent.click(card().getByRole('button', { name: 'Unblock Spammer' }));
    await gone('Spammer');
    expect(removed('blockedNames', 'Spammer')).toBe(true);
    expect(removed('blockedAddresses', 'QSpammer')).toBe(true);
    expect(store.get(blockedAddressesAtom)).toEqual({});

    // An owner whose account isn't blocked, or no owner: the name only.
    fireEvent.click(card().getByRole('button', { name: 'Unblock Quiet' }));
    await gone('Quiet');
    fireEvent.click(card().getByRole('button', { name: 'Unblock Ghost' }));
    await gone('Ghost');
    expect(removed('blockedAddresses', 'QQuiet')).toBe(false);

    // When the node can't say who owns it, nothing is unblocked.
    fireEvent.click(card().getByRole('button', { name: 'Unblock Broken' }));
    expect(
      await card().findByText("Hub couldn't unblock Broken.")
    ).toBeInTheDocument();
    expect(removed('blockedNames', 'Broken')).toBe(false);
    expect(
      card().getByRole('button', { name: 'Unblock Broken' })
    ).toBeInTheDocument();
  });

  it('offers no × for a followed name or for your own files', async () => {
    renderSection({ name: 'Publisher', seq: 1 });
    expect(
      await screen.findByRole('row', { name: 'IMAGE pic' })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /^Remove IMAGE pic/ })
    ).toBeNull();
    expect(
      screen.getAllByRole('button', {
        name: /Your node follows Publisher, so Core would fetch/,
      }).length
    ).toBeGreaterThan(0);
    cleanup();

    renderSection({ name: 'Mine', seq: 2 });
    expect(
      await screen.findByRole('row', { name: 'IMAGE self' })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /^Remove IMAGE self/ })
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: /You published this/ })
    ).toBeInTheDocument();
    cleanup();

    // An older version: Core can remove only the newest.
    renderSection({ name: 'Other', seq: 3 });
    expect(
      await screen.findByRole('button', { name: /An older version/ })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /^Remove AUDIO old/ })
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Remove VIDEO clip from your node' })
    ).toBeInTheDocument();
  });

  it('asks before an unfollow, and says the node keeps the files it has', async () => {
    renderSection();
    const row = await followedRow('Publisher');
    fireEvent.click(await row.findByRole('button', { name: 'Unfollow' }));

    const dialog = within(
      await screen.findByRole('dialog', { name: 'Unfollow Publisher?' })
    );
    expect(
      dialog.getByText(/keeps the files it already has/)
    ).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(dialog.getByRole('button', { name: 'Unfollow' }));
    });

    expect(
      await screen.findByText('Your node no longer follows Publisher.')
    ).toBeInTheDocument();
    expect(list).toEqual([]);
  });

  it('opens a name it was asked for under its own row, in view', async () => {
    const scrolled: Element[] = [];
    const proto = Element.prototype as unknown as {
      scrollIntoView?: (this: Element) => void;
    };
    proto.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    try {
      // Not followed: its row in the shared data, any spelling.
      renderSection({ name: 'other', seq: 1 });
      const other = await screen.findByRole('row', { name: 'Other' });
      await waitFor(() =>
        expect(other).toHaveAttribute('aria-expanded', 'true')
      );
      const files = document.querySelector(
        '[data-expanded-row="other"]'
      ) as HTMLElement;
      expect(
        await within(files).findByRole('row', { name: 'VIDEO clip' })
      ).toBeInTheDocument();
      await waitFor(() => expect(scrolled).toContain(other));
      expect(
        document.querySelector('[data-overview-card="name_files"]')
      ).toBeNull();
      cleanup();

      // Followed: under its row in the names the node follows, only there.
      renderSection({ name: 'Publisher', seq: 2 });
      const row = await followedRow('Publisher');
      expect(
        await row.findByRole('row', { name: 'IMAGE pic' })
      ).toBeInTheDocument();
      expect(row.getByRole('button', { name: 'Hide files' })).toHaveAttribute(
        'aria-expanded',
        'true'
      );
      await waitFor(() =>
        expect(scrolled).toContain(
          document.querySelector('[data-followed-name="Publisher"]')
        )
      );
      expect(
        document.querySelector('[data-expanded-row="publisher"]')
      ).toBeNull();
    } finally {
      delete proto.scrollIntoView;
    }
  });

  it('asks before showing a big item held only as chunks', async () => {
    renderSection({ name: 'Publisher', seq: 1 });
    fireEvent.click(await screen.findByRole('row', { name: 'VIDEO film' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'VIDEO · Publisher',
    });

    expect(
      await within(dialog).findByText(/put together a full copy/)
    ).toBeInTheDocument();
    expect(dialog.querySelector('video')).toBeNull();

    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Show it anyway' })
    );
    await waitFor(() =>
      expect(dialog.querySelector('video')?.getAttribute('src')).toBe(
        `${node}/arbitrary/VIDEO/Publisher/film`
      )
    );
  });

  it('shows a held picture, and encrypted data by its details only', async () => {
    renderSection({ name: 'Publisher', seq: 1 });

    fireEvent.click(await screen.findByRole('row', { name: 'IMAGE pic' }));
    const picture = await screen.findByRole('dialog', {
      name: 'IMAGE · Publisher',
    });
    await waitFor(() =>
      expect(picture.querySelector('img')?.getAttribute('src')).toBe(
        `${node}/arbitrary/IMAGE/Publisher/pic`
      )
    );
    // An IMAGE that isn't one picture (a zip) says so instead.
    fireEvent.error(picture.querySelector('img') as HTMLImageElement);
    expect(
      await within(picture).findByText('No preview for this kind of data.')
    ).toBeInTheDocument();
    expect(picture.querySelector('img')).toBeNull();
    fireEvent.click(within(picture).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fetchMock.mockClear();
    fireEvent.click(
      await screen.findByRole('row', { name: 'MAIL_PRIVATE mail' })
    );
    const mail = await screen.findByRole('dialog', {
      name: 'MAIL_PRIVATE · Publisher',
    });
    expect(
      await within(mail).findByText('Encrypted: only its details show here.')
    ).toBeInTheDocument();
    expect(mail.querySelector('img')).toBeNull();
    expect(
      fetchMock.mock.calls.some(([url]) =>
        new URL(url).pathname.includes('/resource/status/')
      )
    ).toBe(false);
  });
});
