import { nodeStillFollows, sameName } from './followedNames';
import { nodeAdminRequest } from './nodeAdmin';
import { getNodeJson } from './useNodeOverviewData';

/**
 * One item of the node's shared data, as Core's host monitor lists it: one
 * publish (a transaction) the node keeps data of.
 */
export type HostedItem = {
  chunkCount: number;
  /** The address that published it; null when Core didn't say. */
  creatorAddress: string | null;
  identifier: string | null;
  name: string;
  service: string;
  signature: string;
  /** Its published size. */
  size: number;
  timestamp: number;
  /** What the node keeps of it on disk: less while it holds only part. */
  totalSpace: number;
};

const amount = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;

export const parseHostedItem = (value: unknown): HostedItem | null => {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  if (
    typeof item.name !== 'string' ||
    typeof item.service !== 'string' ||
    typeof item.signature !== 'string'
  )
    return null;
  return {
    chunkCount: amount(item.chunkCount),
    creatorAddress:
      typeof item.creatorAddress === 'string' ? item.creatorAddress : null,
    identifier: typeof item.identifier === 'string' ? item.identifier : null,
    name: item.name,
    service: item.service,
    signature: item.signature,
    size: amount(item.size),
    timestamp: amount(item.timestamp),
    totalSpace: amount(item.totalSpace),
  };
};

export type HostedPage = {
  /** Every item the node lists, not only this page's. */
  count: number;
  items: HostedItem[];
  /** How many items the page had before any was left out. */
  pageLength: number;
  /** Space on disk of every item the node lists. */
  totalSpace: number;
};

export const parseHostedPage = (data: unknown): HostedPage => {
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new Error('Not a page of hosted data');
  const page = data as {
    count?: unknown;
    items?: unknown;
    totalSpace?: unknown;
  };
  if (typeof page.count !== 'number' || !Array.isArray(page.items))
    throw new Error('Not a page of hosted data');
  return {
    count: page.count,
    items: page.items
      .map(parseHostedItem)
      .filter((item): item is HostedItem => item !== null),
    pageLength: page.items.length,
    totalSpace: amount(page.totalSpace),
  };
};

/**
 * A page of `/arbitrary/hosted/transactions` (no API key), biggest on disk
 * first. Core's `name` filter keeps names that start with it, as spelled.
 */
export const readHostedPage = async (
  nodeBase: string,
  { limit, name, offset }: { limit: number; name?: string; offset: number },
  signal?: AbortSignal
): Promise<HostedPage> => {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  });
  if (name) params.set('name', name);
  return parseHostedPage(
    await getNodeJson<unknown>(
      nodeBase,
      `/arbitrary/hosted/transactions?${params.toString()}`,
      signal
    )
  );
};

export type NameShare = {
  count: number;
  name: string;
  /** The newest of its publishes the node holds. */
  newest: number;
  space: number;
};

export type ServiceShare = { count: number; service: string; space: number };

/** The node's shared data, sorted once from the whole of Core's list. */
export type HostedScan = {
  /** The biggest items on disk, biggest first. */
  biggest: HostedItem[];
  byName: NameShare[];
  byService: ServiceShare[];
  /** False when the scan stopped at its limit. */
  complete: boolean;
  count: number;
  newest: HostedItem[];
  scanned: number;
  totalSpace: number;
};

/** Core changed its list while it was read: read it all again. */
export class HostedListChanged extends Error {}

/** Items read per page: about 2 MB from the node. */
export const SCAN_PAGE_SIZE = 5000;
/** Items kept for the biggest and the newest lists. */
export const SCAN_KEEP = 500;
/** Items read at most. */
export const SCAN_MAX_ITEMS = 400_000;

const nameKey = (name: string) => name.toLowerCase();

/**
 * Reads the node's whole list, a page at a time, into totals by name and by
 * service and the biggest and newest items. Core counts its list when it
 * starts and then about every two hours; a new count while this reads
 * throws `HostedListChanged`.
 */
