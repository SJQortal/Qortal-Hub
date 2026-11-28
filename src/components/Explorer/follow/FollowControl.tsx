/**
 * Follow and Unfollow in the Explorer: the account header's button, for all
 * of its names, and each name's on the Names tab. Following a name makes the
 * node Hub uses download that name's files and help share them, now and as
 * they publish more. The list is the Node Manager's (`useFollowedNames`), so
 * both always show the same; "Their files on your node" opens its Data
 * section at the name.
 */
import { useEffect, useRef, useState } from 'react';
import {
  Box,
  Button,
  Checkbox,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Tooltip,
  Typography,
} from '@mui/material';
import ExpandMoreRoundedIcon from '@mui/icons-material/ExpandMoreRounded';
import FolderOpenRoundedIcon from '@mui/icons-material/FolderOpenRounded';
import HowToRegRoundedIcon from '@mui/icons-material/HowToRegRounded';
import PersonAddAltRoundedIcon from '@mui/icons-material/PersonAddAltRounded';
import PersonRemoveRoundedIcon from '@mui/icons-material/PersonRemoveRounded';
import ChecklistRoundedIcon from '@mui/icons-material/ChecklistRounded';
import RefreshRoundedIcon from '@mui/icons-material/RefreshRounded';
import { useSetAtom } from 'jotai';
import { useTranslation } from 'react-i18next';
import {
  infoSnackGlobalAtom,
  openSnackGlobalAtom,
} from '../../../atoms/global';
import { formatList } from '../../../lib/explorer/format';
import { visibleName } from '../../../lib/explorer/rules';
import type { NodeAdminFailure } from '../../NodeManager/nodeAdmin';
import { openNodeManager } from '../../NodeManager/nodeManagerEvents';
import { formatBytes, formatCount } from '../../NodeManager/nodeOverview';
import {
  useFollowedNames,
  usePublishedTotals,
} from '../../NodeManager/useFollowedNames';
import { useExplorer, useNearScreen } from '../ExplorerContext';
import { cap, isolate, mutedText, ReadError } from '../parts';

type Followed = ReturnType<typeof useFollowedNames>;

/** Why a follow or unfollow didn't happen, in the Node Manager's words. */
const FAILURE_KEYS: Record<NodeAdminFailure, string> = {
  failed: 'node:manager.action.failed_failed',
  // Only a name Core couldn't take: the node's own names never are.
  invalid: 'node:manager.action.failed_failed',
  no_key: 'node:manager.action.failed_no_key',
  no_time_sync: 'node:manager.action.failed_no_time_sync',
  node_changed: 'node:manager.action.failed_node_changed',
  public: 'node:manager.action.failed_public',
  refused: 'node:manager.action.failed_refused',
};

const shownName = (name: string) => isolate(visibleName(name));

/**
 * The names `names` holds that the node follows, in their order; empty
 * until the node's list has been read once.
 */
const followedOf = (followed: Followed, names: readonly string[]) =>
  names.filter((name) => followed.isFollowing(name) === true);

/** How much `name` has published, read only while `enabled`. */
function PublishedLine({ name, enabled }: { name: string; enabled: boolean }) {
  const { t, i18n } = useTranslation(['explorer', 'core']);
  const { retry, status, totals } = usePublishedTotals(name, { enabled });
  if (status === 'idle') return null;
  if (!totals) {
    return status === 'error' ? (
      <ReadError
        message={t('explorer:follow.published_failed', cap)}
        onRetry={retry}
      />
    ) : (
      <Typography variant="body2" sx={(theme) => ({ color: mutedText(theme) })}>
        {t('explorer:follow.published_reading', cap)}
      </Typography>
    );
  }
  const size = formatBytes(totals.bytes, i18n.language);
  return (
    <Typography variant="body2" sx={(theme) => ({ color: mutedText(theme) })}>
      {totals.count === 0
        ? t('explorer:follow.published_nothing', cap)
        : totals.complete
          ? t('explorer:follow.published_size', { size, ...cap })
          : t('explorer:follow.published_at_least', { size, ...cap })}
    </Typography>
  );
}

