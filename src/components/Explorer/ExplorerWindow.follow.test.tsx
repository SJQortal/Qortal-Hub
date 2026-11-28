import { useState } from 'react';
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

vi.mock('../../App', () => ({
  getBaseApiReact: () => 'http://node.test',
}));
const keyed = vi.hoisted(() => ({ url: '' }));
// The test setup's stand-in for Hub's background module, with the node's key.
vi.mock('../../background/background', () => ({
  performPowTask: vi.fn(),
  getApiKeyFromStorage: vi.fn(async () => ({
    apikey: 'test-key',
    url: keyed.url,
  })),
}));

import '../../i18n/i18n';
import {
  infoSnackGlobalAtom,
  selectedNodeInfoAtom,
  userInfoAtom,
} from '../../atoms/global';
import { HTTPS_EXT_NODE_QORTAL_LINK } from '../../constants/constants';
import { darkTheme } from '../../styles/theme-dark';
import {
  executeEvent,
  subscribeToEvent,
  unsubscribeFromEvent,
} from '../../utils/events';
import { ExplorerWindow } from './ExplorerWindow';

// Follow in the Explorer, replayed as a user would, against a node that
// keeps its own followed names: the account page reads the account from the
// node Hub uses, the follow layer reads and changes that node's list.

const READER = `Q${'R'.repeat(33)}`;
const PUBLISHER = `Q${'P'.repeat(33)}`;
const OTHER = `Q${'T'.repeat(33)}`;
const PUBLIC_KEY = `${'k'.repeat(44)}`;

type Answer = { status?: number; body: unknown };
type Route = (path: string) => Answer | undefined;

let routes: Route[] = [];
/** A node of its own for each test: the follow layer keeps reads per node. */
let port = 21_000;
let followed: string[] = [];
let listReadFails = false;
let writeStatus = 200;
let writes: Array<{ method: string; items: string[] }> = [];
let stillFollows: string[] = [];
let published: Record<string, number[]> = {};
let holdWrite: Promise<void> | null = null;
let closeExplorer: () => void = () => undefined;
let store: ReturnType<typeof createStore>;

const respond = (body: string, status = 200) =>
  ({
    json: async () => JSON.parse(body),
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  }) as Response;

const account =
  (address: string, names: string[]): Route =>
  (path) => {
    if (path === `/addresses/${address}`)
      return {
        body: {
          address,
          reference: 'ref',
          publicKey: PUBLIC_KEY,
          level: 3,
          blocksMinted: 250_000,
          blocksMintedAdjustment: 0,
          blocksMintedPenalty: 0,
        },
      };
    if (path === `/names/primary/${address}`)
      return { body: { name: names[0], owner: address } };
    if (path.startsWith(`/names/address/${address}`))
      return { body: names.map((name) => ({ name, owner: address })) };
    if (path === `/groups/member/${address}`) return { body: [] };
    if (path === `/addresses/balance/${address}`) return { body: 12.5 };
    if (path.startsWith(`/blocks/signer/${address}`)) return { body: [] };
    return undefined;
  };

const quiet: Route = (path) => {
  if (path.startsWith('/transactions/search?')) return { body: [] };
  if (path === '/addresses/online') return { body: [] };
  if (path.startsWith('/groups/members/1?')) return { body: { members: [] } };
  if (path.startsWith('/transactions/')) return { body: [] };
  if (path === '/admin/status') return { status: 500, body: {} };
  return undefined;
};

