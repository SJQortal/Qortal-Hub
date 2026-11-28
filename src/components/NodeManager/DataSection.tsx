import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  Avatar,
  Box,
  Button,
  Chip,
  IconButton,
  Tooltip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TableSortLabel,
  TextField,
  Typography,
  useTheme,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import BlockRoundedIcon from '@mui/icons-material/BlockRounded';
import BookmarkAddedRoundedIcon from '@mui/icons-material/BookmarkAddedRounded';
import FolderSharedRoundedIcon from '@mui/icons-material/FolderSharedRounded';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import FolderOpenRoundedIcon from '@mui/icons-material/FolderOpenRounded';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import {
  blockedAddressesAtom,
  blockedNamesAtom,
  userInfoAtom,
} from '../../atoms/global';
import { useBlockedAddresses } from '../../hooks/useBlockUsers';
import { joinNodeEndpoint } from '../../utils/nodeEndpointPath';
import { sameName } from './followedNames';
import { NodeAdminError } from './nodeAdmin';
import {
  ActionButton,
  ActionNote,
  ConfirmActionDialog,
  useFailureText,
  useLastShown,
} from './NodeActionParts';
import { CardText, DetailRows, OverviewCard, ReadNote } from './OverviewParts';
import {
  quietButtonSx,
  textButtonSx,
  windowBackdropSx,
  windowPaperSx,
} from './nodeManagerLook';
import {
  HostedListChanged,
  isDefaultIdentifier,
  previewKind,
  readHostedForName,
  readLatestSignature,
  readNameOwner,
  readPreviewState,
  removeHostedItem,
  resourcePath,
  scanHosted,
  type HostedItem,
  type HostedScan,
} from './nodeData';
import { formatBytes, formatCount } from './nodeOverview';
import { useFollowedNames, usePublishedTotals } from './useFollowedNames';
import { getNodeText, useNodeRead } from './useNodeOverviewData';

/** A name the window was opened at, from `openNodeManager('data', …)`. */
export type DataFocus = { name: string; seq: number };

/** Rows shown at first in a list, and added by "Show more". */
const ROWS = 25;
/** Characters of a text item shown. */
const TEXT_SHOWN = 20_000;

type Note = { text: string; tone: 'info' | 'error' | 'success' };
type Asked = { kind: 'follow' | 'unfollow'; name: string };

type ScanState = {
  at: number | null;
  progress: [number, number] | null;
  scan: HostedScan | null;
  status: 'idle' | 'loading' | 'ok' | 'error';
};

/**
 * Sorts the node's whole list once, while the section is shown. Shown again
 * after it stopped part-way, it starts over; Refresh reads it again.
 */
const useHostedScan = (nodeBase: string, active: boolean) => {
  const [state, setState] = useState<ScanState>({
    at: null,
    progress: null,
    scan: null,
    status: 'idle',
  });
  const [attempt, setAttempt] = useState(0);
  const doneFor = useRef<number | null>(null);

  useEffect(() => {
    if (!active || doneFor.current === attempt) return;
    const controller = new AbortController();
    setState((previous) => ({
      ...previous,
      progress: null,
      status: 'loading',
    }));
    const run = async () => {
      // Core may count its list again while it is read: start over, twice.
      for (let tries = 0; ; tries++) {
        try {
          const scan = await scanHosted(
            nodeBase,
            controller.signal,
            (read, total) => {
              if (!controller.signal.aborted)
                setState((previous) => ({
                  ...previous,
                  progress: [read, total],
                }));
            }
          );
          if (controller.signal.aborted) return;
          doneFor.current = attempt;
          setState({ at: Date.now(), progress: null, scan, status: 'ok' });
          return;
        } catch (error) {
          if (controller.signal.aborted) return;
          if (error instanceof HostedListChanged && tries < 2) continue;
          setState((previous) => ({
            ...previous,
            progress: null,
            status: 'error',
          }));
          return;
        }
      }
    };
    void run();
    return () => controller.abort();
  }, [active, attempt, nodeBase]);

  return { ...state, refresh: () => setAttempt((count) => count + 1) };
};

const avatarUrl = (nodeBase: string, name: string) => {
  try {
    return joinNodeEndpoint(
      nodeBase,
      `/arbitrary/THUMBNAIL/${encodeURIComponent(name)}/qortal_avatar?async=true`
    );
  } catch {
    return undefined;
  }
};

const NameAvatar = ({ name, nodeBase }: { name: string; nodeBase: string }) => (
  <Avatar
    alt=""
    src={avatarUrl(nodeBase, name)}
    sx={{ fontSize: '0.9rem', height: 32, width: 32 }}
  >
    {name.charAt(0).toUpperCase()}
  </Avatar>
);

/** A list's order: a column's key, and whether it goes high to low. */
type Sort = { desc: boolean; key: string };

type Column<T> = {
  /** Sizes and dates start high to low; text A to Z. */
  firstDesc?: boolean;
  label: string;
  render: (item: T) => ReactNode;
  sortKey?: string;
  sortValue?: (item: T) => number | string;
};

const sortRows = <T,>(items: T[], columns: Column<T>[], sort: Sort): T[] => {
  const value = columns.find(
    (column) => column.sortKey === sort.key
  )?.sortValue;
  if (!value) return items;
  return [...items].sort((a, b) => {
    const one = value(a);
    const two = value(b);
    const order =
      typeof one === 'number' && typeof two === 'number'
        ? one - two
        : String(one).localeCompare(String(two), undefined, {
            numeric: true,
            sensitivity: 'base',
          });
    return sort.desc ? -order : order;
  });
};

/** A click on a column sorts by it; a second click reverses it. */
const nextSort = <T,>(previous: Sort, column: Column<T>): Sort =>
  previous.key === column.sortKey
    ? { desc: !previous.desc, key: previous.key }
    : { desc: !!column.firstDesc, key: column.sortKey as string };

/** The node's own folders: only for a node on this PC. */
const folderBridge = () =>
  (
    window as unknown as {
      nodeData?: {
        folderState?: (signature: string) => Promise<unknown>;
        showFolder?: (signature: string) => Promise<unknown>;
      };
    }
  ).nodeData;

const isNodeOnThisPc = (nodeBase: string) => {
  try {
    return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(
      new URL(nodeBase).hostname
    );
  } catch {
    return false;
  }
};

type FolderState = 'checking' | 'present' | 'missing' | 'unknown';

/**
 * Whether a file's folder is on this PC, asked once it shows, and the file
 * manager opened at it: `unknown` for a node elsewhere, or when Hub can't see
 * Core's data folder.
 */