export const scanHosted = async (
  nodeBase: string,
  signal?: AbortSignal,
  onProgress?: (read: number, total: number) => void,
  {
    maxItems = SCAN_MAX_ITEMS,
    pageSize = SCAN_PAGE_SIZE,
  }: { maxItems?: number; pageSize?: number } = {}
): Promise<HostedScan> => {
  const names = new Map<string, NameShare>();
  const services = new Map<string, ServiceShare>();
  const biggest: HostedItem[] = [];
  let newest: HostedItem[] = [];
  let count: number | null = null;
  let totalSpace = 0;
  let scanned = 0;
  let complete = false;

  for (let offset = 0; offset < maxItems; offset += pageSize) {
    const page = await readHostedPage(
      nodeBase,
      { limit: pageSize, offset },
      signal
    );
    if (count === null) {
      count = page.count;
      totalSpace = page.totalSpace;
    } else if (page.count !== count) {
      throw new HostedListChanged();
    }
    for (const item of page.items) {
      scanned += 1;
      const key = nameKey(item.name);
      const share = names.get(key) ?? {
        count: 0,
        name: item.name,
        newest: 0,
        space: 0,
      };
      share.count += 1;
      share.space += item.totalSpace;
      share.newest = Math.max(share.newest, item.timestamp);
      names.set(key, share);
      const service = services.get(item.service) ?? {
        count: 0,
        service: item.service,
        space: 0,
      };
      service.count += 1;
      service.space += item.totalSpace;
      services.set(item.service, service);
      // Core lists the biggest on disk first.
      if (biggest.length < SCAN_KEEP) biggest.push(item);
    }
    newest = newest
      .concat(page.items)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, SCAN_KEEP);
    onProgress?.(Math.min(offset + page.pageLength, count), count);
    if (page.pageLength < pageSize) {
      complete = true;
      break;
    }
  }

  return {
    biggest,
    byName: [...names.values()].sort((a, b) => b.space - a.space),
    byService: [...services.values()].sort((a, b) => b.space - a.space),
    complete,
    count: count ?? 0,
    newest,
    scanned,
    totalSpace,
  };
};

/** Items read per page for one name, and pages at most. */
export const NAME_PAGE_SIZE = 2000;
export const NAME_MAX_PAGES = 10;

/**
 * What the node holds of `name`. Core's filter keeps names that start with
 * it, as spelled; only `name` itself stays.
 */
export const readHostedForName = async (
  nodeBase: string,
  name: string,
  signal?: AbortSignal,
  {
    maxPages = NAME_MAX_PAGES,
    pageSize = NAME_PAGE_SIZE,
  }: { maxPages?: number; pageSize?: number } = {}
): Promise<{ complete: boolean; items: HostedItem[] }> => {
  const items: HostedItem[] = [];
  for (let page = 0; page < maxPages; page++) {
    const result = await readHostedPage(
      nodeBase,
      { limit: pageSize, name, offset: page * pageSize },
      signal
    );
    items.push(...result.items.filter((item) => sameName(item.name, name)));
    if (result.pageLength < pageSize) return { complete: true, items };
  }
  return { complete: false, items };
};

/** null, '', 'null' and 'default' all mean a name's default resource. */
export const isDefaultIdentifier = (identifier: string | null) =>
  identifier === null ||
  identifier === '' ||
  identifier === 'null' ||
  identifier === 'default';

/** Encrypted services: their data is shown by its details only. */
export const isPrivateService = (service: string) => /_PRIVATE$/.test(service);

