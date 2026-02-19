/**
 * Approval Gate - Async approval via Telegram (no blocking poll)
 */

import type { TasksDB } from '../db/tasks.js';
import type { TelegramBot } from '../telegram/bot.js';
import type { PolicyAction } from '../config/types.js';
import logger from '../utils/logger.js';

export class ApprovalGate {
  constructor(
    private tasksDB: TasksDB,
    private telegramBot: TelegramBot,
  ) {}

  async requestApproval(
    toolName: string,
    realArgs: any,
    originalArgs: any,
    policyAction: PolicyAction
  ): Promise<{ taskId: string }> {
    logger.info('Requesting async approval', { toolName });

    const task = await this.tasksDB.create(toolName, realArgs, originalArgs, policyAction);

    try {
      await this.telegramBot.sendApprovalRequest(task.id, toolName, originalArgs);
    } catch (error) {
      logger.error('Failed to send approval request', {
        error: error instanceof Error ? error.message : String(error),
      });
      await this.tasksDB.setError(task.id, 'Failed to send Telegram approval request');
    }

    return { taskId: task.id };
  }
}