const useFolder = (signature: string, nodeBase: string) => {
  const bridge = folderBridge();
  const can =
    !!bridge?.folderState && !!bridge.showFolder && isNodeOnThisPc(nodeBase);
  const [found, setFound] = useState<{
    signature: string;
    state: FolderState;
  } | null>(null);
  useEffect(() => {
    if (!can) return;
    let live = true;
    const settle = (state: FolderState) => {
      if (live) setFound({ signature, state });
    };
    bridge.folderState(signature).then(
      (state) =>
        settle(state === 'present' || state === 'missing' ? state : 'unknown'),
      () => settle('unknown')
    );
    return () => {
      live = false;
    };
  }, [can, signature]);
  const state: FolderState = !can
    ? 'unknown'
    : found?.signature === signature
      ? found.state
      : 'checking';
  const show = () =>
    void bridge?.showFolder?.(signature).then((result) => {
      // Gone since it was asked.
      if (result === 'missing') setFound({ signature, state: 'missing' });
    });
  return { show, state };
};

/** Opens the file manager at the file's folder on this PC. */
const FolderButton = ({
  item,
  onShow,
}: {
  item: HostedItem;
  onShow: () => void;
}) => {
  const { t } = useTranslation(['node']);
  const fileLabel = useFileLabel();
  const label = t('node:manager.data.show_in_folder', {
    file: fileLabel(item),
  });
  return (
    <Tooltip title={label}>
      <IconButton
        aria-label={label}
        onClick={(event) => {
          event.stopPropagation();
          onShow();
        }}
        size="small"
      >
        <FolderOpenRoundedIcon fontSize="small" />
      </IconButton>
    </Tooltip>
  );
};

/** Where a name the window was opened at opened: under its own row. */
type Revealed = { name: string; seq: number; where: 'followed' | 'shared' };

/** Brings a row into view when it opens for a name the window was opened at. */
const RevealRow = ({
  seq,
  target,
}: {
  seq: number;
  target: (from: HTMLElement) => Element | null;
}) => {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const from = ref.current;
    if (from)
      target(from)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, [seq]);
  return <span hidden ref={ref} />;
};

/**
 * A plain list of rows, with a header, as the other sections' tables. A row
 * can open what belongs to it right under it.
 */
const Rows = <T,>({
  columns,
  expandedKey = null,
  items,
  onRow,
  onSort,
  renderExpanded,
  rowKey,
  rowLabel,
  sort,
}: {
  columns: Column<T>[];
  expandedKey?: string | null;
  items: T[];
  onRow?: (item: T) => void;
  renderExpanded?: (item: T) => ReactNode;
  rowKey?: (item: T) => string;
  rowLabel?: (item: T) => string;
  /** With a sort, columns that have a sortKey sort on a click. */
  onSort?: (column: Column<T>) => void;
  sort?: Sort;
}) => (
  <Box sx={{ overflowX: 'auto' }}>
    <Table
      size="small"
      sx={{
        '& td, & th': {
          fontSize: '0.84rem',
          maxWidth: 280,
          overflow: 'hidden',
          px: 1,
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        },
      }}
    >
      <TableHead>
        <TableRow>
          {columns.map((column) => (
            <TableCell
              key={column.label}
              sortDirection={
                sort && column.sortKey === sort.key
                  ? sort.desc
                    ? 'desc'
                    : 'asc'
                  : false
              }
              sx={{ fontWeight: 700 }}
            >
              {column.sortKey && onSort && sort ? (
                <TableSortLabel
                  active={column.sortKey === sort.key}
                  direction={
                    column.sortKey === sort.key && !sort.desc ? 'asc' : 'desc'
                  }
                  onClick={() => onSort(column)}
                >
                  {column.label}
                </TableSortLabel>
              ) : (
                column.label
              )}
            </TableCell>
          ))}
        </TableRow>
      </TableHead>
      <TableBody>
        {items.map((item, index) => {
          const key = rowKey ? rowKey(item) : String(index);
          const open = !!renderExpanded && expandedKey === key;
          return (
            <Fragment key={key}>
              <TableRow
                aria-expanded={renderExpanded ? open : undefined}
                aria-label={rowLabel?.(item)}
                hover={!!onRow}
                onClick={onRow ? () => onRow(item) : undefined}
                onKeyDown={
                  onRow
                    ? (event) => {
                        // Keys pressed on a button in the row are the button's.
                        if (event.target !== event.currentTarget) return;
                        if (event.key !== 'Enter' && event.key !== ' ') return;
                        event.preventDefault();
                        onRow(item);
                      }
                    : undefined
                }
                sx={{ cursor: onRow ? 'pointer' : 'default' }}
                tabIndex={onRow ? 0 : undefined}
              >
                {columns.map((column) => (
                  <TableCell key={column.label}>
                    {column.render(item)}
                  </TableCell>
                ))}
              </TableRow>
              {open ? (
                <TableRow data-expanded-row={key}>
                  <TableCell
                    colSpan={columns.length}
                    sx={{
                      '&&': {
                        maxWidth: 'none',
                        overflow: 'visible',
                        py: 1.25,
                        whiteSpace: 'normal',
                      },
                    }}
                  >
                    {renderExpanded?.(item)}
                  </TableCell>
                </TableRow>
              ) : null}
            </Fragment>
          );
        })}
      </TableBody>
    </Table>
  </Box>
);

/** What removing a file needs from the Data section. */
type Removal = {
  ask: (item: HostedItem) => void;
  busy: (item: HostedItem) => boolean;
  can: (item: HostedItem) => boolean;
  removed: (item: HostedItem) => boolean;
  nodeBase: string;
  /** What the last removal of this file said, when nothing was removed. */
  outcome: (item: HostedItem) => string | null;
  /** Why a file can't be removed here, when it's for that reason. */
  why: (item: HostedItem) => 'followed' | 'own' | null;
};

/** A file's name in sentences: its service and identifier. */
const useFileLabel = () => {
  const { t } = useTranslation(['node']);
  return (item: HostedItem) =>
    `${item.service} ${
      isDefaultIdentifier(item.identifier)
        ? t('node:manager.data.default_identifier')
        : item.identifier
    }`;
};

/** The red × of a file that can be removed, an (i) saying why one can't, or
 * "removed" once it is. */