const IMAGE_SERVICES = new Set(['IMAGE', 'QCHAT_IMAGE', 'THUMBNAIL']);
const VIDEO_SERVICES = new Set(['VIDEO']);
const AUDIO_SERVICES = new Set([
  'AUDIO',
  'PODCAST',
  'QCHAT_AUDIO',
  'QCHAT_VOICE',
  'VOICE',
]);
const TEXT_SERVICES = new Set([
  'BLOG_COMMENT',
  'BLOG_POST',
  'CHAIN_COMMENT',
  'CODE',
  'COMMENT',
  'DOCUMENT',
  'JSON',
  'LIST',
  'METADATA',
  'PLAYLIST',
]);

export type PreviewKind = 'image' | 'video' | 'audio' | 'text';

/** How an item of `service` can be shown, or null for details only. */
export const previewKind = (service: string): PreviewKind | null => {
  if (isPrivateService(service)) return null;
  if (IMAGE_SERVICES.has(service)) return 'image';
  if (VIDEO_SERVICES.has(service)) return 'video';
  if (AUDIO_SERVICES.has(service)) return 'audio';
  if (TEXT_SERVICES.has(service)) return 'text';
  return null;
};

/** The node path of an item's resource; each part encoded. */
export const resourcePath = (
  prefix: string,
  item: Pick<HostedItem, 'identifier' | 'name' | 'service'>
) =>
  `${prefix}/${encodeURIComponent(item.service)}/${encodeURIComponent(
    item.name
  )}${
    isDefaultIdentifier(item.identifier)
      ? ''
      : `/${encodeURIComponent(item.identifier as string)}`
  }`;

/**
 * Held only as chunks, an item bigger than this asks before it shows:
 * reading it makes Core put a full copy together beside its chunks, which
 * its cleanup removes only once that copy is an hour old.
 */
export const BUILD_WARN_BYTES = 20_000_000;

/** Text previews read at most this much. */
export const TEXT_PREVIEW_MAX_BYTES = 200_000;

/**
 * Whether the node can show an item without fetching anything:
 * - `private`: encrypted, details only;
 * - `none`: no preview for its kind;
 * - `partial`: the node holds only part of it, and reading it would start a
 *   download;
 * - `older`: a newer version was published, and reading the resource would
 *   build that one;
 * - `too_big`: text too long to show here;
 * - `build_needed`: all of it is here, as chunks only: showing it makes the
 *   node put together a full copy beside them, so it asks first;
 * - `ready`: all of it is on the node, and it is the newest version.
 */
export type PreviewState =
  | 'private'
  | 'none'
  | 'partial'
  | 'older'
  | 'too_big'
  | 'build_needed'
  | 'ready';

const READY_STATUSES = new Set(['DOWNLOADED', 'BUILDING', 'READY']);

/** The newest version's signature of an item's resource, from the search. */
/**
 * Who owns a name now (`/names/<name>`): null when the name isn't
 * registered. Throws when the node can't say.
 */
export const readNameOwner = async (
  nodeBase: string,
  name: string,
  signal?: AbortSignal
): Promise<string | null> => {
  let info: unknown;
  try {
    info = await getNodeJson<unknown>(
      nodeBase,
      `/names/${encodeURIComponent(name)}`,
      signal
    );
  } catch (error) {
    if (error instanceof Error && error.message === 'HTTP 404') return null;
    throw error;
  }
  const owner = (info as { owner?: unknown } | null)?.owner;
  if (typeof owner !== 'string' || !owner) throw new Error('No owner');
  return owner;
};

export const readLatestSignature = async (
  nodeBase: string,
  item: HostedItem,
  signal?: AbortSignal
): Promise<string | null> => {
  const params = new URLSearchParams({
    exactmatchnames: 'true',
    includemetadata: 'false',
    limit: '20',
    mode: 'ALL',
    name: item.name,
    service: item.service,
  });
  if (isDefaultIdentifier(item.identifier)) params.set('default', 'true');
  else params.set('identifier', item.identifier as string);
  const found = await getNodeJson<unknown>(
    nodeBase,
    `/arbitrary/resources/search?${params.toString()}`,
    signal
  );
  if (!Array.isArray(found)) throw new Error('Not a list');
  const latest = found.find((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const resource = entry as Record<string, unknown>;
    const identifier =
      typeof resource.identifier === 'string' ? resource.identifier : null;
    return (
      resource.service === item.service &&
      typeof resource.name === 'string' &&
      sameName(resource.name, item.name) &&
      (isDefaultIdentifier(identifier) && isDefaultIdentifier(item.identifier)
        ? true
        : identifier === item.identifier)
    );
  }) as { latestSignature?: unknown } | undefined;
  return typeof latest?.latestSignature === 'string'
    ? latest.latestSignature
    : null;
};

