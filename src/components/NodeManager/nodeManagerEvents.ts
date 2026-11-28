import { atom } from 'jotai';
import { executeEvent } from '../../utils/events';

/**
 * Whether the Node Manager is open. The node cards on hover stay shut
 * meanwhile: a tooltip would show over the window.
 */
export const nodeManagerOpenAtom = atom(false);

/** Opens the Node Manager; App's `NodeManagerHost` listens for it. */
export const OPEN_NODE_MANAGER_EVENT = 'openNodeManager';

/**
 * The Node Manager's sections that live in its own window. `data` is the
 * node's QDN data: the names it follows and what it shares.
 */
export type NodeManagerSection = 'overview' | 'peers' | 'control' | 'data';

export const NODE_MANAGER_SECTIONS: NodeManagerSection[] = [
  'overview',
  'peers',
  'control',
  'data',
];

export const isNodeManagerSection = (
  value: unknown
): value is NodeManagerSection =>
  NODE_MANAGER_SECTIONS.includes(value as NodeManagerSection);

/**
 * Opens the Node Manager at `section`. With a `name`, the Data section opens
 * at that name's data; the window checks the name before it shows it.
 */
export const openNodeManager = (
  section: NodeManagerSection = 'overview',
  { name }: { name?: string } = {}
) =>
  executeEvent(
    OPEN_NODE_MANAGER_EVENT,
    typeof name === 'string' ? { name, section } : { section }
  );