const RemoveCell = ({
  item,
  removal,
}: {
  item: HostedItem;
  removal: Removal;
}) => {
  const { t } = useTranslation(['node']);
  const fileLabel = useFileLabel();
  const why = removal.why(item);
  const candidate = !removal.removed(item) && !why && removal.can(item);
  // Core removes only a file's newest version: each row asks which it is.
  const newest = useNodeRead(
    removal.nodeBase,
    candidate
      ? (base, signal) => readLatestSignature(base, item, signal)
      : null,
    0
  );
  if (removal.removed(item))
    return (
      <Chip
        label={t('node:manager.data.removed_chip')}
        size="small"
        sx={{ height: 20 }}
      />
    );
  const reason =
    removal.outcome(item) ??
    (why || (newest.value !== null && newest.value !== item.signature)
      ? t(`node:manager.data.cant_remove_${why ?? 'older'}`, {
          name: item.name,
        })
      : null);
  if (reason)
    return (
      <Tooltip title={reason}>
        <IconButton
          aria-label={reason}
          onClick={(event) => event.stopPropagation()}
          size="small"
        >
          <InfoOutlinedIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    );
  if (!candidate || newest.status === 'loading') return null;
  return (
    <IconButton
      aria-label={t('node:manager.data.remove_label', {
        file: fileLabel(item),
      })}
      color="error"
      disabled={removal.busy(item)}
      onClick={(event) => {
        // Not the row's own click, which opens the file.
        event.stopPropagation();
        removal.ask(item);
      }}
      size="small"
    >
      <CloseRoundedIcon fontSize="small" />
    </IconButton>
  );
};

/**
 * A file's folder button and its ×, or that it's gone from this PC once its
 * folder isn't there.
 */
const FileActions = ({
  item,
  removal,
}: {
  item: HostedItem;
  removal: Removal;
}) => {
  const { t } = useTranslation(['node']);
  const folder = useFolder(item.signature, removal.nodeBase);
  if (folder.state === 'missing' && !removal.removed(item))
    return (
      <Tooltip describeChild title={t('node:manager.data.gone_info')}>
        <Chip
          label={t('node:manager.data.gone_chip')}
          size="small"
          sx={{ height: 20 }}
          tabIndex={0}
        />
      </Tooltip>
    );
  return (
    <Box sx={{ alignItems: 'center', display: 'inline-flex' }}>
      {folder.state === 'present' ? (
        <FolderButton item={item} onShow={folder.show} />
      ) : null}
      <RemoveCell item={item} removal={removal} />
    </Box>
  );
};

const removeColumn = (
  removal: Removal,
  t: (key: string, options?: Record<string, unknown>) => string
): Column<HostedItem> => ({
  label: t('node:manager.data.col_actions', {
    postProcess: 'capitalizeFirstChar',
  }),
  render: (item: HostedItem) => <FileActions item={item} removal={removal} />,
});

const FollowedRow = ({
  actions,
  active,
  children,
  held,
  heldStatus,
  name,
  nodeBase,
  selected,
}: {
  actions: ReactNode;
  active: boolean;
  /** What opens under the row: the name's files. */
  children?: ReactNode;
  held: { count: number; space: number } | null;
  heldStatus: ScanState['status'];
  name: string;
  nodeBase: string;
  selected: boolean;
}) => {
  const theme = useTheme();
  const { i18n, t } = useTranslation(['node']);
  const language = i18n.language;
  const published = usePublishedTotals(name, { enabled: active });
  const lineSx = { color: theme.palette.text.secondary, fontSize: '0.82rem' };
  return (
    <Box
      data-followed-name={name}
      sx={{
        backgroundColor: selected
          ? alpha(theme.palette.primary.main, 0.08)
          : 'transparent',
        borderRadius: '10px',
        px: 1,
        py: 0.75,
      }}
    >
      <Box
        sx={{
          alignItems: 'center',
          display: 'flex',
          flexWrap: 'wrap',
          gap: 1.25,
        }}
      >
        <NameAvatar name={name} nodeBase={nodeBase} />
        <Box sx={{ flex: '1 1 220px', minWidth: 0 }}>
          <Typography sx={{ fontWeight: 700 }}>{name}</Typography>
          <Typography sx={lineSx}>
            {held
              ? t('node:manager.data.held', {
                  items: formatCount(held.count, language),
                  space: formatBytes(held.space, language),
                })
              : heldStatus === 'ok'
                ? t('node:manager.data.held_none')
                : heldStatus === 'loading'
                  ? t('node:manager.data.held_counting')
                  : null}
          </Typography>
          <Typography sx={lineSx}>
            {published.totals
              ? t(
                  published.totals.complete
                    ? 'node:manager.data.published'
                    : 'node:manager.data.published_at_least',
                  {
                    items: formatCount(published.totals.count, language),
                    size: formatBytes(published.totals.bytes, language),
                  }
                )
              : published.status === 'error'
                ? t('node:manager.data.published_failed')
                : t('node:manager.data.published_reading')}
          </Typography>
        </Box>
        {actions}
      </Box>
      {children ? <Box sx={{ mt: 1 }}>{children}</Box> : null}
    </Box>
  );
};

