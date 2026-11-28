import { useCallback, useEffect, useRef, useState } from 'react';
import { atom, useAtom, useAtomValue } from 'jotai';
import { selectedNodeInfoAtom } from '../../atoms/global';
import {
  EXT_NODE_QORTAL_LINK,
  HTTPS_EXT_NODE_QORTAL_LINK,
} from '../../constants/constants';
import { NodeAdminError, type NodeAdminFailure } from './nodeAdmin';
import {
  cleanFollowName,
  entriesFor,
  nodeStillFollows,
  readFollowedNames,
  readPublishedTotals,
  writeFollowedNames,
  type PublishedTotals,
} from './followedNames';

/** The node Hub uses, as the Node Manager takes it. */
export const useNodeInUse = () => {
  const selected = useAtomValue(selectedNodeInfoAtom);
  const nodeBase = selected?.url || HTTPS_EXT_NODE_QORTAL_LINK;
  return { isPublic: nodeBase.includes(EXT_NODE_QORTAL_LINK), nodeBase };
};

/**
 * The last read of a node's followed names. `names` is null until a read
 * worked; after a failed read the last good list stays, marked `error`.
 */
export type FollowedNamesRead = {
  at: number | null;
  names: string[] | null;
  node: string;
  reason: NodeAdminFailure | null;
  status: 'loading' | 'ok' | 'error';
};

/** The followed names of the node Hub uses; one read for every view. */
export const followedNamesAtom = atom<FollowedNamesRead | null>(
  null as FollowedNamesRead | null
);

/** Follows and unfollows under way: `<node>\n<name in lower case>`. */
export const followWritesAtom = atom<string[]>([] as string[]);

/** A view that opens reads the list again when its read is older. */
export const FOLLOWED_NAMES_FRESH_MS = 30_000;

type SetRead = (
  update: (previous: FollowedNamesRead | null) => FollowedNamesRead | null
) => void;

/** How many writes each node has had: a read from before one is dropped. */
const writeCounts = new Map<string, number>();
const writeCount = (node: string) => writeCounts.get(node) ?? 0;

const reads = new Map<string, { job: Promise<void>; writes: number }>();

const reasonOf = (error: unknown): NodeAdminFailure =>
  error instanceof NodeAdminError ? error.reason : 'failed';

/**
 * Reads the node's list, once at a time for each node. A read that started
 * before the node's last write is out of date: its answer is dropped, and a
 * new one starts.
 */
const loadFollowed = (node: string, setRead: SetRead): Promise<void> => {
  const writes = writeCount(node);
  const running = reads.get(node);
  if (running && running.writes === writes) return running.job;
  setRead((previous) =>
    previous && previous.node === node
      ? { ...previous, status: previous.names ? previous.status : 'loading' }
      : { at: null, names: null, node, reason: null, status: 'loading' }
  );
  const job = readFollowedNames(node)
    .then(
      (names) => {
        if (writeCount(node) !== writes) return;
        setRead((previous) =>
          previous && previous.node !== node
            ? previous
            : { at: Date.now(), names, node, reason: null, status: 'ok' }
        );
      },
      (error) => {
        if (writeCount(node) !== writes) return;
        setRead((previous) =>
          previous && previous.node !== node
            ? previous
            : {
                at: previous?.at ?? null,
                names: previous?.names ?? null,
                node,
                reason: reasonOf(error),
                status: 'error',
              }
        );
      }
    )
    .finally(() => {
      if (reads.get(node)?.job === job) reads.delete(node);
    });
  reads.set(node, { job, writes });
  return job;
};

/** The node's writes, one after another: Core's list isn't locked. */
const writeChains = new Map<string, Promise<unknown>>();

const oneAtATime = <T>(node: string, task: () => Promise<T>): Promise<T> => {
  const previous = writeChains.get(node) ?? Promise.resolve();
  const result = previous.then(task, task);
  const tail = result.catch(() => undefined);
  writeChains.set(node, tail);
  void tail.finally(() => {
    if (writeChains.get(node) === tail) writeChains.delete(node);
  });
  return result;
};

