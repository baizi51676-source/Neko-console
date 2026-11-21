/**
 * File manager.
 *
 * Security model: the client only ever sends a path *relative to* the configured
 * root. Every operation resolves it through `resolveWithin`, then re-checks with
 * `realpath` so a symlink pointing outside the root cannot be used to escape.
 * Uploads are written to a temp file and renamed into place, so a failed upload
 * cannot leave a truncated file where a complete one used to be.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { resolveWithin } from '../util.mjs';

/** Refuse to open files larger than this in the editor. */
const MAX_EDIT_BYTES = 2 * 1024 * 1024;

/** Text files we are willing to render inline. */
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.log', '.conf', '.cfg', '.ini', '.yml', '.yaml', '.json', '.toml',
  '.env', '.sh', '.bash', '.zsh', '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.css',
  '.html', '.htm', '.xml', '.sql', '.service', '.rules', '.list', '.csv', '.tsv', '.lock',
]);

/**
 * Resolve a client path and verify the *real* location stays inside root.
 *
 * realpath() is what catches symlink escapes: a link inside the root pointing at
 * /etc passes the plain string check, so the resolved physical path is verified
 * too.
 *
 * When the target does not exist yet (a new folder, an upload destination) the
 * nearest existing ancestor is validated, then the remaining segment is
 * appended. Checking only the immediate parent would break `mkdir -p a/b/c`.
 *
 * @param {string} root
 * @param {string} requested
 * @returns {Promise<string>}
 */