export const DataSection = ({
  active = true,
  focus = null,
  nodeBase,
}: {
  /** False while another section is shown: nothing is read meanwhile. */
  active?: boolean;
  focus?: DataFocus | null;
  nodeBase: string;
}) => {
  const { i18n, t } = useTranslation(['node', 'core', 'auth']);
  const language = i18n.language;
  const capitalize = { postProcess: 'capitalizeFirstChar' } as const;
  const failureText = useFailureText();
  const follows = useFollowedNames();
  // The node's blocked names, through Hub's own block list (Core's
  // `blockedNames`), so Hub's other views stay in step.
  const blocks = useBlockedAddresses(true);
  const blockedNames = useAtomValue(blockedNamesAtom);
  const blockedAddresses = useAtomValue(blockedAddressesAtom);
  const [blockedRead, setBlockedRead] = useState<'loading' | 'ok' | 'error'>(
    'loading'
  );
  const [unblocking, setUnblocking] = useState<string | null>(null);
  const [unblockFailed, setUnblockFailed] = useState<string | null>(null);
  const scan = useHostedScan(nodeBase, active);
  const [openFollowed, setOpenFollowed] = useState<string | null>(null);
  // Where a name the window was opened at opened.
  const [reveal, setReveal] = useState<Revealed | null>(null);
  const takenSeq = useRef<number | null>(null);
  const [preview, setPreview] = useState<HostedItem | null>(null);
  const [asked, setAsked] = useState<Asked | null>(null);
  const userInfo = useAtomValue(userInfoAtom);
  const myAddress =
    typeof userInfo?.address === 'string' ? userInfo.address : null;
  const fileLabel = useFileLabel();
  const [removeAsked, setRemoveAsked] = useState<HostedItem | null>(null);
  const shownRemove = useLastShown(removeAsked);
  const [removedSignatures, setRemovedSignatures] = useState<string[]>([]);
  const [removingSignatures, setRemovingSignatures] = useState<string[]>([]);
  const [outcomes, setOutcomes] = useState<Record<string, string>>({});
  const removing = useRef(new Set<string>());
  // A file can go when its name isn't followed (read from the node's list,
  // never guessed) and someone else published it: for your own, your node
  // may hold the only copy.
  const removal: Removal = {
    ask: setRemoveAsked,
    busy: (item) => removingSignatures.includes(item.signature),
    can: (item) =>
      !!myAddress &&
      !!item.creatorAddress &&
      item.creatorAddress !== myAddress &&
      follows.isFollowing(item.name) === false,
    nodeBase,
    outcome: (item) => outcomes[item.signature] ?? null,
    removed: (item) => removedSignatures.includes(item.signature),
    why: (item) =>
      follows.isFollowing(item.name) === true
        ? 'followed'
        : myAddress && item.creatorAddress === myAddress
          ? 'own'
          : null,
  };

  const confirmRemove = async () => {
    const item = removeAsked;
    setRemoveAsked(null);
    if (!item || removing.current.has(item.signature)) return;
    removing.current.add(item.signature);
    setRemovingSignatures([...removing.current]);
    try {
      const result = await removeHostedItem(nodeBase, item);
      if (result === 'removed') {
        setRemovedSignatures((previous) => [...previous, item.signature]);
        setNote({
          text: t('node:manager.data.removed', {
            size: formatBytes(item.totalSpace, language),
          }),
          tone: 'success',
        });
      } else {
        const text = t(`node:manager.data.remove_${result}`, {
          name: item.name,
        });
        // Said in the row too: the note above may be out of view.
        setOutcomes((previous) => ({ ...previous, [item.signature]: text }));
        setNote({ text, tone: result === 'not_removed' ? 'error' : 'info' });
      }
    } catch (error) {
      const text = failureText(
        error instanceof NodeAdminError ? error.reason : 'failed'
      );
      setOutcomes((previous) => ({ ...previous, [item.signature]: text }));
      setNote({ text, tone: 'error' });
    } finally {
      removing.current.delete(item.signature);
      setRemovingSignatures([...removing.current]);
    }
  };
  const [note, setNote] = useState<Note | null>(null);
  const shownAsked = useLastShown(asked);
  const askedTotals = usePublishedTotals(
    asked?.kind === 'follow' ? asked.name : null
  );

  useEffect(() => {
    // Read the list again each time the section is shown.
    if (active) {
      follows.reload();
      readBlocked();
    }
  }, [active]);

  const held = (name: string) =>
    scan.scan?.byName.find(
      (share) => share.name.toLowerCase() === name.toLowerCase()
    ) ?? null;

  const blocked = Object.keys(blockedNames ?? {})
    .filter((name) => blockedNames[name])
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

  function readBlocked() {
    setBlockedRead('loading');
    blocks.refreshBlockedUsers().then(
      () => setBlockedRead('ok'),
      () => setBlockedRead('error')
    );
  }

  const unblock = (name: string) => {
    setUnblocking(name);
    setUnblockFailed(null);
    // Hub's Block takes a name and its owner's account together: Unblock
    // gives both back, so the Explorer and Q-Chat agree with this list.
    readNameOwner(nodeBase, name)
      .then((owner) =>
        blocks.removeBlockFromList(
          owner && blockedAddresses?.[owner] ? owner : undefined,
          name
        )
      )
      .then(
        () => setUnblocking(null),
        () => {
          setUnblocking(null);
          setUnblockFailed(name);
        }
      );
  };

  const confirmAsked = async () => {
    const request = asked;
    setAsked(null);
    if (!request) return;
    const { kind, name } = request;
    if (kind === 'follow') {
      const result = await follows.follow(name);
      if (result.status === 'done')
        setNote({
          text: t('node:manager.data.followed', { name }),
          tone: 'success',
        });
      else if (result.status === 'busy')
        setNote({ text: t('node:manager.data.busy'), tone: 'info' });
      else setNote({ text: failureText(result.reason), tone: 'error' });
      return;
    }
    const result = await follows.unfollow(name);
    if (result.status === 'done')
      setNote({
        text: result.stillFollowed
          ? t('node:manager.data.still_followed', { name })
          : t('node:manager.data.unfollowed', { name }),
        tone: result.stillFollowed ? 'info' : 'success',
      });
    else if (result.status === 'busy')
      setNote({ text: t('node:manager.data.busy'), tone: 'info' });
    else setNote({ text: failureText(result.reason), tone: 'error' });
  };

  const followButtons = (name: string) => {
    const following = follows.isFollowing(name);
    if (following === null) return null;
    return (
      <ActionButton
        busy={follows.isWriting(name)}
        color={following ? 'error' : 'primary'}
        onClick={() =>
          setAsked({ kind: following ? 'unfollow' : 'follow', name })
        }
        variant="text"
      >
        {following
          ? t('node:manager.data.unfollow', capitalize)
          : t('node:manager.data.follow', capitalize)}
      </ActionButton>
    );
  };

  const followed = useMemo(
    () =>
      [...(follows.names ?? [])].sort((a, b) =>
        a.localeCompare(b, language, { sensitivity: 'base' })
      ),
    [follows.names, language]
  );

  // Opened at a name (the Explorer's link to their files): its files open
  // under its own row, in the names the node follows, else in the shared
  // data, once those are read. Each request (seq) once.
  useEffect(() => {
    if (!focus || takenSeq.current === focus.seq) return;
    const entry = followed.find((name) => sameName(name, focus.name));
    if (!entry && (follows.status === 'loading' || !scan.scan)) return;
    takenSeq.current = focus.seq;
    if (entry) {
      setOpenFollowed(entry);
      setReveal({ name: entry, seq: focus.seq, where: 'followed' });
      return;
    }
    const share = scan.scan.byName.find((one) =>
      sameName(one.name, focus.name)
    );
    if (share) setReveal({ name: share.name, seq: focus.seq, where: 'shared' });
    else
      setNote({
        text: t('node:manager.data.name_none', { name: focus.name }),
        tone: 'info',
      });
  });

  return (
    <Box sx={{ display: 'grid', gap: 2 }}>
      {note ? <ActionNote tone={note.tone}>{note.text}</ActionNote> : null}

      <OverviewCard
        icon={<BookmarkAddedRoundedIcon />}
        id="followed_names"
        title={t('node:manager.data.followed_title', capitalize)}
        wide
      >
        <CardText>{t('node:manager.data.followed_about')}</CardText>
        {follows.names === null && follows.status === 'loading' ? (
          <CardText>{t('core:message.generic.loading', capitalize)}</CardText>
        ) : null}
        {follows.status === 'error' && follows.reason ? (
          <Box
            role="status"
            sx={{
              alignItems: 'center',
              display: 'flex',
              flexWrap: 'wrap',
              gap: 1,
            }}
          >
            <CardText>{failureText(follows.reason)}</CardText>
            <Button
              onClick={follows.reload}
              size="small"
              sx={textButtonSx}
              variant="text"
            >
              {t('core:retry', capitalize)}
            </Button>
          </Box>
        ) : null}
        {follows.names && followed.length === 0 ? (
          <CardText>{t('node:manager.data.followed_none')}</CardText>
        ) : null}
        {followed.map((name) => (
          <FollowedRow
            actions={
              <Box sx={{ display: 'inline-flex', flexWrap: 'wrap', gap: 0.5 }}>
                <Button
                  aria-expanded={openFollowed === name}
                  onClick={() =>
                    setOpenFollowed(openFollowed === name ? null : name)
                  }
                  size="small"
                  sx={textButtonSx}
                  variant="text"
                >
                  {openFollowed === name
                    ? t('node:manager.data.hide_files', capitalize)
                    : t('node:manager.data.show_files', capitalize)}
                </Button>
                {followButtons(name)}
              </Box>
            }
            held={held(name)}
            heldStatus={scan.status}
            active={active}
            key={name}
            name={name}
            nodeBase={nodeBase}
            selected={openFollowed === name}
          >
            {openFollowed === name ? (
              <>
                {reveal?.where === 'followed' && reveal.name === name ? (
                  <RevealRow
                    seq={reveal.seq}
                    target={(from) => from.closest('[data-followed-name]')}
                  />
                ) : null}
                <NameFilesBody
                  removal={removal}
                  name={name}
                  nodeBase={nodeBase}
                  onPreview={setPreview}
                />
              </>
            ) : null}
          </FollowedRow>
        ))}
      </OverviewCard>

      <OverviewCard
        icon={<BlockRoundedIcon />}
        id="blocked_names"
        title={t('node:manager.data.blocked_title')}
        wide
      >
        <CardText>{t('node:manager.data.blocked_hint')}</CardText>
        {blockedRead === 'error' ? (
          <Box
            role="status"
            sx={{
              alignItems: 'center',
              display: 'flex',
              flexWrap: 'wrap',
              gap: 1,
            }}
          >
            <CardText>{t('node:manager.data.blocked_failed')}</CardText>
            <Button
              onClick={readBlocked}
              size="small"
              sx={textButtonSx}
              variant="text"
            >
              {t('core:retry', capitalize)}
            </Button>
          </Box>
        ) : null}
        {blockedRead === 'ok' && blocked.length === 0 ? (
          <CardText>{t('node:manager.data.blocked_none')}</CardText>
        ) : null}
        {blocked.map((name) => (
          <Box
            data-blocked-name={name}
            key={name}
            sx={{
              alignItems: 'center',
              display: 'flex',
              gap: 1.25,
              px: 1,
              py: 0.75,
            }}
          >
            <NameAvatar name={name} nodeBase={nodeBase} />
            <Typography sx={{ flex: '1 1 auto', fontWeight: 700, minWidth: 0 }}>
              {name}
            </Typography>
            <Button
              aria-label={t('node:manager.data.unblock_label', { name })}
              disabled={unblocking !== null}
              onClick={() => unblock(name)}
              size="small"
              sx={textButtonSx}
              variant="text"
            >
              {t('auth:action.unblock', capitalize)}
            </Button>
          </Box>
        ))}
        {unblockFailed ? (
          <Box role="status">
            <CardText>
              {t('node:manager.data.unblock_failed', { name: unblockFailed })}
            </CardText>
          </Box>
        ) : null}
      </OverviewCard>
      <SharedData
        followButton={followButtons}
        followed={followed}
        nodeBase={nodeBase}
        onPreview={setPreview}
        removal={removal}
        reveal={reveal}
        scan={scan}
      />

      <ConfirmActionDialog
        body={
          shownRemove
            ? t('node:manager.data.remove_body', {
                file: fileLabel(shownRemove),
                size: formatBytes(shownRemove.totalSpace, language),
              })
            : ''
        }
        confirmLabel={t('node:manager.data.remove', capitalize)}
        danger
        onCancel={() => setRemoveAsked(null)}
        onConfirm={() => void confirmRemove()}
        open={removeAsked !== null}
        title={t('node:manager.data.remove_title')}
      />
      <ConfirmActionDialog
        body={
          shownAsked?.kind === 'unfollow'
            ? t('node:manager.data.unfollow_body', { name: shownAsked.name })
            : askedTotals.totals
              ? t(
                  askedTotals.totals.complete
                    ? 'node:manager.data.follow_body'
                    : 'node:manager.data.follow_body_at_least',
                  {
                    name: shownAsked?.name ?? '',
                    size: formatBytes(askedTotals.totals.bytes, language),
                  }
                )
              : t('node:manager.data.follow_body_unknown', {
                  name: shownAsked?.name ?? '',
                })
        }
        confirmLabel={
          shownAsked?.kind === 'unfollow'
            ? t('node:manager.data.unfollow', capitalize)
            : t('node:manager.data.follow', capitalize)
        }
        danger={shownAsked?.kind === 'unfollow'}
        onCancel={() => setAsked(null)}
        onConfirm={() => void confirmAsked()}
        open={asked !== null}
        title={
          shownAsked?.kind === 'unfollow'
            ? t('node:manager.data.unfollow_title', { name: shownAsked.name })
            : t('node:manager.data.follow_title', {
                name: shownAsked?.name ?? '',
              })
        }
      />

      {preview ? (
        <PreviewDialog
          item={preview}
          key={preview.signature}
          nodeBase={nodeBase}
          onClose={() => setPreview(null)}
        />
      ) : null}
    </Box>
  );
};