const writeKey = (node: string, name: string) =>
  `${node}\n${name.toLowerCase()}`;

/** Names with a follow or unfollow under way, as `writeKey`s. */
const pendingWrites = new Set<string>();

export type FollowResult =
  | { status: 'done' }
  | { status: 'busy' }
  | { status: 'failed'; reason: NodeAdminFailure };

export type UnfollowResult =
  | {
      status: 'done';
      /**
       * Whether the node still follows the name through another of its
       * lists (a Q-App's); null when that couldn't be read.
       */
      stillFollowed: boolean | null;
    }
  | { status: 'busy' }
  | { status: 'failed'; reason: NodeAdminFailure };

/**
 * The followed names of the node Hub uses, and the way to change them. On
 * the public node there are none to read or change (`available` false).
 *
 * A follow or unfollow reads the list first, so the node's own spelling of
 * the name is used, then writes and reads the list again. Writes go one at
 * a time for each node; a second one for the same name answers `busy`.
 */
export const useFollowedNames = () => {
  const { isPublic, nodeBase } = useNodeInUse();
  const [read, setRead] = useAtom(followedNamesAtom);
  const [writing, setWriting] = useAtom(followWritesAtom);
  const current = read && read.node === nodeBase ? read : null;
  const currentRef = useRef(current);
  currentRef.current = current;

  // Read when a view opens or the node changes, unless the last read is
  // fresh; not on every render.
  useEffect(() => {
    if (isPublic) return;
    const last = currentRef.current;
    const fresh =
      !!last &&
      last.status === 'ok' &&
      last.at !== null &&
      Date.now() - last.at <= FOLLOWED_NAMES_FRESH_MS;
    if (!fresh) void loadFollowed(nodeBase, setRead);
  }, [isPublic, nodeBase, setRead]);

  const reload = useCallback(() => {
    if (!isPublic) void loadFollowed(nodeBase, setRead);
  }, [isPublic, nodeBase, setRead]);

  /** Sets what a write left, and drops reads that started before it. */
  const wrote = useCallback(
    (node: string, names: string[]) => {
      writeCounts.set(node, writeCount(node) + 1);
      setRead((previous) =>
        previous && previous.node !== node
          ? previous
          : { at: Date.now(), names, node, reason: null, status: 'ok' }
      );
      // Another app may have changed the list meanwhile.
      void loadFollowed(node, setRead);
    },
    [setRead]
  );

  const write = useCallback(
    async <T extends { status: string }>(
      raw: string,
      task: (node: string, name: string) => Promise<T>
    ): Promise<T | FollowResult> => {
      const name = cleanFollowName(raw);
      if (!name) return { reason: 'invalid', status: 'failed' };
      if (isPublic) return { reason: 'public', status: 'failed' };
      const node = nodeBase;
      const key = writeKey(node, name);
      if (pendingWrites.has(key)) return { status: 'busy' };
      pendingWrites.add(key);
      setWriting([...pendingWrites]);
      try {
        return await oneAtATime(node, () => task(node, name));
      } catch (error) {
        void loadFollowed(node, setRead);
        return { reason: reasonOf(error), status: 'failed' };
      } finally {
        pendingWrites.delete(key);
        setWriting([...pendingWrites]);
      }
    },
    [isPublic, nodeBase, setRead, setWriting]
  );

  const follow = useCallback(
    (name: string): Promise<FollowResult> =>
      write(name, async (node, clean) => {
        const before = await readFollowedNames(node);
        if (entriesFor(before, clean).length > 0) {
          wrote(node, before);
          return { status: 'done' } as const;
        }
        await writeFollowedNames(node, 'POST', [clean]);
        wrote(node, [...before, clean]);
        return { status: 'done' } as const;
      }) as Promise<FollowResult>,
    [write, wrote]
  );

  const unfollow = useCallback(
    (name: string): Promise<UnfollowResult> =>
      write(name, async (node, clean) => {
        const before = await readFollowedNames(node);
        const spellings = entriesFor(before, clean);
        if (spellings.length > 0)
          await writeFollowedNames(node, 'DELETE', spellings);
        wrote(
          node,
          before.filter((entry) => !spellings.includes(entry))
        );
        let stillFollowed: boolean | null = null;
        try {
          stillFollowed = await nodeStillFollows(node, clean);
        } catch {
          stillFollowed = null;
        }
        return { status: 'done', stillFollowed } as const;
      }) as Promise<UnfollowResult>,
    [write, wrote]
  );

  const isFollowing = useCallback(
    (name: string): boolean | null =>
      current?.names ? entriesFor(current.names, name).length > 0 : null,
    [current]
  );

  const isWriting = useCallback(
    (name: string) => writing.includes(writeKey(nodeBase, name)),
    [nodeBase, writing]
  );

  return {
    /** When the list was last read, this PC's clock. */
    at: current?.at ?? null,
    /** False on the public node: it has no list Hub can read or change. */
    available: !isPublic,
    follow,
    isFollowing,
    isWriting,
    /** The node's list as it spells the names; null until read. */
    names: current?.names ?? null,
    nodeBase,
    /** Why the last read failed. */
    reason: current?.reason ?? null,
    reload,
    status: isPublic
      ? ('unavailable' as const)
      : (current?.status ?? ('loading' as const)),
    unfollow,
  };
};

