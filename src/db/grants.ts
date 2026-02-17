/**
 * Grants store (file-backed)
 */

import { v4 as uuidv4 } from 'uuid';
import type { StoragePaths } from '../storage/paths.js';
import { readJsonFile, writeJsonFileAtomic } from '../storage/file-store.js';
import logger from '../utils/logger.js';

export interface Grant {
  id: string;
  pattern: string;
  expiresAt: Date;
  createdAt: Date;
}

type GrantsFile = {
  grants: Array<{ id: string; pattern: string; createdAt: string; expiresAt: string }>;
};

export class GrantsDB {
  constructor(private paths: StoragePaths) {}

  async create(pattern: string, durationSeconds: number): Promise<Grant> {
    const id = uuidv4();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + durationSeconds * 1000);

    const data = await readJsonFile<GrantsFile>(this.paths.grantsJson, { grants: [] });
    data.grants.unshift({ id, pattern, createdAt: now.toISOString(), expiresAt: expiresAt.toISOString() });
    await writeJsonFileAtomic(this.paths.grantsJson, data);

    logger.info('Created grant', { id, pattern, durationSeconds });
    return { id, pattern, createdAt: now, expiresAt };
  }

  async hasActiveGrant(toolName: string): Promise<boolean> {
    const now = Date.now();
    const data = await readJsonFile<GrantsFile>(this.paths.grantsJson, { grants: [] });

    for (const g of data.grants) {
      const exp = new Date(g.expiresAt).getTime();
      if (Number.isFinite(exp) && exp > now && matchesPattern(toolName, g.pattern)) {
        logger.debug('Found active grant', { toolName, pattern: g.pattern });
        return true;
      }
    }

    return false;
  }

  async getActive(): Promise<Grant[]> {
    const now = Date.now();
    const data = await readJsonFile<GrantsFile>(this.paths.grantsJson, { grants: [] });

    return data.grants
      .filter((g) => new Date(g.expiresAt).getTime() > now)
      .map((g) => ({
        id: g.id,
        pattern: g.pattern,
        createdAt: new Date(g.createdAt),
        expiresAt: new Date(g.expiresAt),
      }));
  }

  async revokeAll(): Promise<number> {
    const data = await readJsonFile<GrantsFile>(this.paths.grantsJson, { grants: [] });
    const count = data.grants.length;
    await writeJsonFileAtomic(this.paths.grantsJson, { grants: [] });
    logger.info('Revoked all grants', { count });
    return count;
  }

  async revoke(id: string): Promise<boolean> {
    const data = await readJsonFile<GrantsFile>(this.paths.grantsJson, { grants: [] });
    const before = data.grants.length;
    data.grants = data.grants.filter((g) => g.id !== id);
    await writeJsonFileAtomic(this.paths.grantsJson, data);
    const found = data.grants.length !== before;
    logger.info('Revoked grant', { id, found });
    return found;
  }
}

function matchesPattern(toolName: string, pattern: string): boolean {
  if (pattern === '*') return true;

  let regexPattern = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '__DOUBLE_WILDCARD__')
    .replace(/\*/g, '[^/]*')
    .replace(/__DOUBLE_WILDCARD__/g, '.*');

  regexPattern = `^${regexPattern}$`;
  return new RegExp(regexPattern).test(toolName);
}