type SharedView = 'names' | 'services' | 'biggest' | 'newest';

const SharedData = ({
  followButton,
  followed,
  nodeBase,
  onPreview,
  removal,
  reveal,
  scan,
}: {
  followButton: (name: string) => ReactNode;
  followed: string[];
  nodeBase: string;
  onPreview: (item: HostedItem) => void;
  removal: Removal;
  reveal: Revealed | null;
  scan: ReturnType<typeof useHostedScan>;
}) => {
  const theme = useTheme();
  const { i18n, t } = useTranslation(['node', 'core']);
  const language = i18n.language;
  const capitalize = { postProcess: 'capitalizeFirstChar' } as const;
  const [view, setView] = useState<SharedView>('names');
  const [search, setSearch] = useState('');
  const [itemSort, setItemSort] = useState<Sort>({
    desc: true,
    key: 'on_disk',
  });
  const [openName, setOpenName] = useState<string | null>(null);
  const [shown, setShown] = useState(ROWS);
  const [revealRow, setRevealRow] = useState<{
    key: string;
    seq: number;
  } | null>(null);
  const query = search.trim().toLowerCase();
  const followedKeys = new Set(followed.map((name) => name.toLowerCase()));

  const matches = (text: string | null) =>
    !query || (text ?? '').toLowerCase().includes(query);
  const result = scan.scan;
  const rows = !result
    ? []
    : view === 'names'
      ? result.byName.filter((share) => matches(share.name))
      : view === 'services'
        ? result.byService.filter((share) => matches(share.service))
        : (view === 'biggest' ? result.biggest : result.newest).filter(
            (item) => matches(item.name) || matches(item.identifier)
          );

  // A name the window was opened at that the node doesn't follow: its row,
  // opened and in view.
  useEffect(() => {
    if (reveal?.where !== 'shared' || !result) return;
    const index = result.byName.findIndex(
      (share) => share.name === reveal.name
    );
    if (index < 0) return;
    const key = reveal.name.toLowerCase();
    setView('names');
    setSearch('');
    setShown((count) => Math.max(count, Math.ceil((index + 1) / ROWS) * ROWS));
    setOpenName(key);
    setRevealRow({ key, seq: reveal.seq });
  }, [reveal?.seq]);

  const views: SharedView[] = ['names', 'services', 'biggest', 'newest'];
  const itemColumns: Column<HostedItem>[] = [
    {
      label: t('node:manager.data.col_service', capitalize),
      render: (item) => item.service,
      sortKey: 'service',
      sortValue: (item) => item.service,
    },
    {
      label: t('node:manager.data.col_name', capitalize),
      render: (item) => item.name,
      sortKey: 'name',
      sortValue: (item) => item.name,
    },
    {
      label: t('node:manager.data.col_identifier', capitalize),
      render: (item) =>
        isDefaultIdentifier(item.identifier)
          ? t('node:manager.data.default_identifier')
          : item.identifier,
      sortKey: 'identifier',
      sortValue: (item) =>
        isDefaultIdentifier(item.identifier) ? '' : (item.identifier as string),
    },
    {
      firstDesc: true,
      label: t('node:manager.data.col_on_disk', capitalize),
      render: (item) => formatBytes(item.totalSpace, language),
      sortKey: 'on_disk',
      sortValue: (item) => item.totalSpace,
    },
    {
      firstDesc: true,
      label: t('node:manager.data.col_when', capitalize),
      render: (item) =>
        item.timestamp
          ? new Date(item.timestamp).toLocaleDateString(language)
          : '—',
      sortKey: 'when',
      sortValue: (item) => item.timestamp,
    },
    removeColumn(removal, t),
  ];

  return (
    <OverviewCard
      action={
        <Button
          disabled={scan.status === 'loading'}
          onClick={scan.refresh}
          size="small"
          sx={quietButtonSx(theme)}
          variant="outlined"
        >
          {t('core:action.refresh', capitalize)}
        </Button>
      }
      icon={<FolderSharedRoundedIcon />}
      id="shared_data"
      title={t('node:manager.data.shared_title', capitalize)}
      wide
    >
      {result ? (
        <CardText>
          {t('node:manager.data.shared_totals', {
            items: formatCount(result.count, language),
            space: formatBytes(result.totalSpace, language),
          })}
        </CardText>
      ) : null}
      <CardText>{t('node:manager.data.shared_snapshot')}</CardText>
      {scan.status === 'loading' ? (
        <CardText>
          {scan.progress
            ? t('node:manager.data.scan_progress', {
                read: formatCount(scan.progress[0], language),
                total: formatCount(scan.progress[1], language),
              })
            : t('core:message.generic.loading', capitalize)}
        </CardText>
      ) : null}
      {scan.status === 'error' ? (
        <Box
          role="status"
          sx={{ alignItems: 'center', display: 'flex', gap: 1 }}
        >
          <CardText>{t('node:manager.data.scan_failed')}</CardText>
          <Button
            onClick={scan.refresh}
            size="small"
            sx={textButtonSx}
            variant="text"
          >
            {t('core:retry', capitalize)}
          </Button>
        </Box>
      ) : null}
      {result && !result.complete ? (
        <CardText>
          {t('node:manager.data.scan_partial', {
            items: formatCount(result.scanned, language),
          })}
        </CardText>
      ) : null}

      {result ? (
        <>
          <Box
            sx={{
              alignItems: 'center',
              display: 'flex',
              flexWrap: 'wrap',
              gap: 1,
            }}
          >
            <Box
              aria-label={t('node:manager.data.views', capitalize)}
              role="group"
              sx={{ display: 'inline-flex', flexWrap: 'wrap', gap: 0.5 }}
            >
              {views.map((id) => (
                <Button
                  aria-pressed={view === id}
                  key={id}
                  onClick={() => {
                    setView(id);
                    setShown(ROWS);
                    // Each list starts in its own order.
                    setItemSort({
                      desc: true,
                      key: id === 'newest' ? 'when' : 'on_disk',
                    });
                  }}
                  size="small"
                  sx={{
                    ...quietButtonSx(theme),
                    ...(view === id
                      ? {
                          backgroundColor: alpha(
                            theme.palette.primary.main,
                            0.12
                          ),
                          borderColor: alpha(theme.palette.primary.main, 0.32),
                        }
                      : {}),
                  }}
                  variant="outlined"
                >
                  {t(`node:manager.data.view_${id}`, capitalize)}
                </Button>
              ))}
            </Box>
            <TextField
              inputProps={{
                'aria-label': t('node:manager.data.search', capitalize),
              }}
              onChange={(event) => {
                setSearch(event.target.value);
                setShown(ROWS);
              }}
              placeholder={t('node:manager.data.search', capitalize)}
              size="small"
              sx={{ flex: '1 1 200px', maxWidth: 320 }}
              value={search}
            />
          </Box>

          {rows.length === 0 ? (
            <CardText>{t('node:manager.data.no_match')}</CardText>
          ) : view === 'names' ? (
            <Rows
              columns={[
                {
                  label: t('node:manager.data.col_name', capitalize),
                  render: (share: (typeof result.byName)[number]) => (
                    <Box
                      component="span"
                      sx={{
                        alignItems: 'center',
                        display: 'inline-flex',
                        gap: 0.75,
                      }}
                    >
                      {share.name}
                      {followedKeys.has(share.name.toLowerCase()) ? (
                        <Chip
                          label={t('node:manager.data.followed_chip')}
                          size="small"
                          sx={{ height: 20 }}
                        />
                      ) : null}
                    </Box>
                  ),
                },
                {
                  label: t('node:manager.data.col_items', capitalize),
                  render: (share: (typeof result.byName)[number]) =>
                    formatCount(share.count, language),
                },
                {
                  label: t('node:manager.data.col_on_disk', capitalize),
                  render: (share: (typeof result.byName)[number]) =>
                    formatBytes(share.space, language),
                },
              ]}
              items={(rows as typeof result.byName).slice(0, shown)}
              expandedKey={openName}
              onRow={(share) => {
                const key = share.name.toLowerCase();
                setOpenName(openName === key ? null : key);
              }}
              renderExpanded={(share) => (
                <>
                  {revealRow?.key === share.name.toLowerCase() ? (
                    <RevealRow
                      seq={revealRow.seq}
                      target={(from) =>
                        from.closest('[data-expanded-row]')
                          ?.previousElementSibling ?? null
                      }
                    />
                  ) : null}
                  <NameFilesBody
                    removal={removal}
                    actions={
                      <>
                        {followButton(share.name)}
                        <Button
                          onClick={() => setOpenName(null)}
                          size="small"
                          sx={textButtonSx}
                          variant="text"
                        >
                          {t('node:manager.data.hide_files', capitalize)}
                        </Button>
                      </>
                    }
                    name={share.name}
                    nodeBase={nodeBase}
                    onPreview={onPreview}
                  />
                </>
              )}
              rowKey={(share) => share.name.toLowerCase()}
              rowLabel={(share) => share.name}
            />
          ) : view === 'services' ? (
            <Rows
              columns={[
                {
                  label: t('node:manager.data.col_service', capitalize),
                  render: (share: (typeof result.byService)[number]) =>
                    share.service,
                },
                {
                  label: t('node:manager.data.col_items', capitalize),
                  render: (share: (typeof result.byService)[number]) =>
                    formatCount(share.count, language),
                },
                {
                  label: t('node:manager.data.col_on_disk', capitalize),
                  render: (share: (typeof result.byService)[number]) =>
                    formatBytes(share.space, language),
                },
              ]}
              items={(rows as typeof result.byService).slice(0, shown)}
            />
          ) : (
            <Rows
              columns={itemColumns}
              onSort={(column) =>
                setItemSort((previous) => nextSort(previous, column))
              }
              sort={itemSort}
              items={sortRows(
                rows as HostedItem[],
                itemColumns,
                itemSort
              ).slice(0, shown)}
              onRow={onPreview}
              rowLabel={(item) =>
                `${item.service} ${item.name} ${item.identifier ?? ''}`
              }
            />
          )}
          {rows.length > shown ? (
            <Box>
              <Button
                onClick={() => setShown(shown + ROWS)}
                size="small"
                sx={textButtonSx}
                variant="text"
              >
                {t('node:manager.data.show_more', capitalize)}
              </Button>
            </Box>
          ) : null}
        </>
      ) : null}
    </OverviewCard>
  );
};