/** Searches for published totals that may run at once, for every view. */
const SEARCH_SLOTS = 2;
let searchesRunning = 0;
const searchQueue: Array<() => void> = [];

const takeSearchSlot = (signal: AbortSignal): Promise<void> => {
  if (signal.aborted) return Promise.reject(new Error('Called off'));
  if (searchesRunning < SEARCH_SLOTS) {
    searchesRunning += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const start = () => {
      signal.removeEventListener('abort', cancel);
      resolve();
    };
    const cancel = () => {
      const index = searchQueue.indexOf(start);
      if (index >= 0) searchQueue.splice(index, 1);
      reject(new Error('Called off'));
    };
    searchQueue.push(start);
    signal.addEventListener('abort', cancel, { once: true });
  });
};

/** Hands the slot to the next search waiting, or frees it. */
const giveSearchSlot = () => {
  const next = searchQueue.shift();
  if (next) next();
  else searchesRunning -= 1;
};

type TotalsState = {
  key: string;
  status: 'loading' | 'ok' | 'error';
  totals: PublishedTotals | null;
};

/**
 * What `name` has published, read from the node Hub uses (a public read, so
 * the public node answers too). `idle` with no name or while not `enabled`.
 * After a failed read the last totals stay, marked `error`.
 */
export const usePublishedTotals = (
  name: string | null | undefined,
  { enabled = true }: { enabled?: boolean } = {}
) => {
  const { nodeBase } = useNodeInUse();
  const clean = cleanFollowName(name);
  const key = clean ? `${nodeBase}\n${clean.toLowerCase()}` : '';
  const [state, setState] = useState<TotalsState | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!clean || !enabled) return;
    const controller = new AbortController();
    setState((previous) =>
      previous && previous.key === key
        ? { ...previous, status: 'loading' }
        : { key, status: 'loading', totals: null }
    );
    const run = async () => {
      await takeSearchSlot(controller.signal);
      try {
        return await readPublishedTotals(nodeBase, clean, controller.signal);
      } finally {
        giveSearchSlot();
      }
    };
    run().then(
      (totals) => {
        if (!controller.signal.aborted) setState({ key, status: 'ok', totals });
      },
      () => {
        if (controller.signal.aborted) return;
        setState((previous) => ({
          key,
          status: 'error',
          totals: previous?.key === key ? previous.totals : null,
        }));
      }
    );
    return () => controller.abort();
  }, [attempt, clean, enabled, key, nodeBase]);

  const retry = useCallback(() => setAttempt((count) => count + 1), []);
  const current = state && state.key === key ? state : null;
  return {
    retry,
    status:
      !clean || !enabled
        ? ('idle' as const)
        : (current?.status ?? ('loading' as const)),
    totals: current?.totals ?? null,
  };
};