export const readPreviewState = async (
  nodeBase: string,
  item: HostedItem,
  signal?: AbortSignal
): Promise<PreviewState> => {
  if (isPrivateService(item.service)) return 'private';
  const kind = previewKind(item.service);
  if (!kind) return 'none';
  if (kind === 'text' && item.size > TEXT_PREVIEW_MAX_BYTES) return 'too_big';

  const status = await getNodeJson<{
    localChunkCount?: unknown;
    status?: unknown;
    totalChunkCount?: unknown;
  }>(nodeBase, resourcePath('/arbitrary/resource/status', item), signal);
  const held =
    typeof status?.status === 'string' &&
    READY_STATUSES.has(status.status) &&
    !(
      typeof status.localChunkCount === 'number' &&
      typeof status.totalChunkCount === 'number' &&
      status.localChunkCount < status.totalChunkCount
    );
  if (!held) return 'partial';

  const latest = await readLatestSignature(nodeBase, item, signal);
  if (latest !== item.signature) return 'older';
  return status.status === 'DOWNLOADED' && item.size > BUILD_WARN_BYTES
    ? 'build_needed'
    : 'ready';
};

/** Core's delete path: it takes "default" for a name's default resource. */
export const deletePath = (
  item: Pick<HostedItem, 'identifier' | 'name' | 'service'>
) =>
  `/arbitrary/resource/${encodeURIComponent(item.service)}/${encodeURIComponent(
    item.name
  )}/${
    isDefaultIdentifier(item.identifier)
      ? 'default'
      : encodeURIComponent(item.identifier as string)
  }`;

/**
 * What a removal did:
 * - `followed`: one of the node's lists follows the name, so Core would fetch
 *   it again: nothing removed;
 * - `older`: a newer version was published, and Core's delete removes only
 *   the newest version's files: nothing removed;
 * - `not_removed`: Core answered, but the node still holds the data, or more
 *   of it than the metadata file Core keeps;
 * - `removed`.
 */
export type RemoveResult = 'followed' | 'older' | 'not_removed' | 'removed';

/**
 * Removes the node's copy of `item`, a file of a name it doesn't follow,
 * with Hub's API key, then reads its status to see it's gone. A refused or
 * failed delete throws `NodeAdminError`.
 */
export const removeHostedItem = async (
  nodeBase: string,
  item: HostedItem,
  signal?: AbortSignal
): Promise<RemoveResult> => {
  if (await nodeStillFollows(nodeBase, item.name, signal)) return 'followed';
  if ((await readLatestSignature(nodeBase, item, signal)) !== item.signature)
    return 'older';
  const answer = await nodeAdminRequest(nodeBase, deletePath(item), {
    method: 'DELETE',
    signal,
  });
  if (answer !== 'true') return 'not_removed';
  const status = await getNodeJson<{
    localChunkCount?: unknown;
    status?: unknown;
  }>(nodeBase, resourcePath('/arbitrary/resource/status', item), signal);
  // Core keeps a resource's small metadata file, which its status counts as
  // one chunk: gone means not held any more, with at most that one left.
  const held =
    typeof status?.status === 'string' && READY_STATUSES.has(status.status);
  const left =
    typeof status?.localChunkCount === 'number' ? status.localChunkCount : 0;
  return held || left > 1 ? 'not_removed' : 'removed';
};