beforeEach(() => {
  port += 1;
  keyed.url = `http://node.test:${port}`;
  routes = [];
  followed = [];
  listReadFails = false;
  writeStatus = 200;
  writes = [];
  stillFollows = [];
  published = {};
  holdWrite = null;
  window.localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.origin === new URL(keyed.url).origin) {
        if (url.pathname === '/lists/followedNames') {
          const method = init?.method ?? 'GET';
          if (method === 'GET')
            return listReadFails
              ? respond('', 500)
              : respond(JSON.stringify(followed));
          const { items } = JSON.parse(String(init?.body)) as {
            items: string[];
          };
          writes.push({ method, items });
          if (holdWrite) await holdWrite;
          if (writeStatus !== 200) return respond('', writeStatus);
          for (const item of items) {
            if (method === 'POST' && !followed.includes(item))
              followed = [...followed, item];
            if (method === 'DELETE')
              followed = followed.filter((entry) => entry !== item);
          }
          return respond('true');
        }
        if (url.pathname === '/arbitrary/resources/search') {
          const name = url.searchParams.get('name') ?? '';
          if (url.searchParams.get('followedonly') === 'true')
            return respond(
              JSON.stringify(stillFollows.includes(name) ? [{ name }] : [])
            );
          return respond(
            JSON.stringify(
              (published[name] ?? []).map((size) => ({ name, size }))
            )
          );
        }
        return respond('', 404);
      }
      const path = url.pathname + url.search;
      for (const route of [...routes, quiet]) {
        const answer = route(path);
        if (answer)
          return respond(JSON.stringify(answer.body), answer.status ?? 200);
      }
      return respond(JSON.stringify({ error: 999, message: 'no route' }), 404);
    })
  );
  // Hub's bridge to the node's block lists, which Block reads.
  (window as unknown as { sendMessage: unknown }).sendMessage = vi.fn(
    async (_type: string, payload: { type: string }) =>
      payload.type === 'get' ? [] : true
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as unknown as { sendMessage?: unknown }).sendMessage;
});

function Harness() {
  const [open, setOpen] = useState(false);
  closeExplorer = () => setOpen(false);
  return (
    <ExplorerWindow isOpenDrawerLookup={open} setIsOpenDrawerLookup={setOpen} />
  );
}

function renderExplorer({ publicNode = false } = {}) {
  store = createStore();
  store.set(userInfoAtom, { address: READER, name: 'Reader' } as never);
  store.set(selectedNodeInfoAtom, {
    apikey: 'test-key',
    url: publicNode ? HTTPS_EXT_NODE_QORTAL_LINK : keyed.url,
  });
  render(
    <Provider store={store}>
      <ThemeProvider theme={darkTheme}>
        <Harness />
      </ThemeProvider>
    </Provider>
  );
}

/** Names are isolated for right-to-left text; compare them without that. */
const plain = (text: string) => text.replace(/[⁦-⁩]/g, '');
const named = (text: string) => (name: string) => plain(name) === text;

const openAccount = async (address: string, heading: string) => {
  act(() => {
    executeEvent('openUserLookupDrawer', { addressOrName: address });
  });
  await screen.findByRole('heading', { level: 2, name: named(heading) });
};

const snack = () => plain(store.get(infoSnackGlobalAtom)?.message ?? '');

