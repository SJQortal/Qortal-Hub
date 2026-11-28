import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../background/background', () => ({
  getApiKeyFromStorage: vi.fn(async () => ({
    apikey: 'test-key',
    url: 'http://127.0.0.1:12391',
  })),
}));

import {
  deletePath,
  HostedListChanged,
  isDefaultIdentifier,
  parseHostedPage,
  previewKind,
  readHostedForName,
  readPreviewState,
  removeHostedItem,
  resourcePath,
  scanHosted,
  type HostedItem,
} from './nodeData';

const NODE = 'http://127.0.0.1:12391';

const respond = (body: unknown, status = 200) =>
  ({
    json: async () => body,
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  }) as Response;

const item = (overrides: Partial<HostedItem> = {}): HostedItem => ({
  chunkCount: 2,
  creatorAddress: 'QPublisherAddress',
  identifier: 'pic',
  name: 'Publisher',
  service: 'IMAGE',
  signature: 'sig-1',
  size: 1000,
  timestamp: 1_000,
  totalSpace: 900,
  ...overrides,
});

const fetchMock =
  vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the node's shared data", () => {
  it('reads a page and leaves out what is not an item', () => {
    const page = parseHostedPage({
      count: 3,
      items: [item(), { name: 'No service' }, item({ identifier: null })],
      totalSpace: 5000,
    });
    expect(page.count).toBe(3);
    expect(page.items).toHaveLength(2);
    expect(page.pageLength).toBe(3);
    expect(() => parseHostedPage([])).toThrow();
  });

  it('sorts the whole list by name and service, page by page', async () => {
    const pages = [
      [
        item({ signature: 'a', timestamp: 5, totalSpace: 300 }),
        item({
          name: 'publisher',
          service: 'VIDEO',
          signature: 'b',
          timestamp: 9,
          totalSpace: 200,
        }),
      ],
      [item({ name: 'Other', signature: 'c', timestamp: 7, totalSpace: 100 })],
    ];
    fetchMock.mockImplementation(async (url) => {
      const offset = Number(new URL(url).searchParams.get('offset'));
      return respond({
        count: 3,
        items: pages[offset / 2] ?? [],
        totalSpace: 600,
      });
    });
    const progress: [number, number][] = [];

    const scan = await scanHosted(
      NODE,
      undefined,
      (read, total) => progress.push([read, total]),
      { pageSize: 2 }
    );

    expect(scan.complete).toBe(true);
    expect(scan.count).toBe(3);
    expect(scan.totalSpace).toBe(600);
    // One name, whatever its spelling, as Core matches names.
    expect(scan.byName).toEqual([
      { count: 2, name: 'Publisher', newest: 9, space: 500 },
      { count: 1, name: 'Other', newest: 7, space: 100 },
    ]);
    expect(scan.byService.map((share) => share.service)).toEqual([
      'IMAGE',
      'VIDEO',
    ]);
    expect(scan.biggest.map((entry) => entry.signature)).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(scan.newest.map((entry) => entry.signature)).toEqual([
      'b',
      'c',
      'a',
    ]);
    expect(progress).toEqual([
      [2, 3],
      [3, 3],
    ]);
  });

  it('starts over when Core counts its list again meanwhile', async () => {
    let calls = 0;
    fetchMock.mockImplementation(async () =>
      respond({
        count: calls++ === 0 ? 4 : 5,
        items: [item(), item()],
        totalSpace: 10,
      })
    );
    await expect(
      scanHosted(NODE, undefined, undefined, { pageSize: 2 })
    ).rejects.toBeInstanceOf(HostedListChanged);
  });

  it("keeps only the name itself from Core's prefix filter", async () => {
    fetchMock.mockResolvedValueOnce(
      respond({
        count: 3,
        items: [
          item(),
          item({ name: 'Publisher TV' }),
          item({ name: 'PUBLISHER' }),
        ],
        totalSpace: 0,
      })
    );
    const { complete, items } = await readHostedForName(NODE, 'Publisher');
    expect(complete).toBe(true);
    expect(items.map((entry) => entry.name)).toEqual([
      'Publisher',
      'PUBLISHER',
    ]);
    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get('name')).toBe(
      'Publisher'
    );
  });
});

