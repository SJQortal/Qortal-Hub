import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  coreDataDir,
  hostedFolderState,
  showHostedFolder,
  signatureFolder,
} from './node-data-folder';

const SIG =
  '2VHsRZBkPH9XLVr4igQnNhaTqe56DhiNpqEGHa1eWWehRXPLm1PV8kxuGAQMZWk3km1ybvvMVdNmwwSrH7sUmDJh';
let core = '';

beforeEach(async () => {
  core = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hub-node-data-'));
});

afterEach(async () => {
  await fs.promises.rm(core, { force: true, recursive: true });
});

describe('node data folders', () => {
  it("builds a publish's folder from its signature only", () => {
    expect(signatureFolder('/data', SIG)).toBe(
      path.join('/data', '2v', 'hs', SIG)
    );
    expect(signatureFolder('/data', '../../etc')).toBeNull();
    expect(signatureFolder('/data', `${SIG}/..`)).toBeNull();
    expect(signatureFolder('/data', 42)).toBeNull();
  });

  it("follows Core's dataPath setting, else its data folder", async () => {
    expect(await coreDataDir(core)).toBe(path.join(core, 'data'));
    await fs.promises.writeFile(
      path.join(core, 'settings.json'),
      JSON.stringify({ dataPath: 'elsewhere' })
    );
    expect(await coreDataDir(core)).toBe(path.join(core, 'elsewhere'));
  });

  it('opens a folder that exists, and nothing else', async () => {
    const show = vi.fn();
    expect(await showHostedFolder(core, SIG, show)).toBe('missing');
    expect(await showHostedFolder(null, SIG, show)).toBe('invalid');
    expect(await showHostedFolder(core, 'not a signature', show)).toBe(
      'invalid'
    );
    expect(show).not.toHaveBeenCalled();

    const folder = path.join(core, 'data', '2v', 'hs', SIG);
    await fs.promises.mkdir(folder, { recursive: true });
    expect(await showHostedFolder(core, SIG, show)).toBe('shown');
    expect(show).toHaveBeenCalledWith(folder);
  });

  it("says whether a publish's folder is still there", async () => {
    expect(await hostedFolderState(null, SIG)).toBe('unknown');
    // No data folder at all: Hub can't tell.
    expect(await hostedFolderState(core, SIG)).toBe('unknown');
    expect(await hostedFolderState(core, 'not a signature')).toBe('invalid');

    await fs.promises.mkdir(path.join(core, 'data'));
    expect(await hostedFolderState(core, SIG)).toBe('missing');

    await fs.promises.mkdir(path.join(core, 'data', '2v', 'hs', SIG), {
      recursive: true,
    });
    expect(await hostedFolderState(core, SIG)).toBe('present');
  });
});
