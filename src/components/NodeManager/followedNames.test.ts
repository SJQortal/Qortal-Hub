import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const NODE = 'http://127.0.0.1:12391';

vi.mock('../../background/background', () => ({
  getApiKeyFromStorage: vi.fn(async () => ({
    apikey: 'test-key',
    url: 'http://127.0.0.1:12391',
  })),
}));

import { NodeAdminError } from './nodeAdmin';
import {
  cleanFollowName,
  entriesFor,
  nodeStillFollows,
  parseFollowedNames,
  readFollowedNames,
  readPublishedTotals,
  sameName,
  writeFollowedNames,
} from './followedNames';

const respond = (body: string, status = 200) =>
  ({
    json: async () => JSON.parse(body),
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  }) as Response;

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
  async () => respond('[]')
);

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => respond('[]'));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    return error instanceof NodeAdminError ? error.reason : 'other';
  }
};

describe('names as Core matches them', () => {
  it('takes two spellings of one name as the same, as Java ignores case', () => {
    expect(sameName('Publisher', 'publisher')).toBe(true);
    expect(sameName('ÄRGER', 'ärger')).toBe(true);
    expect(sameName('Publisher', 'Publisher2')).toBe(false);
    // Java maps one character at a time: "ß" has no one-letter capital.
    expect(sameName('straße', 'STRASSE')).toBe(false);
    expect(sameName('straße', 'STRAßE')).toBe(true);
  });

  it('finds every spelling of a name in a list', () => {
    expect(
      entriesFor(
        ['Publisher', 'Other', 'publisher', 'PUBLISHER x'],
        'PUBLISHER'
      )
    ).toEqual(['Publisher', 'publisher']);
  });

  it('takes only text that can be a name', () => {
    expect(cleanFollowName('Publisher')).toBe('Publisher');
    expect(cleanFollowName(' Publisher')).toBeNull();
    expect(cleanFollowName('')).toBeNull();
    expect(cleanFollowName('a\u0007b')).toBeNull();
    expect(cleanFollowName('x'.repeat(121))).toBeNull();
    expect(cleanFollowName(42)).toBeNull();
  });
});

describe("the node's followed names", () => {
  it('reads the list with the key, and an empty answer is a failed read', async () => {
    fetchMock.mockResolvedValueOnce(respond('["Publisher","Other"]'));
    expect(await readFollowedNames(NODE)).toEqual(['Publisher', 'Other']);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${NODE}/lists/followedNames?apiKey=test-key`);
    expect(init?.method).toBe('GET');

    // Core answers nothing when it couldn't load the list: not "no names".
    fetchMock.mockResolvedValueOnce(respond(''));
    expect(await failure(readFollowedNames(NODE))).toBe('failed');
    expect(() => parseFollowedNames('{"items":[]}')).toThrow();
    expect(parseFollowedNames('[]')).toEqual([]);
  });

  it('writes items as JSON, and anything but "true" is a failure', async () => {
    fetchMock.mockResolvedValueOnce(respond('true'));
    await writeFollowedNames(NODE, 'DELETE', ['Publisher', 'publisher']);
    const [, init] = fetchMock.mock.calls[0];
    expect(init).toMatchObject({
      body: '{"items":["Publisher","publisher"]}',
      headers: { 'Content-Type': 'application/json' },
      method: 'DELETE',
    });

    fetchMock.mockResolvedValueOnce(respond('false'));
    expect(await failure(writeFollowedNames(NODE, 'POST', ['Publisher']))).toBe(
      'failed'
    );
  });

  it("asks whether any of the node's lists still follows a name", async () => {
    fetchMock.mockResolvedValueOnce(respond('[{"name":"publisher"}]'));
    expect(await nodeStillFollows(NODE, 'Publisher')).toBe(true);
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe('/arbitrary/resources/search');
    expect(url.searchParams.get('followedonly')).toBe('true');
    expect(url.searchParams.get('exactmatchnames')).toBe('true');
    expect(url.searchParams.get('apiKey')).toBeNull();

    fetchMock.mockResolvedValueOnce(respond('[]'));
    expect(await nodeStillFollows(NODE, 'Publisher')).toBe(false);
  });
});

describe('what a name has published', () => {
  it('counts every resource of the name, page by page, with its size', async () => {
    fetchMock
      .mockResolvedValueOnce(
        respond(
          JSON.stringify([
            { name: 'Publisher', size: 100 },
            { name: 'publisher', size: 50 },
          ])
        )
      )
      .mockResolvedValueOnce(
        respond(
          JSON.stringify([
            { name: 'Publisher', size: 'big' },
            // Not the name asked for: left out.
            { name: 'Publisher2', size: 1000 },
          ])
        )
      )
      .mockResolvedValueOnce(respond(JSON.stringify([{ name: 'Publisher' }])));

    const totals = await readPublishedTotals(NODE, 'Publisher', undefined, {
      pageSize: 2,
    });

    expect(totals).toEqual({ bytes: 150, complete: true, count: 4 });
    const pages = fetchMock.mock.calls.map(([url]) => new URL(url));
    expect(pages.map((url) => url.searchParams.get('offset'))).toEqual([
      '0',
      '2',
      '4',
    ]);
    // The search's default keeps only the newest resource of each service.
    expect(pages[0].searchParams.get('mode')).toBe('ALL');
    expect(pages[0].searchParams.get('exactmatchnames')).toBe('true');
    expect(pages[0].searchParams.get('name')).toBe('Publisher');
  });

  it('stops at its limit and says the totals are a floor', async () => {
    fetchMock.mockImplementation(async () =>
      respond(
        JSON.stringify([
          { name: 'Publisher', size: 1 },
          { name: 'Publisher', size: 1 },
        ])
      )
    );
    expect(
      await readPublishedTotals(NODE, 'Publisher', undefined, {
        maxPages: 2,
        pageSize: 2,
      })
    ).toEqual({ bytes: 4, complete: false, count: 4 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails on an answer that is not a list, instead of counting nothing', async () => {
    fetchMock.mockResolvedValueOnce(respond('{"error":1201}'));
    await expect(readPublishedTotals(NODE, 'Publisher')).rejects.toThrow();
  });
});
