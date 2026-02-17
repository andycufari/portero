/**
 * Approvals store (file-backed)
 */

import { v4 as uuidv4 } from 'uuid';
import type { StoragePaths } from '../storage/paths.js';
import { readJsonFile, writeJsonFileAtomic } from '../storage/file-store.js';
import logger from '../utils/logger.js';

export type ApprovalStatus = 'pending' | 'approved' | 'denied';

export interface PendingApproval {
  id: string;
  toolName: string;
  args: any;
  status: ApprovalStatus;
  telegramMessageId?: number;
  createdAt: Date;
  expiresAt: Date;
  resolvedAt?: Date;
}

type ApprovalsFile = {
  approvals: Array<{
    id: string;
    toolName: string;
    args: any;
    status: ApprovalStatus;
    telegramMessageId?: number;
    createdAt: string;
    expiresAt: string;
    resolvedAt?: string;
  }>;
};

export class ApprovalsDB {
  constructor(private paths: StoragePaths) {}

  async create(toolName: string, args: any, timeoutSeconds: number): Promise<PendingApproval> {
    const id = uuidv4();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + timeoutSeconds * 1000);

    const data = await readJsonFile<ApprovalsFile>(this.paths.approvalsJson, { approvals: [] });
    data.approvals.unshift({
      id,
      toolName,
      args,
      status: 'pending',
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });
    await writeJsonFileAtomic(this.paths.approvalsJson, data);

    logger.info('Created pending approval', { id, toolName, timeoutSeconds });

    return { id, toolName, args, status: 'pending', createdAt: now, expiresAt };
  }

  async get(id: string): Promise<PendingApproval | null> {
    const data = await readJsonFile<ApprovalsFile>(this.paths.approvalsJson, { approvals: [] });
    const row = data.approvals.find((a) => a.id === id);
    return row ? rowToApproval(row) : null;
  }

  async updateStatus(id: string, status: ApprovalStatus): Promise<void> {
    const now = new Date();
    const data = await readJsonFile<ApprovalsFile>(this.paths.approvalsJson, { approvals: [] });

    const row = data.approvals.find((a) => a.id === id);
    if (!row) return;

    row.status = status;
    row.resolvedAt = now.toISOString();

    await writeJsonFileAtomic(this.paths.approvalsJson, data);
    logger.info('Updated approval status', { id, status });
  }

  async setTelegramMessageId(id: string, messageId: number): Promise<void> {
    const data = await readJsonFile<ApprovalsFile>(this.paths.approvalsJson, { approvals: [] });
    const row = data.approvals.find((a) => a.id === id);
    if (!row) return;
    row.telegramMessageId = messageId;
    await writeJsonFileAtomic(this.paths.approvalsJson, data);
  }

  async getPending(): Promise<PendingApproval[]> {
    const data = await readJsonFile<ApprovalsFile>(this.paths.approvalsJson, { approvals: [] });
    return data.approvals
      .filter((a) => a.status === 'pending')
      .map((a) => rowToApproval(a));
  }

  async isExpired(id: string): Promise<boolean> {
    const approval = await this.get(id);
    if (!approval) return true;
    return new Date() > approval.expiresAt;
  }

  async getStats(): Promise<{ total: number; pending: number; approved: number; denied: number }> {
    const data = await readJsonFile<ApprovalsFile>(this.paths.approvalsJson, { approvals: [] });

    let pending = 0,
      approved = 0,
      denied = 0;
    for (const a of data.approvals) {
      if (a.status === 'pending') pending++;
      else if (a.status === 'approved') approved++;
      else if (a.status === 'denied') denied++;
    }

    return { total: data.approvals.length, pending, approved, denied };
  }
}

function rowToApproval(row: ApprovalsFile['approvals'][number]): PendingApproval {
  return {
    id: row.id,
    toolName: row.toolName,
    args: row.args,
    status: row.status,
    telegramMessageId: row.telegramMessageId,
    createdAt: new Date(row.createdAt),
    expiresAt: new Date(row.expiresAt),
    resolvedAt: row.resolvedAt ? new Date(row.resolvedAt) : undefined,
  };
}