async function safePath(root, requested) {
  const realRoot = await realpath(root).catch(() => resolve(root));
  const lexical = resolveWithin(root, requested);
  if (!lexical) throw new Error('路径超出允许范围');

  // Fast path: the target exists, so its real location is authoritative.
  const existing = await realpath(lexical).catch(() => null);
  if (existing) {
    if (existing !== realRoot && !existing.startsWith(realRoot + sep)) {
      throw new Error('路径超出允许范围（符号链接指向外部）');
    }
    return existing;
  }

  // Slow path: walk up to the first ancestor that exists and validate that one.
  let ancestor = dirname(lexical);
  for (let depth = 0; depth < 64; depth += 1) {
    const real = await realpath(ancestor).catch(() => null);
    if (real) {
      if (real !== realRoot && !real.startsWith(realRoot + sep)) {
        throw new Error('路径超出允许范围（符号链接指向外部）');
      }
      // The remainder below `ancestor` does not exist yet; it is about to be
      // created, so it cannot itself be a symlink.
      return join(real, relative(ancestor, lexical));
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  throw new Error('目标路径不可用');
}

/**
 * List one directory.
 *
 * @param {string} root
 * @param {string} requested
 */
export async function listDirectory(root, requested) {
  const target = await safePath(root, requested);
  const info = await stat(target);
  if (!info.isDirectory()) throw new Error('不是目录');

  const entries = await readdir(target, { withFileTypes: true });
  const items = await Promise.all(
    entries.map(async (entry) => {
      const full = join(target, entry.name);
      const stats = await stat(full).catch(() => null);
      const isSymlink = entry.isSymbolicLink();
      // Resolve symlinks only to decide whether to flag them as escaping; the
      // link itself is still listed so the user can see (and delete) it.
      let escapes = false;
      if (isSymlink) {
        const real = await realpath(full).catch(() => null);
        if (real) {
          const realRoot = await realpath(root).catch(() => resolve(root));
          escapes = real !== realRoot && !real.startsWith(realRoot + sep);
        }
      }
      return {
        name: entry.name,
        path: relative(root, full).split(sep).join('/'),
        type: entry.isDirectory() ? 'dir' : isSymlink ? 'link' : 'file',
        size: stats?.size ?? 0,
        modified: stats?.mtime.toISOString() ?? null,
        mode: stats ? (stats.mode & 0o777).toString(8).padStart(3, '0') : null,
        escapes,
      };
    }),
  );

  return {
    path: relative(root, target).split(sep).join('/') || '',
    parent: dirname(relative(root, target).split(sep).join('/')) === '.' ? null : dirname(relative(root, target)),
    items: items.sort((a, b) => {
      // Directories first, then alphabetical — matches every file manager.
      if (a.type === 'dir' && b.type !== 'dir') return -1;
      if (a.type !== 'dir' && b.type === 'dir') return 1;
      return a.name.localeCompare(b.name, 'zh-CN');
    }),
  };
}

/** Read a text file for the editor. */
export async function readTextFile(root, requested) {
  const target = await safePath(root, requested);
  const info = await stat(target);
  if (!info.isFile()) throw new Error('不是文件');
  if (info.size > MAX_EDIT_BYTES) throw new Error(`文件过大（上限 ${MAX_EDIT_BYTES / 1024 / 1024} MB）`);

  const extension = extname(target).toLowerCase();
  const looksTextual = TEXT_EXTENSIONS.has(extension) || extension === '';

  const { readFile } = await import('node:fs/promises');
  const buffer = await readFile(target);
  // Binary sniff: a NUL byte in the first 8 KB means "not text".
  const sample = buffer.subarray(0, 8192);
  const binary = sample.includes(0);
  if (binary && !looksTextual) {
    return { binary: true, size: info.size, content: null };
  }
  return { binary: false, size: info.size, content: buffer.toString('utf8') };
}

/** Overwrite a text file. */
export async function writeTextFile(root, requested, content) {
  if (typeof content !== 'string') throw new Error('内容必须是文本');
  if (Buffer.byteLength(content, 'utf8') > MAX_EDIT_BYTES) throw new Error('内容过大');
  const target = await safePath(root, requested);
  await writeFile(target, content, 'utf8');
  return { ok: true, size: Buffer.byteLength(content, 'utf8') };
}

/**
 * Stream a file to an HTTP response.
 *
 * Uses createReadStream so a 1 GB ISO does not land in memory; the caller sets
 * Content-Disposition based on `download`.
 *
 * @param {string} root
 * @param {string} requested
 * @param {import('node:http').ServerResponse} res
 */
export async function streamFile(root, requested, res) {
  const target = await safePath(root, requested);
  const info = await stat(target);
  if (!info.isFile()) throw new Error('不是文件');

  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': info.size,
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(basename(target))}`,
  });
  await pipeline(createReadStream(target), res);
}

/**
 * Receive an upload stream into `requested` (a directory-relative file path).
 *
 * The body is written to `.uploading-<name>` first and renamed on success, so an
 * interrupted transfer cannot destroy the previous version of the file.
 *
 * @param {string} root
 * @param {string} requested
 * @param {import('node:stream').Readable} stream
 */
export async function receiveUpload(root, requested, stream) {
  const target = await safePath(root, requested);
  await mkdir(dirname(target), { recursive: true });
  const temp = join(dirname(target), `.uploading-${basename(target)}-${process.pid}`);
  try {
    await pipeline(stream, createWriteStream(temp));
    await rename(temp, target);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
  const info = await stat(target);
  return { ok: true, size: info.size };
}

/** Create a directory. */
export async function createDirectory(root, requested) {
  const target = await safePath(root, requested);
  await mkdir(target, { recursive: true });
  return { ok: true };
}

/** Delete a file, symlink, or directory tree. */
export async function removePath(root, requested) {
  const target = await safePath(root, requested);
  const realRoot = await realpath(root).catch(() => resolve(root));
  // Never allow deleting the root itself.
  if (target === realRoot) throw new Error('不能删除根目录');
  const info = await stat(target);
  await rm(target, { recursive: info.isDirectory(), force: false });
  return { ok: true };
}

/** Rename or move within the root. */
export async function renamePath(root, from, to) {
  const source = await safePath(root, from);
  const destination = await safePath(root, to);
  await mkdir(dirname(destination), { recursive: true });
  await rename(source, destination);
  return { ok: true };
}

export { MAX_EDIT_BYTES };
