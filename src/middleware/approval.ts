/**
 * Approval Gate - Wait for Telegram approval with timeout
 */

import type { ApprovalsDB } from '../db/approvals.js';
import type { TelegramBot } from '../telegram/bot.js';
import logger from '../utils/logger.js';

export type ApprovalResult = 'approved' | 'denied' | 'timeout';

export class ApprovalGate {
  constructor(
    private approvalsDB: ApprovalsDB,
    private telegramBot: TelegramBot,
    private timeoutSeconds: number = 300
  ) {}

  async requestApproval(toolName: string, args: any): Promise<ApprovalResult> {
    logger.info('Requesting approval', { toolName });

    const approval = await this.approvalsDB.create(toolName, args, this.timeoutSeconds);

    try {
      await this.telegramBot.sendApprovalRequest(approval.id, toolName, args);
    } catch (error) {
      logger.error('Failed to send approval request', {
        error: error instanceof Error ? error.message : String(error),
      });
      return 'denied';
    }

    const result = await this.waitForApproval(approval.id);
    logger.info('Approval result', { toolName, result });
    return result;
  }

  private async waitForApproval(approvalId: string): Promise<ApprovalResult> {
    const startTime = Date.now();
    const timeoutMs = this.timeoutSeconds * 1000;
    const pollIntervalMs = 1000;

    while (true) {
      if (Date.now() - startTime > timeoutMs) {
        logger.warn('Approval timeout', { approvalId });
        return 'timeout';
      }

      const approval = await this.approvalsDB.get(approvalId);

      if (!approval) {
        logger.error('Approval not found', { approvalId });
        return 'denied';
      }

      if (approval.status === 'approved') return 'approved';
      if (approval.status === 'denied') return 'denied';

      if (await this.approvalsDB.isExpired(approvalId)) {
        logger.warn('Approval expired', { approvalId });
        return 'timeout';
      }

      await sleep(pollIntervalMs);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
