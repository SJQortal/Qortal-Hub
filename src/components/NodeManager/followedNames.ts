import { NodeAdminError, nodeAdminRequest } from './nodeAdmin';
import { getNodeJson } from './useNodeOverviewData';

/**
 * Core's list of the names a node follows: it fetches and keeps their QDN
 * data. Q-Apps that follow names (Q-Tube+, Q-Share+) use this list too.
 *
 * Core also counts every list whose name starts with `followedNames`, so a
 * name can stay followed through another such list after it leaves this one.
 */
export const FOLLOWED_NAMES_LIST = 'followedNames';

const LIST_PATH = `/lists/${FOLLOWED_NAMES_LIST}`;

/** Longer than any registered name: Core takes 3 to 40 bytes of UTF-8. */
const MAX_NAME_LENGTH = 120;

const hasControlCharacter = (value: string) => {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
};

/**
 * `value` when it can be a Qortal name: text without spaces around it,
 * without control characters and not too long. Null otherwise.
 */
export const cleanFollowName = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (!name || name !== value || name.length > MAX_NAME_LENGTH) return null;
  if (hasControlCharacter(name)) return null;
  return name;
};

/** One code point's own upper or lower case, as Java maps a single char. */
const simpleCase = (codePoint: number, upper: boolean): number => {
  const char = String.fromCodePoint(codePoint);
  const mapped = upper ? char.toUpperCase() : char.toLowerCase();
  // "ß" upper-cases to "SS" here; Java leaves such a char as it is.
  const first = mapped.codePointAt(0);
  return first !== undefined &&
    mapped.length === String.fromCodePoint(first).length
    ? first
    : codePoint;
};

/**
 * Whether Core takes `a` and `b` for the same name: Java's
 * `String.equalsIgnoreCase`, which Core uses to match a followed name.
 */
export const sameName = (a: string, b: string): boolean => {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  const left = Array.from(a);
  const right = Array.from(b);
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    const one = left[i].codePointAt(0) as number;
    const two = right[i].codePointAt(0) as number;
    if (one === two) continue;
    const upperOne = simpleCase(one, true);
    const upperTwo = simpleCase(two, true);
    if (upperOne === upperTwo) continue;
    if (simpleCase(upperOne, false) === simpleCase(upperTwo, false)) continue;
    return false;
  }
  return true;
};

/** The entries of `list` the node counts as `name`: every spelling. */
export const entriesFor = (list: string[], name: string): string[] =>
  list.filter((entry) => sameName(entry, name));

/**
 * The names in Core's answer to `GET /lists/followedNames`. An empty answer
 * means Core couldn't load the list, which isn't the same as "no names".
 */
export const parseFollowedNames = (text: string): string[] => {
  if (!text.trim()) throw new Error('No list');
  const data: unknown = JSON.parse(text);
  if (!Array.isArray(data) || !data.every((item) => typeof item === 'string'))
    throw new Error('Not a list of names');
  return data as string[];
};

/** The node's followed names. Needs Hub's API key for the node. */
export const readFollowedNames = async (
  nodeBase: string,
  signal?: AbortSignal
): Promise<string[]> => {
  const text = await nodeAdminRequest(nodeBase, LIST_PATH, { signal });
  try {
    return parseFollowedNames(text);
  } catch {
    throw new NodeAdminError('failed');
  }
};

/**
 * Adds `items` to the list, or takes them out of it. Core answers "true"
 * once it saved the list; anything else means it put the list back as it
 * was. It takes a list item out only as spelled, so an unfollow sends every
 * spelling the list holds.
 */
export const writeFollowedNames = async (
  nodeBase: string,
  method: 'POST' | 'DELETE',
  items: string[],
  signal?: AbortSignal
): Promise<void> => {
  const answer = await nodeAdminRequest(nodeBase, LIST_PATH, {
    body: JSON.stringify({ items }),
    contentType: 'application/json',
    method,
    signal,
  });
  if (answer !== 'true') throw new NodeAdminError('failed');
};

const searchPath = (params: Record<string, string>) =>
  `/arbitrary/resources/search?${new URLSearchParams(params).toString()}`;

/**
 * Whether the node still follows `name` some way, through any of its
 * `followedNames` lists. Core can only tell for a name that has published
 * something: false means it didn't see one it follows.
 */
export const nodeStillFollows = async (
  nodeBase: string,
  name: string,
  signal?: AbortSignal
): Promise<boolean> => {
  const list = await getNodeJson<unknown>(
    nodeBase,
    searchPath({
      exactmatchnames: 'true',
      followedonly: 'true',
      includemetadata: 'false',
      limit: '1',
      mode: 'ALL',
      name,
    }),
    signal
  );
  if (!Array.isArray(list)) throw new Error('Not a list');
  return list.some(
    (item) =>
      !!item &&
      typeof (item as { name?: unknown }).name === 'string' &&
      sameName((item as { name: string }).name, name)
  );
};

/** What a name has published: its QDN resources and their sizes. */
export type PublishedTotals = {
  /** Resources counted. */
  count: number;
  /** Their published sizes, added up. */
  bytes: number;
  /** False when the count stopped at its limit: "at least". */
  complete: boolean;
};

/** Resources read per page of the search. */
export const PUBLISHED_PAGE_SIZE = 1000;
/** Pages read at most: past that, the totals say "at least". */
export const PUBLISHED_MAX_PAGES = 10;

/**
 * Counts what `name` has published, from Core's resource search: every
 * resource (not only the newest of each service, which is the search's
 * default) with its size. Core matches names ignoring case.
 */
export const readPublishedTotals = async (
  nodeBase: string,
  name: string,
  signal?: AbortSignal,
  {
    maxPages = PUBLISHED_MAX_PAGES,
    pageSize = PUBLISHED_PAGE_SIZE,
  }: { maxPages?: number; pageSize?: number } = {}
): Promise<PublishedTotals> => {
  let bytes = 0;
  let count = 0;
  for (let page = 0; page < maxPages; page++) {
    const list = await getNodeJson<unknown>(
      nodeBase,
      searchPath({
        exactmatchnames: 'true',
        includemetadata: 'false',
        limit: String(pageSize),
        mode: 'ALL',
        name,
        offset: String(page * pageSize),
      }),
      signal
    );
    if (!Array.isArray(list)) throw new Error('Not a list');
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const { name: itemName, size } = item as {
        name?: unknown;
        size?: unknown;
      };
      if (typeof itemName !== 'string' || !sameName(itemName, name)) continue;
      count += 1;
      if (typeof size === 'number' && Number.isFinite(size) && size > 0)
        bytes += size;
    }
    if (list.length < pageSize) return { bytes, complete: true, count };
  }
  return { bytes, complete: false, count };
};
