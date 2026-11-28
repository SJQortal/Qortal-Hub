import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createStore, Provider } from 'jotai';

const keyed = vi.hoisted(() => ({ url: '' }));

vi.mock('../../background/background', () => ({
  getApiKeyFromStorage: vi.fn(async () => ({
    apikey: 'test-key',
    url: keyed.url,
  })),
}));

import { selectedNodeInfoAtom } from '../../atoms/global';
import { HTTPS_EXT_NODE_QORTAL_LINK } from '../../constants/constants';
import { useFollowedNames, usePublishedTotals } from './useFollowedNames';

const respond = (body: string, status = 200) =>
  ({
    json: async () => JSON.parse(body),
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  }) as Response;

/** A node of its own for each test: reads in flight never carry over. */
let port = 20_000;
let node = '';
let list: string[] = [];
let stillFollowedAnswer = '[]';
let holdNextRead: Promise<void> | null = null;
let listReadFails = false;

const fetchMock = vi.fn(
  async (url: string, init?: RequestInit): Promise<Response> => {
    const parsed = new URL(url);
    if (parsed.pathname === '/lists/followedNames') {
      const method = init?.method ?? 'GET';
      if (method === 'GET') {
        if (listReadFails) return respond('', 500);
        const snapshot = JSON.stringify(list);
        if (holdNextRead) {
          const hold = holdNextRead;
          holdNextRead = null;
          await hold;
        }
        return respond(snapshot);
      }
      const { items } = JSON.parse(String(init?.body)) as { items: string[] };
      for (const item of items) {
        if (method === 'POST' && !list.includes(item)) list.push(item);
        if (method === 'DELETE' && list.includes(item))
          list.splice(list.indexOf(item), 1);
      }
      return respond('true');
    }
    if (parsed.pathname === '/arbitrary/resources/search') {
      if (parsed.searchParams.get('followedonly') === 'true')
        return respond(stillFollowedAnswer);
      return respond(
        JSON.stringify([
          { name: 'Publisher', size: 2_000 },
          { name: 'Publisher', size: 500 },
        ])
      );
    }
    return respond('', 404);
  }
);

let store: ReturnType<typeof createStore>;

const wrapper = ({ children }: { children: ReactNode }) => (
  <Provider store={store}>{children}</Provider>
);

const listWrites = () =>
  fetchMock.mock.calls.filter(
    ([url, init]) =>
      new URL(url).pathname === '/lists/followedNames' &&
      (init?.method ?? 'GET') !== 'GET'
  );

beforeEach(() => {
  port += 1;
  node = `http://127.0.0.1:${port}`;
  keyed.url = node;
  list = ['Publisher'];
  stillFollowedAnswer = '[]';
  holdNextRead = null;
  listReadFails = false;
  store = createStore();
  store.set(selectedNodeInfoAtom, { apikey: 'test-key', url: node });
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const mountReady = async () => {
  const hook = renderHook(() => useFollowedNames(), { wrapper });
  await waitFor(() => expect(hook.result.current.status).toBe('ok'));
  return hook;
};

describe('useFollowedNames', () => {
  it("reads the node's list and matches names as Core does", async () => {
    const { result } = await mountReady();
    expect(result.current.available).toBe(true);
    expect(result.current.names).toEqual(['Publisher']);
    expect(result.current.isFollowing('PUBLISHER')).toBe(true);
    expect(result.current.isFollowing('Other')).toBe(false);
  });

  it('follows a name once, whatever its spelling', async () => {
    const { result } = await mountReady();

    let answer: unknown;
    await act(async () => {
      answer = await result.current.follow('Other');
    });
    expect(answer).toEqual({ status: 'done' });
    expect(list).toEqual(['Publisher', 'Other']);
    expect(result.current.isFollowing('other')).toBe(true);

    await act(async () => {
      answer = await result.current.follow('publisher');
    });
    expect(answer).toEqual({ status: 'done' });
    // Already followed: Core would add a second spelling.
    expect(listWrites()).toHaveLength(1);
  });

  it('unfollows every spelling the list holds, and says if another list still follows', async () => {
    list = ['Publisher', 'publisher', 'Other'];
    const { result } = await mountReady();

    let answer: unknown;
    await act(async () => {
      answer = await result.current.unfollow('PUBLISHER');
    });
    expect(answer).toEqual({ status: 'done', stillFollowed: false });
    expect(list).toEqual(['Other']);
    expect(JSON.parse(String(listWrites()[0][1]?.body))).toEqual({
      items: ['Publisher', 'publisher'],
    });
    expect(result.current.isFollowing('Publisher')).toBe(false);

    stillFollowedAnswer = '[{"name":"Other"}]';
    await act(async () => {
      answer = await result.current.unfollow('Other');
    });
    expect(answer).toEqual({ status: 'done', stillFollowed: true });
  });

  it('drops a read that started before a write', async () => {
    let release = () => {};
    holdNextRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The first read takes the list before the follow, and answers after.
    const { result } = renderHook(() => useFollowedNames(), { wrapper });

    await act(async () => {
      await result.current.follow('Other');
    });
    expect(result.current.isFollowing('Other')).toBe(true);

    await act(async () => {
      release();
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.status).toBe('ok'));
    expect(result.current.names).toEqual(['Publisher', 'Other']);
  });

  it('answers busy for a second write of the same name', async () => {
    const { result } = await mountReady();

    let first: Promise<unknown> = Promise.resolve();
    let second: unknown;
    await act(async () => {
      first = result.current.follow('Other');
      second = await result.current.follow('other');
      await first;
    });
    expect(second).toEqual({ status: 'busy' });
    expect(await first).toEqual({ status: 'done' });
  });

  it('keeps a failed read apart from "no names"', async () => {
    listReadFails = true;
    const { result } = renderHook(() => useFollowedNames(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.names).toBeNull();
    expect(result.current.isFollowing('Publisher')).toBeNull();
    expect(result.current.reason).toBe('failed');

    let answer: unknown;
    await act(async () => {
      answer = await result.current.follow('Other');
    });
    // It can't know the node's own spelling, so it writes nothing.
    expect(answer).toEqual({ reason: 'failed', status: 'failed' });
    expect(listWrites()).toHaveLength(0);
  });

  it('reads and changes nothing on the public node', async () => {
    store.set(selectedNodeInfoAtom, {
      apikey: '',
      url: HTTPS_EXT_NODE_QORTAL_LINK,
    });
    const { result } = renderHook(() => useFollowedNames(), { wrapper });

    let answer: unknown;
    await act(async () => {
      answer = await result.current.follow('Other');
    });
    expect(result.current.available).toBe(false);
    expect(result.current.status).toBe('unavailable');
    expect(answer).toEqual({ reason: 'public', status: 'failed' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('usePublishedTotals', () => {
  it("adds up a name's resources, and waits for a name", async () => {
    const { rerender, result } = renderHook(
      ({ name }: { name: string | null }) => usePublishedTotals(name),
      { initialProps: { name: null as string | null }, wrapper }
    );
    expect(result.current.status).toBe('idle');

    rerender({ name: 'Publisher' });
    await waitFor(() => expect(result.current.status).toBe('ok'));
    expect(result.current.totals).toEqual({
      bytes: 2_500,
      complete: true,
      count: 2,
    });
  });
});
