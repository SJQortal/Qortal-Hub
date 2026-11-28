import fs from 'fs';
import path from 'path';

/** A transaction signature as Core writes it: Base58, about 88 characters. */
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{60,100}$/;

/**
 * Where Core keeps one publish's data: `<data>/<first 2>/<next 2>/<signature>`,
 * the two short folders in lower case. Null for anything but a signature.
 */
export const signatureFolder = (
  dataDir: string,
  signature: unknown
): string | null => {
  if (typeof signature !== 'string' || !SIGNATURE.test(signature)) return null;
  return path.join(
    dataDir,
    signature.slice(0, 2).toLowerCase(),
    signature.slice(2, 4).toLowerCase(),
    signature
  );
};

/**
 * Core's data folder: its settings' `dataPath`, from Core's own folder, or
 * `data` there.
 */
export const coreDataDir = async (coreDir: string): Promise<string> => {
  try {
    const raw = await fs.promises.readFile(
      path.join(coreDir, 'settings.json'),
      'utf-8'
    );
    const dataPath = (JSON.parse(raw) as { dataPath?: unknown })?.dataPath;
    if (typeof dataPath === 'string' && dataPath.trim())
      return path.resolve(coreDir, dataPath);
  } catch {
    // No settings file, or not JSON: Core's own default.
  }
  return path.join(coreDir, 'data');
};

export type FolderState = 'present' | 'missing' | 'unknown' | 'invalid';

const isFolder = async (folder: string) =>
  (await fs.promises.stat(folder).catch(() => null))?.isDirectory() ?? false;

/**
 * One publish's folder in Core's data folder on this PC, and whether it's
 * there: `unknown` when Hub can't see Core's data folder at all.
 */
const locateHostedFolder = async (
  coreDir: string | null,
  signature: unknown
): Promise<{ folder: string | null; state: FolderState }> => {
  if (!coreDir) return { folder: null, state: 'unknown' };
  const dataDir = await coreDataDir(coreDir);
  const folder = signatureFolder(dataDir, signature);
  if (!folder) return { folder: null, state: 'invalid' };
  if (await isFolder(folder)) return { folder, state: 'present' };
  return { folder, state: (await isFolder(dataDir)) ? 'missing' : 'unknown' };
};

/** Whether one publish's folder is still in Core's data folder on this PC. */
export const hostedFolderState = async (
  coreDir: string | null,
  signature: unknown
): Promise<FolderState> => (await locateHostedFolder(coreDir, signature)).state;

export type ShowFolderResult = 'shown' | 'missing' | 'invalid';

/**
 * Opens the file manager at one publish's folder in Core's data folder on
 * this PC, built from its signature alone, and only when it exists.
 */
export const showHostedFolder = async (
  coreDir: string | null,
  signature: unknown,
  show: (folder: string) => void
): Promise<ShowFolderResult> => {
  const { folder, state } = await locateHostedFolder(coreDir, signature);
  if (state === 'present' && folder) {
    show(folder);
    return 'shown';
  }
  return state === 'invalid' || !coreDir ? 'invalid' : 'missing';
};