/** One of an account's names in the dialog: its box and its size. */
function NameChoice({
  name,
  checked,
  disabled,
  onChange,
}: {
  name: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const near = useNearScreen(node);
  return (
    <Box ref={setNode} component="li" sx={{ listStyle: 'none', py: 0.5 }}>
      <FormControlLabel
        control={
          <Checkbox
            checked={checked}
            disabled={disabled}
            onChange={(event) => onChange(event.target.checked)}
          />
        }
        label={visibleName(name)}
      />
      <Box sx={{ pl: 4 }}>
        <PublishedLine name={name} enabled={near} />
      </Box>
    </Box>
  );
}

/**
 * Follow, unfollow, or pick which of an account's names the node follows.
 * One name: its question and its size. Several: a box for each, the ones
 * followed ticked (none followed: the primary name). It stays open while the
 * node's list changes, and with what went wrong when a change failed.
 */
function FollowDialog({
  followed,
  names,
  primary,
  onClose,
}: {
  followed: Followed;
  names: readonly string[];
  primary: string | null;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation(['explorer', 'core', 'node']);
  const setInfoSnack = useSetAtom(infoSnackGlobalAtom);
  const setOpenSnack = useSetAtom(openSnackGlobalAtom);
  const single = names.length === 1;
  const [ticked, setTicked] = useState<string[]>(() => {
    const already = followedOf(followed, names);
    if (already.length > 0) return already;
    return [primary && names.includes(primary) ? primary : names[0]];
  });
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    []
  );

  const following = single && followed.isFollowing(names[0]) === true;
  const wanted = (name: string) =>
    single ? !following : ticked.includes(name);
  const toFollow = names.filter(
    (name) => wanted(name) && followed.isFollowing(name) !== true
  );
  const toUnfollow = names.filter(
    (name) => !wanted(name) && followed.isFollowing(name) === true
  );
  const changes = toFollow.length + toUnfollow.length;

  const say = (message: string, type: 'success' | 'error' = 'success') => {
    setInfoSnack({ compact: true, duration: 4200, message, type });
    setOpenSnack(true);
  };
  const list = (items: string[]) =>
    formatList(items.map(shownName), i18n.language);

  const save = async () => {
    if (running || changes === 0) return;
    setRunning(true);
    setError(null);
    const done: { follows: string[]; unfollows: string[]; still: string[] } = {
      follows: [],
      still: [],
      unfollows: [],
    };
    let failure: string | null = null;
    for (const name of toFollow) {
      const result = await followed.follow(name);
      if (result.status === 'done') done.follows.push(name);
      else {
        failure =
          result.status === 'busy'
            ? t('explorer:follow.busy', cap)
            : t(FAILURE_KEYS[result.reason], cap);
        break;
      }
    }
    for (const name of failure ? [] : toUnfollow) {
      const result = await followed.unfollow(name);
      if (result.status === 'done') {
        done.unfollows.push(name);
        if (result.stillFollowed) done.still.push(name);
      } else {
        failure =
          result.status === 'busy'
            ? t('explorer:follow.busy', cap)
            : t(FAILURE_KEYS[result.reason], cap);
        break;
      }
    }
    // The outcome is said even when the window closed meanwhile: a change
    // asked for and gone wrong would go unseen otherwise.
    const shown = mounted.current;
    if (shown) setRunning(false);
    if (failure) {
      const text = t('explorer:follow.write_failed', {
        reason: failure,
        ...cap,
      });
      if (shown) setError(text);
      else say(text, 'error');
      return;
    }
    if (shown) onClose();
    if (done.still.length > 0)
      say(
        t('explorer:follow.still_followed', { names: list(done.still), ...cap })
      );
    else if (done.follows.length > 0 && done.unfollows.length > 0)
      say(t('explorer:follow.done_saved', cap));
    else if (done.follows.length > 0)
      say(
        t('explorer:follow.done_followed', {
          names: list(done.follows),
          ...cap,
        })
      );
    else
      say(
        t('explorer:follow.done_unfollowed', {
          names: list(done.unfollows),
          ...cap,
        })
      );
  };

  const title = single
    ? following
      ? t('explorer:follow.unfollow_title', {
          name: shownName(names[0]),
          ...cap,
        })
      : t('explorer:follow.follow_title', { name: shownName(names[0]), ...cap })
    : t('explorer:follow.choose_title', cap);

  return (
    <Dialog
      open
      fullWidth
      maxWidth="xs"
      onClose={() => {
        if (!running) onClose();
      }}
      aria-labelledby="explorer-follow-title"
    >
      <DialogTitle id="explorer-follow-title">{title}</DialogTitle>
      <DialogContent sx={{ display: 'grid', gap: 1.5 }}>
        <Typography variant="body2">
          {following
            ? t('explorer:follow.unfollow_intro', cap)
            : t('explorer:follow.follow_intro', cap)}
        </Typography>
        {following ? null : (
          <Typography
            variant="body2"
            sx={(theme) => ({ color: mutedText(theme) })}
          >
            {t('explorer:follow.no_limit', cap)}
          </Typography>
        )}
        {single ? (
          following ? null : (
            <PublishedLine name={names[0]} enabled />
          )
        ) : (
          <Box component="ul" sx={{ m: 0, p: 0 }}>
            {names.map((name) => (
              <NameChoice
                key={name}
                name={name}
                checked={ticked.includes(name)}
                disabled={running}
                onChange={(checked) =>
                  setTicked((previous) =>
                    checked
                      ? [...previous, name]
                      : previous.filter((other) => other !== name)
                  )
                }
              />
            ))}
          </Box>
        )}
        {error ? (
          <Typography role="alert" variant="body2" color="error">
            {error}
          </Typography>
        ) : null}
      </DialogContent>
      <DialogActions>
        <Button disabled={running} onClick={onClose}>
          {t('core:action.cancel', cap)}
        </Button>
        <Button
          variant="contained"
          color={following ? 'error' : 'primary'}
          disabled={running || changes === 0}
          startIcon={
            running ? <CircularProgress size={16} color="inherit" /> : null
          }
          onClick={() => void save()}
        >
          {single
            ? following
              ? t('explorer:follow.unfollow', cap)
              : t('explorer:follow.follow', cap)
            : t('core:action.save', cap)}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/**
 * The Follow button of an account (`names`: all of its names) or of one of
 * its names. Each account page has its own: when another account takes its
 * place (a Q-App can open one meanwhile), its menu and dialog are gone.
 */
export function FollowControl({
  names,
  primary,
  place,
}: {
  /** The names, as the node spells them; null while they're read. */
  names: readonly string[] | null;
  /** Where "Their files on your node" opens when it's followed. */
  primary: string | null;
  place: 'header' | 'name';
}) {
  const { t, i18n } = useTranslation(['explorer', 'core']);
  const followed = useFollowedNames();
  const { close } = useExplorer();
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [asking, setAsking] = useState(false);

  // The public node has no list: the header says so, a name says nothing.
  if (!followed.available) {
    if (place === 'name') return null;
    return (
      <Tooltip title={t('explorer:follow.public_node', cap)}>
        <span>
          <Button
            size="small"
            variant="outlined"
            startIcon={<PersonAddAltRoundedIcon />}
            disabled
          >
            {t('explorer:follow.follow', cap)}
          </Button>
        </span>
      </Tooltip>
    );
  }

  const none = names !== null && names.length === 0;
  const listKnown = followed.names !== null;
  const readFailed = !listKnown && followed.status === 'error';
  const writing = !!names && names.some((name) => followed.isWriting(name));
  const theirs = names && listKnown ? followedOf(followed, names) : [];

  if (names === null || none || !listKnown) {
    return (
      <Box sx={{ alignItems: 'center', display: 'inline-flex', gap: 0.5 }}>
        <Tooltip
          title={
            none
              ? t('explorer:follow.no_names', cap)
              : readFailed
                ? t('explorer:follow.read_failed', cap)
                : ''
          }
        >
          <span>
            <Button
              size="small"
              variant="outlined"
              startIcon={<PersonAddAltRoundedIcon />}
              disabled
            >
              {t('explorer:follow.follow', cap)}
            </Button>
          </span>
        </Tooltip>
        {readFailed && place === 'header' ? (
          <Tooltip title={t('explorer:follow.read_again', cap)}>
            <IconButton
              size="small"
              aria-label={t('explorer:follow.read_again', cap)}
              onClick={followed.reload}
            >
              <RefreshRoundedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        ) : null}
      </Box>
    );
  }

  const openFiles = () => {
    setMenuAnchor(null);
    const at = primary && theirs.includes(primary) ? primary : theirs[0];
    openNodeManager('data', { name: at });
    close();
  };

  const one = names.length === 1;
  const label =
    theirs.length === 0
      ? t('explorer:follow.follow', cap)
      : one || theirs.length === names.length
        ? t('explorer:follow.following', cap)
        : t('explorer:follow.following_some', {
            followed: formatCount(theirs.length, i18n.language),
            total: formatCount(names.length, i18n.language),
            ...cap,
          });
  const ariaName = one ? shownName(names[0]) : null;

  return (
    <>
      {theirs.length === 0 ? (
        <Button
          size="small"
          variant="outlined"
          startIcon={
            writing ? (
              <CircularProgress size={14} color="inherit" />
            ) : (
              <PersonAddAltRoundedIcon />
            )
          }
          disabled={writing}
          aria-label={
            ariaName
              ? t('explorer:follow.follow_name', { name: ariaName, ...cap })
              : undefined
          }
          onClick={() => setAsking(true)}
          sx={{ alignSelf: 'flex-start' }}
        >
          {label}
        </Button>
      ) : (
        <Button
          size="small"
          variant="outlined"
          color="success"
          startIcon={
            writing ? (
              <CircularProgress size={14} color="inherit" />
            ) : (
              <HowToRegRoundedIcon />
            )
          }
          endIcon={<ExpandMoreRoundedIcon />}
          disabled={writing}
          aria-haspopup="menu"
          aria-label={
            ariaName
              ? t('explorer:follow.following_name', { name: ariaName, ...cap })
              : undefined
          }
          onClick={(event) => setMenuAnchor(event.currentTarget)}
          sx={{ alignSelf: 'flex-start' }}
        >
          {label}
        </Button>
      )}
      <Menu
        anchorEl={menuAnchor}
        open={!!menuAnchor}
        onClose={() => setMenuAnchor(null)}
      >
        <MenuItem onClick={openFiles}>
          <ListItemIcon>
            <FolderOpenRoundedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>{t('explorer:follow.their_files', cap)}</ListItemText>
        </MenuItem>
        <MenuItem
          onClick={() => {
            setMenuAnchor(null);
            setAsking(true);
          }}
        >
          <ListItemIcon>
            {one ? (
              <PersonRemoveRoundedIcon fontSize="small" />
            ) : (
              <ChecklistRoundedIcon fontSize="small" />
            )}
          </ListItemIcon>
          <ListItemText>
            {one
              ? t('explorer:follow.unfollow', cap)
              : t('explorer:follow.choose', cap)}
          </ListItemText>
        </MenuItem>
      </Menu>
      {asking ? (
        <FollowDialog
          followed={followed}
          names={names}
          primary={primary}
          onClose={() => setAsking(false)}
        />
      ) : null}
    </>
  );
}