/** What the node holds of one name, biggest or newest first. */
const NameFilesBody = ({
  actions,
  name,
  nodeBase,
  onPreview,
  removal,
}: {
  actions?: ReactNode;
  name: string;
  nodeBase: string;
  onPreview: (item: HostedItem) => void;
  removal?: Removal;
}) => {
  const { i18n, t } = useTranslation(['node', 'core']);
  const language = i18n.language;
  const capitalize = { postProcess: 'capitalizeFirstChar' } as const;
  const files = useNodeRead(
    nodeBase,
    (base, signal) => readHostedForName(base, name, signal),
    0
  );
  const [sort, setSort] = useState<Sort>({ desc: true, key: 'on_disk' });
  const [shown, setShown] = useState(ROWS);
  const columns: Column<HostedItem>[] = [
    {
      label: t('node:manager.data.col_service', capitalize),
      render: (item) => item.service,
      sortKey: 'service',
      sortValue: (item) => item.service,
    },
    {
      label: t('node:manager.data.col_identifier', capitalize),
      render: (item) =>
        isDefaultIdentifier(item.identifier)
          ? t('node:manager.data.default_identifier')
          : item.identifier,
      sortKey: 'identifier',
      sortValue: (item) =>
        isDefaultIdentifier(item.identifier) ? '' : (item.identifier as string),
    },
    {
      firstDesc: true,
      label: t('node:manager.data.col_published', capitalize),
      render: (item) => formatBytes(item.size, language),
      sortKey: 'published',
      sortValue: (item) => item.size,
    },
    {
      firstDesc: true,
      label: t('node:manager.data.col_on_disk', capitalize),
      render: (item) => formatBytes(item.totalSpace, language),
      sortKey: 'on_disk',
      sortValue: (item) => item.totalSpace,
    },
    {
      firstDesc: true,
      label: t('node:manager.data.col_when', capitalize),
      render: (item) =>
        item.timestamp
          ? new Date(item.timestamp).toLocaleDateString(language)
          : '—',
      sortKey: 'when',
      sortValue: (item) => item.timestamp,
    },
    ...(removal ? [removeColumn(removal, t)] : []),
  ];
  const items = sortRows([...(files.value?.items ?? [])], columns, sort);
  const space = items.reduce((sum, item) => sum + item.totalSpace, 0);

  return (
    <Box data-name-files={name} sx={{ display: 'grid', gap: 1 }}>
      {files.value ? (
        <CardText>
          {items.length === 0
            ? t('node:manager.data.name_none', { name })
            : t('node:manager.data.held', {
                items: formatCount(items.length, language),
                space: formatBytes(space, language),
              })}
        </CardText>
      ) : null}
      {files.value && !files.value.complete ? (
        <CardText>
          {t('node:manager.data.name_partial', {
            items: formatCount(items.length, language),
          })}
        </CardText>
      ) : null}
      {items.length > 0 ? (
        <>
          <Rows
            columns={columns}
            onSort={(column) =>
              setSort((previous) => nextSort(previous, column))
            }
            sort={sort}
            items={items.slice(0, shown)}
            onRow={onPreview}
            rowLabel={(item) => `${item.service} ${item.identifier ?? ''}`}
          />
          {items.length > shown ? (
            <Box>
              <Button
                onClick={() => setShown(shown + ROWS)}
                size="small"
                sx={textButtonSx}
                variant="text"
              >
                {t('node:manager.data.show_more', capitalize)}
              </Button>
            </Box>
          ) : null}
        </>
      ) : null}
      <ReadNote read={files} />
      {actions ? (
        <Box sx={{ display: 'inline-flex', flexWrap: 'wrap', gap: 0.5 }}>
          {actions}
        </Box>
      ) : null}
    </Box>
  );
};

