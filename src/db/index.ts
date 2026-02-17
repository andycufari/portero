/**
 * Storage bootstrap + cleanup (file-backed)
 */

import type { StoragePaths } from '../storage/paths.js';
import { readJsonFile, writeJsonFileAtomic } from '../storage/file-store.js';
import logger from '../utils/logger.js';

export async function initStorage(paths: StoragePaths): Promise<void> {
  logger.info('Initializing file-backed storage', { paths });

  // Ensure files exist with correct shape.
  await writeJsonFileAtomic(paths.approvalsJson, await readJsonFile(paths.approvalsJson, { approvals: [] }));
  await writeJsonFileAtomic(paths.grantsJson, await readJsonFile(paths.grantsJson, { grants: [] }));
  await writeJsonFileAtomic(paths.rulesJson, await readJsonFile(paths.rulesJson, { rules: [] }));
}

export async function cleanupExpired(paths: StoragePaths): Promise<void> {
  const now = Date.now();

  const approvalsData = await readJsonFile(paths.approvalsJson, { approvals: [] as any[] });
  const beforeApprovals = approvalsData.approvals.length;
  approvalsData.approvals = approvalsData.approvals.filter((a: any) => {
    if (a.status !== 'pending') return true;
    const exp = new Date(a.expiresAt).getTime();
    return Number.isFinite(exp) ? exp > now : true;
  });
  const approvalsDeleted = beforeApprovals - approvalsData.approvals.length;
  if (approvalsDeleted > 0) await writeJsonFileAtomic(paths.approvalsJson, approvalsData);

  const grantsData = await readJsonFile(paths.grantsJson, { grants: [] as any[] });
  const beforeGrants = grantsData.grants.length;
  grantsData.grants = grantsData.grants.filter((g: any) => {
    const exp = new Date(g.expiresAt).getTime();
    return Number.isFinite(exp) ? exp > now : true;
  });
  const grantsDeleted = beforeGrants - grantsData.grants.length;
  if (grantsDeleted > 0) await writeJsonFileAtomic(paths.grantsJson, grantsData);

  if (approvalsDeleted > 0 || grantsDeleted > 0) {
    logger.info('Cleaned up expired entries', { approvals: approvalsDeleted, grants: grantsDeleted });
  }
}

export function startCleanupTask(paths: StoragePaths, intervalMs: number = 60000): NodeJS.Timeout {
  logger.info('Starting cleanup task', { intervalSeconds: intervalMs / 1000 });
  return setInterval(() => {
    void cleanupExpired(paths).catch((error) => {
      logger.warn('Cleanup task failed', { error: error instanceof Error ? error.message : String(error) });
    });
  }, intervalMs);
}
