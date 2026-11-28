/**
 * Atomic file writes.
 *
 * Every configuration change goes through here. Writing directly to a live
 * config file means nginx can reload mid-write and read a truncated file, which
 * takes the site — or the whole server — down. Writing to a temp file in the
 * same directory and renaming is atomic on POSIX: readers see either the old
 * file or the new one, never a partial write.
 *
 * The rename must be in the same directory (same filesystem) for this to be
 * atomic, which is why the temp name is a sibling rather than in /tmp.
 */
import { chmod, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Write `content` to `path` atomically.
 *
 * @param {string} path
 * @param {string} content
 * @param {{ mode?: number, owner?: string }} [options]
 */
export async function writeAtomic(path, content, options = {}) {
  const dir = dirname(path);
  const temp = join(dir, `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);

  try {
    await writeFile(temp, content, { encoding: 'utf8', mode: options.mode ?? 0o644 });
    if (options.mode !== undefined) await chmod(temp, options.mode);
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

/**
 * Replace a file only if its content differs.
 *
 * Avoids touching mtime (and therefore nginx reloads) when nothing changed,
 * which matters because a reload drops keep-alive connections.
 *
 * @param {string} path
 * @param {string} content
 * @param {{ mode?: number }} [options]
 * @returns {Promise<boolean>} whether the file was written
 */
export async function writeIfChanged(path, content, options = {}) {
  const { readFile } = await import('node:fs/promises');
  const existing = await readFile(path, 'utf8').catch(() => null);
  if (existing === content) return false;
  await writeAtomic(path, content, options);
  return true;
}
