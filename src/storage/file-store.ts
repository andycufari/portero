/**
 * Minimal file-backed storage helpers (atomic JSON writes)
 */

import { mkdir, readFile, writeFile, rename } from 'fs/promises';
import { dirname } from 'path';

export async function ensureDirForFile(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}

export async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function writeJsonFileAtomic(path: string, data: unknown): Promise<void> {
  await ensureDirForFile(path);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  await rename(tmp, path);
}

export async function appendNdjson(path: string, obj: unknown): Promise<void> {
  await ensureDirForFile(path);
  const line = JSON.stringify(obj) + '\n';
  await writeFile(path, line, { encoding: 'utf-8', flag: 'a' });
}