describe('Follow in the Explorer', () => {
  it("follows the account's name from the header, after saying how much it has published", async () => {
    routes.push(account(PUBLISHER, ['Publisher']));
    published = { Publisher: [2_000, 1_000] };
    renderExplorer();
    await openAccount(PUBLISHER, 'Publisher');

    const follow = await screen.findByRole('button', {
      name: named('Follow Publisher'),
    });
    await waitFor(() => expect(follow).toBeEnabled());
    fireEvent.click(follow);

    const ask = await screen.findByRole('dialog', {
      name: named('Follow Publisher?'),
    });
    await within(ask).findByText("They've published about 3 kB.");
    // Nothing is written before the question is answered.
    expect(writes).toEqual([]);

    fireEvent.click(within(ask).getByRole('button', { name: 'Follow' }));

    await screen.findByRole('button', { name: named('Following Publisher') });
    expect(writes).toEqual([{ items: ['Publisher'], method: 'POST' }]);
    expect(followed).toEqual(['Publisher']);
    expect(snack()).toBe('Your node now follows Publisher.');
  });

  it('opens the Node Manager at the name from Following, and closes the Explorer', async () => {
    routes.push(account(PUBLISHER, ['Publisher']));
    followed = ['Publisher'];
    const opened: unknown[] = [];
    const listen = (event: CustomEvent) => opened.push(event.detail);
    subscribeToEvent('openNodeManager', listen);
    try {
      renderExplorer();
      await openAccount(PUBLISHER, 'Publisher');
      fireEvent.click(
        await screen.findByRole('button', {
          name: named('Following Publisher'),
        })
      );
      fireEvent.click(
        await screen.findByRole('menuitem', {
          name: 'Their files on your node',
        })
      );
      expect(opened).toEqual([{ name: 'Publisher', section: 'data' }]);
      await waitFor(() =>
        expect(
          screen.queryByRole('heading', {
            level: 2,
            name: named('Publisher'),
          })
        ).toBeNull()
      );
    } finally {
      unsubscribeFromEvent('openNodeManager', listen);
    }
  });

  it("unfollows, and says when another app's list still follows the name", async () => {
    routes.push(account(PUBLISHER, ['Publisher']));
    followed = ['Publisher'];
    stillFollows = ['Publisher'];
    renderExplorer();
    await openAccount(PUBLISHER, 'Publisher');

    fireEvent.click(
      await screen.findByRole('button', { name: named('Following Publisher') })
    );
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Unfollow' }));
    const ask = await screen.findByRole('dialog', {
      name: named('Unfollow Publisher?'),
    });
    within(ask).getByText('Your node will stop fetching their new files.');
    fireEvent.click(within(ask).getByRole('button', { name: 'Unfollow' }));

    await screen.findByRole('button', { name: named('Follow Publisher') });
    expect(writes).toEqual([{ items: ['Publisher'], method: 'DELETE' }]);
    expect(snack()).toBe(
      "Your node still follows Publisher through another app's list of names."
    );
  });

  it("keeps its question open with the node's reason when the change fails", async () => {
    routes.push(account(PUBLISHER, ['Publisher']));
    writeStatus = 403;
    renderExplorer();
    await openAccount(PUBLISHER, 'Publisher');

    const follow = await screen.findByRole('button', {
      name: named('Follow Publisher'),
    });
    await waitFor(() => expect(follow).toBeEnabled());
    fireEvent.click(follow);
    const ask = await screen.findByRole('dialog', {
      name: named('Follow Publisher?'),
    });
    fireEvent.click(within(ask).getByRole('button', { name: 'Follow' }));

    expect(
      plain((await within(ask).findByRole('alert')).textContent ?? '')
    ).toBe(
      "Couldn't change the names your node follows: The node refused Hub's API key."
    );
    expect(ask).toBeInTheDocument();
    expect(followed).toEqual([]);
    expect(snack()).toBe('');
    // Answered again once the node takes it.
    writeStatus = 200;
    fireEvent.click(within(ask).getByRole('button', { name: 'Follow' }));
    await screen.findByRole('button', { name: named('Following Publisher') });
    expect(followed).toEqual(['Publisher']);
  });

  it("on the public node: the header's Follow is off, names have none, and no list is read", async () => {
    routes.push(account(PUBLISHER, ['Publisher', 'Second']));
    renderExplorer({ publicNode: true });
    await openAccount(PUBLISHER, 'Publisher');

    expect(
      await screen.findByRole('button', { name: 'Follow' })
    ).toBeDisabled();
    expect(
      screen.getByLabelText(
        'Following is for your own node, which keeps their files. Hub is using the public node.'
      )
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Names' }));
    await waitFor(() =>
      expect(
        [...document.querySelectorAll('[data-name-head]')].map((head) =>
          plain(head.textContent ?? '')
        )
      ).toEqual(['Publisher', 'Second'])
    );
    expect(
      within(screen.getByRole('tabpanel')).queryAllByRole('button', {
        name: /follow/i,
      })
    ).toEqual([]);
    const fetched = vi.mocked(fetch).mock.calls.map(([input]) => String(input));
    expect(fetched.some((url) => url.includes('/lists/'))).toBe(false);
  });

  it("waits for the node's list: Follow stays off while it can't be read, and a retry reads it again", async () => {
    routes.push(account(PUBLISHER, ['Publisher']));
    listReadFails = true;
    renderExplorer();
    await openAccount(PUBLISHER, 'Publisher');

    const again = await screen.findByRole('button', {
      name: 'Read the names your node follows again',
    });
    expect(screen.getByRole('button', { name: 'Follow' })).toBeDisabled();

    listReadFails = false;
    fireEvent.click(again);
    const follow = await screen.findByRole('button', {
      name: named('Follow Publisher'),
    });
    expect(follow).toBeEnabled();
    expect(
      screen.queryByRole('button', {
        name: 'Read the names your node follows again',
      })
    ).toBeNull();
  });

  it('picks among several names: the ones followed are ticked, and Save follows and unfollows the difference', async () => {
    routes.push(account(PUBLISHER, ['Publisher', 'Second']));
    followed = ['Second'];
    renderExplorer();
    await openAccount(PUBLISHER, 'Publisher');

    fireEvent.click(
      await screen.findByRole('button', { name: 'Following 1/2' })
    );
    fireEvent.click(
      await screen.findByRole('menuitem', {
        name: 'Choose the names to follow',
      })
    );
    const ask = await screen.findByRole('dialog', {
      name: 'Which of their names should your node follow?',
    });
    const publisher = within(ask).getByRole('checkbox', { name: 'Publisher' });
    const second = within(ask).getByRole('checkbox', { name: 'Second' });
    expect(publisher).not.toBeChecked();
    expect(second).toBeChecked();
    // Nothing to save until something changes.
    expect(within(ask).getByRole('button', { name: 'Save' })).toBeDisabled();

    fireEvent.click(publisher);
    fireEvent.click(second);
    fireEvent.click(within(ask).getByRole('button', { name: 'Save' }));

    await screen.findByRole('button', { name: 'Following 1/2' });
    await waitFor(() =>
      expect(writes).toEqual([
        { items: ['Publisher'], method: 'POST' },
        { items: ['Second'], method: 'DELETE' },
      ])
    );
    expect(followed).toEqual(['Publisher']);
    expect(snack()).toBe('Saved the names your node follows.');
  });

  it('a name on the Names tab follows just that name', async () => {
    routes.push(account(PUBLISHER, ['Publisher', 'Second']));
    renderExplorer();
    await openAccount(PUBLISHER, 'Publisher');

    fireEvent.click(screen.getByRole('tab', { name: 'Names' }));
    const follow = await screen.findByRole('button', {
      name: named('Follow Second'),
    });
    await waitFor(() => expect(follow).toBeEnabled());
    fireEvent.click(follow);
    const ask = await screen.findByRole('dialog', {
      name: named('Follow Second?'),
    });
    fireEvent.click(within(ask).getByRole('button', { name: 'Follow' }));

    await screen.findByRole('button', { name: named('Following Second') });
    expect(writes).toEqual([{ items: ['Second'], method: 'POST' }]);
  });

  it('closes its question when a Q-App opens another account meanwhile, also when going back', async () => {
    routes.push(account(PUBLISHER, ['Publisher']), account(OTHER, ['Other']));
    renderExplorer();
    await openAccount(PUBLISHER, 'Publisher');

    const follow = await screen.findByRole('button', {
      name: named('Follow Publisher'),
    });
    await waitFor(() => expect(follow).toBeEnabled());
    fireEvent.click(follow);
    await screen.findByRole('dialog', { name: named('Follow Publisher?') });

    act(() => {
      executeEvent('openUserLookupDrawer', { addressOrName: OTHER });
    });
    await screen.findByRole('heading', {
      hidden: true,
      level: 2,
      name: named('Other'),
    });
    expect(
      screen.queryByRole('dialog', { name: named('Follow Publisher?') })
    ).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await screen.findByRole('heading', { level: 2, name: named('Publisher') });
    await screen.findByRole('button', { name: named('Follow Publisher') });
    expect(
      screen.queryByRole('dialog', { name: named('Follow Publisher?') })
    ).toBeNull();
    expect(writes).toEqual([]);
  });

  it('tells how it went when the Explorer closed before the node answered: done, or the reason it failed', async () => {
    routes.push(account(PUBLISHER, ['Publisher']));
    const hold = () => {
      let release: () => void = () => undefined;
      holdWrite = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    };
    const followThenClose = async () => {
      renderExplorer();
      await openAccount(PUBLISHER, 'Publisher');
      const follow = await screen.findByRole('button', {
        name: named('Follow Publisher'),
      });
      await waitFor(() => expect(follow).toBeEnabled());
      fireEvent.click(follow);
      const ask = await screen.findByRole('dialog', {
        name: named('Follow Publisher?'),
      });
      fireEvent.click(within(ask).getByRole('button', { name: 'Follow' }));
      await waitFor(() => expect(writes.length).toBeGreaterThan(0));
      act(() => closeExplorer());
      // Gone from the page before the node answers.
      await waitFor(() =>
        expect(
          screen.queryByRole('dialog', { name: named('Follow Publisher?') })
        ).toBeNull()
      );
    };

    let release = hold();
    writeStatus = 403;
    await followThenClose();
    await act(async () => release());
    await waitFor(() =>
      expect(snack()).toBe(
        "Couldn't change the names your node follows: The node refused Hub's API key."
      )
    );
    expect(store.get(infoSnackGlobalAtom)?.type).toBe('error');
    cleanup();

    release = hold();
    writeStatus = 200;
    await followThenClose();
    await act(async () => release());
    await waitFor(() =>
      expect(snack()).toBe('Your node now follows Publisher.')
    );
    expect(followed).toEqual(['Publisher']);
  });
});
