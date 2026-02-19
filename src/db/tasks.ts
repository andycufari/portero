/**
 * Tasks store (file-backed) — async approval task tracking
 */

import { v4 as uuidv4 } from 'uuid';
import type { StoragePaths } from '../storage/paths.js';
import { readJsonFile, writeJsonFileAtomic } from '../storage/file-store.js';
import type { PolicyAction } from '../config/types.js';
import logger from '../utils/logger.js';

export type TaskStatus =
  | 'pending-approval'
  | 'approved-queued'
  | 'executing'
  | 'completed'
  | 'denied'
  | 'error';

export interface Task {
  id: string;
  toolName: string;
  args: any;          // real (deanonymized) args sent to MCP
  originalArgs: any;  // fake (anonymized) args from the caller
  status: TaskStatus;
  result?: any;
  error?: string;
  policyAction: PolicyAction;
  telegramMessageId?: number;
  createdAt: Date;
  approvedAt?: Date;
  executedAt?: Date;
  checkedAt?: Date;
}

type TaskRow = {
  id: string;
  toolName: string;
  args: any;
  originalArgs: any;
  status: TaskStatus;
  result?: any;
  error?: string;
  policyAction: PolicyAction;
  telegramMessageId?: number;
  createdAt: string;
  approvedAt?: string;
  executedAt?: string;
  checkedAt?: string;
};

type TasksFile = { tasks: TaskRow[] };

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    toolName: row.toolName,
    args: row.args,
    originalArgs: row.originalArgs,
    status: row.status,
    result: row.result,
    error: row.error,
    policyAction: row.policyAction,
    telegramMessageId: row.telegramMessageId,
    createdAt: new Date(row.createdAt),
    approvedAt: row.approvedAt ? new Date(row.approvedAt) : undefined,
    executedAt: row.executedAt ? new Date(row.executedAt) : undefined,
    checkedAt: row.checkedAt ? new Date(row.checkedAt) : undefined,
  };
}

export class TasksDB {
  constructor(private paths: StoragePaths) {}

  async create(
    toolName: string,
    args: any,
    originalArgs: any,
    policyAction: PolicyAction
  ): Promise<Task> {
    const id = uuidv4();
    const now = new Date();

    const data = await readJsonFile<TasksFile>(this.paths.tasksJson, { tasks: [] });
    const row: TaskRow = {
      id,
      toolName,
      args,
      originalArgs,
      status: 'pending-approval',
      policyAction,
      createdAt: now.toISOString(),
    };
    data.tasks.unshift(row);
    await writeJsonFileAtomic(this.paths.tasksJson, data);

    logger.info('Created task', { id, toolName, policyAction });
    return rowToTask(row);
  }

  async get(id: string): Promise<Task | null> {
    const data = await readJsonFile<TasksFile>(this.paths.tasksJson, { tasks: [] });
    const row = data.tasks.find((t) => t.id === id);
    return row ? rowToTask(row) : null;
  }

  async updateStatus(id: string, status: TaskStatus): Promise<void> {
    const data = await readJsonFile<TasksFile>(this.paths.tasksJson, { tasks: [] });
    const row = data.tasks.find((t) => t.id === id);
    if (!row) return;

    row.status = status;
    if (status === 'approved-queued') row.approvedAt = new Date().toISOString();
    if (status === 'executing') row.executedAt = new Date().toISOString();

    await writeJsonFileAtomic(this.paths.tasksJson, data);
    logger.info('Updated task status', { id, status });
  }

  async setResult(id: string, result: any): Promise<void> {
    const data = await readJsonFile<TasksFile>(this.paths.tasksJson, { tasks: [] });
    const row = data.tasks.find((t) => t.id === id);
    if (!row) return;

    row.status = 'completed';
    row.result = result;
    row.executedAt = new Date().toISOString();

    await writeJsonFileAtomic(this.paths.tasksJson, data);
    logger.info('Task completed', { id });
  }

  async setError(id: string, error: string): Promise<void> {
    const data = await readJsonFile<TasksFile>(this.paths.tasksJson, { tasks: [] });
    const row = data.tasks.find((t) => t.id === id);
    if (!row) return;

    row.status = 'error';
    row.error = error;
    row.executedAt = new Date().toISOString();

    await writeJsonFileAtomic(this.paths.tasksJson, data);
    logger.info('Task errored', { id, error });
  }

  async listPending(): Promise<Task[]> {
    const data = await readJsonFile<TasksFile>(this.paths.tasksJson, { tasks: [] });
    return data.tasks
      .filter((t) => t.status === 'pending-approval')
      .map(rowToTask);
  }

  async listAll(limit: number = 50): Promise<Task[]> {
    const data = await readJsonFile<TasksFile>(this.paths.tasksJson, { tasks: [] });
    return data.tasks.slice(0, limit).map(rowToTask);
  }

  async listByStatus(status: TaskStatus, limit: number = 50): Promise<Task[]> {
    const data = await readJsonFile<TasksFile>(this.paths.tasksJson, { tasks: [] });
    return data.tasks
      .filter((t) => t.status === status)
      .slice(0, limit)
      .map(rowToTask);
  }

  async setTelegramMessageId(id: string, messageId: number): Promise<void> {
    const data = await readJsonFile<TasksFile>(this.paths.tasksJson, { tasks: [] });
    const row = data.tasks.find((t) => t.id === id);
    if (!row) return;
    row.telegramMessageId = messageId;
    await writeJsonFileAtomic(this.paths.tasksJson, data);
  }

  async markChecked(id: string): Promise<void> {
    const data = await readJsonFile<TasksFile>(this.paths.tasksJson, { tasks: [] });
    const row = data.tasks.find((t) => t.id === id);
    if (!row) return;
    row.checkedAt = new Date().toISOString();
    await writeJsonFileAtomic(this.paths.tasksJson, data);
  }
}