describe('previews', () => {
  it('knows which services show and which are encrypted', () => {
    expect(previewKind('IMAGE')).toBe('image');
    expect(previewKind('VIDEO')).toBe('video');
    expect(previewKind('VOICE')).toBe('audio');
    expect(previewKind('DOCUMENT')).toBe('text');
    expect(previewKind('DOCUMENT_PRIVATE')).toBeNull();
    expect(previewKind('APP')).toBeNull();
    expect(['', 'null', 'default', null].every(isDefaultIdentifier)).toBe(true);
    expect(resourcePath('/arbitrary', item({ identifier: 'default' }))).toBe(
      '/arbitrary/IMAGE/Publisher'
    );
    expect(resourcePath('/arbitrary', item({ identifier: 'a/b' }))).toBe(
      '/arbitrary/IMAGE/Publisher/a%2Fb'
    );
  });

  it('reads nothing for encrypted data or a kind with no preview', async () => {
    expect(
      await readPreviewState(NODE, item({ service: 'MAIL_PRIVATE' }))
    ).toBe('private');
    expect(await readPreviewState(NODE, item({ service: 'APP' }))).toBe('none');
    expect(
      await readPreviewState(NODE, item({ service: 'DOCUMENT', size: 300_000 }))
    ).toBe('too_big');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  const answer = (status: unknown, latest: unknown) =>
    fetchMock.mockImplementation(async (url) =>
      new URL(url).pathname.startsWith('/arbitrary/resource/status/')
        ? respond(status)
        : respond(latest)
    );

  it('shows an item only when all of it is here and it is the newest', async () => {
    answer({ localChunkCount: 2, status: 'DOWNLOADED', totalChunkCount: 2 }, [
      {
        identifier: 'pic',
        latestSignature: 'sig-1',
        name: 'publisher',
        service: 'IMAGE',
      },
    ]);
    expect(await readPreviewState(NODE, item())).toBe('ready');

    answer({ localChunkCount: 2, status: 'DOWNLOADED', totalChunkCount: 2 }, [
      {
        identifier: 'pic',
        latestSignature: 'sig-2',
        name: 'Publisher',
        service: 'IMAGE',
      },
    ]);
    expect(await readPreviewState(NODE, item())).toBe('older');

    answer(
      { localChunkCount: 1, status: 'DOWNLOADING', totalChunkCount: 2 },
      []
    );
    expect(await readPreviewState(NODE, item())).toBe('partial');
  });

  it('asks first when showing a big item would build a full copy', async () => {
    const latest = [
      {
        identifier: 'pic',
        latestSignature: 'sig-1',
        name: 'Publisher',
        service: 'IMAGE',
      },
    ];
    answer(
      { localChunkCount: 9, status: 'DOWNLOADED', totalChunkCount: 9 },
      latest
    );
    expect(await readPreviewState(NODE, item({ size: 30_000_000 }))).toBe(
      'build_needed'
    );
    // Small, or built already: showing it costs nothing more.
    expect(await readPreviewState(NODE, item({ size: 1_000_000 }))).toBe(
      'ready'
    );
    answer({ localChunkCount: 9, status: 'READY', totalChunkCount: 9 }, latest);
    expect(await readPreviewState(NODE, item({ size: 30_000_000 }))).toBe(
      'ready'
    );
  });
});

describe('removing a file', () => {
  const calls: string[] = [];
  const node = ({
    deleted = 'true',
    followed = false,
    latest = 'sig-1',
    left = 0,
  }: {
    deleted?: string;
    followed?: boolean;
    latest?: string;
    left?: number;
  }) =>
    fetchMock.mockImplementation(async (url, init) => {
      const parsed = new URL(url);
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${parsed.pathname}`);
      if (parsed.searchParams.get('followedonly') === 'true')
        return respond(followed ? [{ name: 'Publisher' }] : []);
      if (parsed.pathname === '/arbitrary/resources/search')
        return respond([
          {
            identifier: 'pic',
            latestSignature: latest,
            name: 'Publisher',
            service: 'IMAGE',
          },
        ]);
      if (method === 'DELETE')
        return { ok: true, status: 200, text: async () => deleted } as Response;
      return respond({
        localChunkCount: left,
        status: 'PUBLISHED',
        totalChunkCount: 2,
      });
    });

  beforeEach(() => {
    calls.length = 0;
  });

  it('removes the newest version with the key, and sees it gone', async () => {
    node({});
    expect(await removeHostedItem(NODE, item())).toBe('removed');
    expect(calls).toContain('DELETE /arbitrary/resource/IMAGE/Publisher/pic');
    expect(deletePath(item({ identifier: null }))).toBe(
      '/arbitrary/resource/IMAGE/Publisher/default'
    );
  });

  it('removes nothing when a list still follows the name, or the file is older', async () => {
    node({ followed: true });
    expect(await removeHostedItem(NODE, item())).toBe('followed');
    node({ latest: 'sig-2' });
    expect(await removeHostedItem(NODE, item())).toBe('older');
    expect(calls.some((call) => call.startsWith('DELETE'))).toBe(false);
  });

  it('says so when the node still holds part of it, or Core said no', async () => {
    // Core keeps the resource's metadata file and counts it as one chunk.
    node({ left: 1 });
    expect(await removeHostedItem(NODE, item())).toBe('removed');
    node({ left: 3 });
    expect(await removeHostedItem(NODE, item())).toBe('not_removed');
    node({ deleted: 'false' });
    expect(await removeHostedItem(NODE, item())).toBe('not_removed');
  });
});