const PreviewDialog = ({
  item,
  nodeBase,
  onClose,
}: {
  item: HostedItem;
  nodeBase: string;
  onClose: () => void;
}) => {
  const theme = useTheme();
  const { i18n, t } = useTranslation(['node', 'core']);
  const language = i18n.language;
  const capitalize = { postProcess: 'capitalizeFirstChar' } as const;
  const state = useNodeRead(
    nodeBase,
    (base, signal) => readPreviewState(base, item, signal),
    0
  );
  const kind = previewKind(item.service);
  // An IMAGE can hold a zip of pictures: what the page can't show, it says.
  const [broken, setBroken] = useState(false);
  const folder = useFolder(item.signature, nodeBase);
  // Asked first when showing it builds a full copy on the node.
  const [allowBuild, setAllowBuild] = useState(false);
  const media =
    (state.value === 'ready' ||
      (state.value === 'build_needed' && allowBuild)) &&
    !broken;
  let url: string | null = null;
  try {
    url = joinNodeEndpoint(nodeBase, resourcePath('/arbitrary', item));
  } catch {
    url = null;
  }
  const text = useNodeRead(
    nodeBase,
    state.value === 'ready' && kind === 'text' && url
      ? (base, signal) =>
          getNodeText(base, resourcePath('/arbitrary', item), signal)
      : null,
    0
  );
  const shownText = useMemo(() => {
    if (text.value === null) return null;
    try {
      return JSON.stringify(JSON.parse(text.value), null, 2).slice(
        0,
        TEXT_SHOWN
      );
    } catch {
      return text.value.slice(0, TEXT_SHOWN);
    }
  }, [text.value]);

  const message =
    state.value &&
    state.value !== 'ready' &&
    !(state.value === 'build_needed' && allowBuild)
      ? t(`node:manager.data.preview_${state.value}`, {
          size: formatBytes(item.size, language),
        })
      : null;

  return (
    <Dialog
      aria-labelledby="node-data-preview-title"
      BackdropProps={{ sx: windowBackdropSx }}
      fullWidth
      maxWidth="md"
      onClose={onClose}
      open
      PaperProps={{ sx: windowPaperSx(theme) }}
    >
      <DialogTitle
        id="node-data-preview-title"
        sx={{ fontSize: '1.05rem', fontWeight: 800, overflowWrap: 'anywhere' }}
      >
        {`${item.service} · ${item.name}`}
      </DialogTitle>
      <DialogContent sx={{ display: 'grid', gap: 2 }}>
        <DetailRows
          rows={[
            [t('node:manager.data.col_service', capitalize), item.service],
            [t('node:manager.data.col_name', capitalize), item.name],
            [
              t('node:manager.data.col_identifier', capitalize),
              isDefaultIdentifier(item.identifier)
                ? t('node:manager.data.default_identifier')
                : item.identifier,
            ],
            [
              t('node:manager.data.col_published', capitalize),
              formatBytes(item.size, language),
            ],
            [
              t('node:manager.data.col_on_disk', capitalize),
              formatBytes(item.totalSpace, language),
            ],
            [
              t('node:manager.data.col_chunks', capitalize),
              formatCount(item.chunkCount, language),
            ],
            [
              t('node:manager.data.col_when', capitalize),
              item.timestamp
                ? new Date(item.timestamp).toLocaleString(language)
                : '—',
            ],
            [
              t('node:manager.data.col_signature', capitalize),
              <Box
                component="span"
                key="signature"
                sx={{
                  fontFamily: 'monospace',
                  fontSize: '0.78rem',
                  overflowWrap: 'anywhere',
                }}
              >
                {item.signature}
              </Box>,
            ],
          ]}
        />
        <Box>
          {state.status === 'loading' && state.value === null ? (
            <CardText>{t('node:manager.data.preview_checking')}</CardText>
          ) : null}
          {state.status === 'error' && state.value === null ? (
            <Box
              role="status"
              sx={{ alignItems: 'center', display: 'flex', gap: 1 }}
            >
              <CardText>{t('node:manager.data.preview_failed')}</CardText>
              <Button
                onClick={state.retry}
                size="small"
                sx={textButtonSx}
                variant="text"
              >
                {t('core:retry', capitalize)}
              </Button>
            </Box>
          ) : null}
          {message ? <CardText>{message}</CardText> : null}
          {folder.state === 'missing' ? (
            <CardText>{t('node:manager.data.gone_info')}</CardText>
          ) : null}
          {state.value === 'build_needed' && !allowBuild ? (
            <Button
              onClick={() => setAllowBuild(true)}
              size="small"
              sx={textButtonSx}
              variant="text"
            >
              {t('node:manager.data.show_anyway', capitalize)}
            </Button>
          ) : null}
          {media && url && kind === 'image' ? (
            <Box
              alt=""
              component="img"
              onError={() => setBroken(true)}
              src={url}
              sx={{
                borderRadius: '10px',
                display: 'block',
                maxHeight: 420,
                maxWidth: '100%',
              }}
            />
          ) : null}
          {media && url && kind === 'video' ? (
            <Box
              component="video"
              controls
              onError={() => setBroken(true)}
              preload="metadata"
              src={url}
              sx={{
                borderRadius: '10px',
                display: 'block',
                maxHeight: 420,
                maxWidth: '100%',
              }}
            />
          ) : null}
          {broken ? (
            <CardText>{t('node:manager.data.preview_none')}</CardText>
          ) : null}
          {media && url && kind === 'audio' ? (
            <Box
              component="audio"
              onError={() => setBroken(true)}
              controls
              preload="metadata"
              src={url}
              sx={{ width: '100%' }}
            />
          ) : null}
          {state.value === 'ready' && kind === 'text' ? (
            shownText !== null ? (
              <Box
                component="pre"
                sx={{
                  backgroundColor: alpha(theme.palette.text.primary, 0.04),
                  borderRadius: '10px',
                  fontSize: '0.78rem',
                  m: 0,
                  maxHeight: 420,
                  overflow: 'auto',
                  p: 1.5,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {shownText}
              </Box>
            ) : (
              <ReadNote read={text} />
            )
          ) : null}
        </Box>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        {folder.state === 'present' ? (
          <Button onClick={folder.show} sx={textButtonSx} variant="text">
            {t('node:manager.data.open_folder', capitalize)}
          </Button>
        ) : null}
        <Button
          onClick={() => void navigator.clipboard?.writeText(item.signature)}
          sx={textButtonSx}
          variant="text"
        >
          {t('node:manager.data.copy_signature', capitalize)}
        </Button>
        <Button onClick={onClose} sx={textButtonSx} variant="text">
          {t('core:action.close', capitalize)}
        </Button>
      </DialogActions>
    </Dialog>
  );
};
