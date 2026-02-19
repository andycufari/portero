/**
 * Telegram Bot - Handle admin commands and approval requests
 */

import { Telegraf, Markup } from 'telegraf';
import type { GrantsDB } from '../db/grants.js';
import type { ApprovalsDB } from '../db/approvals.js';
import type { AuditDB } from '../db/audit.js';
import type { PolicyRulesDB } from '../db/policy-rules.js';
import type { TasksDB } from '../db/tasks.js';
import type { MCPClientManager } from '../mcp/client-manager.js';
import type { Router } from '../mcp/router.js';
import type { Anonymizer } from '../middleware/anonymizer.js';
import logger from '../utils/logger.js';

function withTimeout<T>(p: Promise<T>, timeoutMs: number): Promise<T> {
  let t: NodeJS.Timeout | null = null;
  return new Promise<T>((resolve, reject) => {
    t = setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs);
    p.then((v) => resolve(v)).catch(reject).finally(() => {
      if (t) clearTimeout(t);
    });
  });
}

type PairingOptions = {
  pairingCode: string;
  adminStore: { setAdminChatId: (id: string) => Promise<void> };
};

type ExecutionNotice = {
  status: 'ok' | 'blocked' | 'error';
  toolName: string;
  policyAction?: 'allow' | 'deny' | 'require-approval' | string;
  policySource?: 'db-rule' | 'config-exact' | 'config-pattern' | 'default' | string;
  policyPattern?: string;
  policyRuleId?: string;
  usedGrant?: boolean;
  usedApproval?: boolean;
  argsPreview?: any;
  resultPreview?: any;
  error?: string;
  at?: string;
};

export class TelegramBot {
  private bot: Telegraf;
  private adminChatId: string;

  private noticeQueue: ExecutionNotice[] = [];
  private noticeFlushTimer: NodeJS.Timeout | null = null;
  private readonly noticeBatchMs = 3000;

  constructor(
    botToken: string,
    adminChatId: string,
    private pairing: PairingOptions,
    private clientManager: MCPClientManager,
    private grantsDB: GrantsDB,
    private approvalsDB: ApprovalsDB,
    private policyRulesDB: PolicyRulesDB,
    private auditDB: AuditDB,
    private tasksDB: TasksDB,
    private router: Router,
    private anonymizer: Anonymizer
  ) {
    this.bot = new Telegraf(botToken);
    this.adminChatId = adminChatId;

    this.setupCommands();
    this.setupCallbackHandlers();
  }

  private setupCommands(): void {
    this.bot.command(['start', 'help'], async (ctx) => {
      if (!this.adminChatId) {
        await ctx.reply(
          `🔐 Portero

This bot is not paired to an admin chat yet.

To pair this chat as admin:
/pair <PAIRING_CODE>

Tip: you can also run /whoami to see your chat id.`
        );
        return;
      }

      if (!this.isAdmin(ctx)) return;

      await ctx.reply(
        `🤖 Portero Bot

Commands:
/status - Show connected MCPs and active grants
/grant <pattern> <duration> - Grant temporary access (skip approvals temporarily)
  Examples:
    /grant github/* 30m
    /grant * 1h
/revoke - Revoke all active grants

/allow <pattern> - Persistently allow a tool/pattern (no approvals)
/deny <pattern> - Persistently deny a tool/pattern
/rules - List persistent rules
/unrule <id> - Remove a persistent rule

/tasks - Show recent tasks and their statuses
/pending - Show pending approvals
/logs - Show recent audit logs
/help - Show this message`
      );
    });

    this.bot.command('whoami', async (ctx) => {
      const chatId = ctx.chat?.id?.toString();
      await ctx.reply(`chat_id: ${chatId}`);
    });

    this.bot.command('pair', async (ctx) => {
      const chatId = ctx.chat?.id?.toString();
      const code = ctx.message.text.split(' ').slice(1).join(' ').trim();

      if (!this.pairing.pairingCode) {
        await ctx.reply('Pairing is disabled (PAIRING_CODE not set on server).');
        return;
      }

      if (!code) {
        await ctx.reply('Usage: /pair <PAIRING_CODE>');
        return;
      }

      if (code !== this.pairing.pairingCode) {
        await ctx.reply('Invalid pairing code.');
        return;
      }

      if (!chatId) {
        await ctx.reply('Could not read chat id.');
        return;
      }

      this.adminChatId = chatId;
      await this.pairing.adminStore.setAdminChatId(chatId);
      await ctx.reply('✅ Paired! This chat is now the admin chat for approvals.');
      logger.info('Telegram paired admin chat', { chatId });
    });

    this.bot.command('status', async (ctx) => {
      if (!this.isAdmin(ctx)) return;

      const connectedMCPs = this.clientManager.getConnectedNames();
      const activeGrants = await this.grantsDB.getActive();
      const pendingApprovals = await this.approvalsDB.getPending();
      const auditStats = await this.auditDB.getStats();

      let message = '📊 Gateway Status\n\n';
      message += `🔌 Connected MCPs: ${connectedMCPs.length}\n`;
      message += connectedMCPs.map((name) => `  • ${name}`).join('\n');
      message += '\n\n';

      message += `✅ Active Grants: ${activeGrants.length}\n`;
      if (activeGrants.length > 0) {
        message +=
          activeGrants
            .map((grant) => {
              const remaining = Math.ceil((grant.expiresAt.getTime() - Date.now()) / 1000 / 60);
              return `  • ${grant.pattern} (${remaining}m remaining)`;
            })
            .join('\n') + '\n\n';
      }

      message += `⏳ Pending Approvals: ${pendingApprovals.length}\n`;
      message += `📝 Total Audit Logs: ${auditStats.total}`;

      await ctx.reply(message);
    });

    this.bot.command('grant', async (ctx) => {
      if (!this.isAdmin(ctx)) return;

      const args = ctx.message.text.split(' ').slice(1);
      if (args.length < 2) {
        await ctx.reply('Usage: /grant <pattern> <duration>\nExample: /grant github/* 30m');
        return;
      }

      const pattern = args[0];
      const durationStr = args[1];
      const durationSeconds = this.parseDuration(durationStr);
      if (!durationSeconds) {
        await ctx.reply('Invalid duration format. Use: 30m, 1h, 2h30m, etc.');
        return;
      }

      const grant = await this.grantsDB.create(pattern, durationSeconds);
      const durationMinutes = Math.ceil(durationSeconds / 60);

      await ctx.reply(
        `✅ Grant created!\n\nPattern: ${pattern}\nDuration: ${durationMinutes} minutes\nExpires: ${grant.expiresAt.toLocaleString()}`
      );

      logger.info('Grant created via Telegram', { pattern, durationSeconds });
    });

    this.bot.command('revoke', async (ctx) => {
      if (!this.isAdmin(ctx)) return;
      const count = await this.grantsDB.revokeAll();
      await ctx.reply(`🗑️ Revoked ${count} grant(s)`);
    });

    this.bot.command('allow', async (ctx) => {
      if (!this.isAdmin(ctx)) return;

      const args = ctx.message.text.split(' ').slice(1);
      if (args.length < 1) {
        await ctx.reply('Usage: /allow <pattern>\nExample: /allow gmail/send');
        return;
      }

      const pattern = args[0];
      const rule = await this.policyRulesDB.upsert(pattern, 'allow');
      await ctx.reply(`✅ Allowed\nPattern: ${rule.pattern}\nRule ID: ${rule.id}`);
    });

    this.bot.command('deny', async (ctx) => {
      if (!this.isAdmin(ctx)) return;

      const args = ctx.message.text.split(' ').slice(1);
      if (args.length < 1) {
        await ctx.reply('Usage: /deny <pattern>\nExample: /deny stripe/*');
        return;
      }

      const pattern = args[0];
      const rule = await this.policyRulesDB.upsert(pattern, 'deny');
      await ctx.reply(`⛔ Denied\nPattern: ${rule.pattern}\nRule ID: ${rule.id}`);
    });

    this.bot.command('rules', async (ctx) => {
      if (!this.isAdmin(ctx)) return;

      const rules = await this.policyRulesDB.list();
      if (rules.length === 0) {
        await ctx.reply('No persistent rules');
        return;
      }

      const lines = rules
        .slice(0, 50)
        .map((r, i) => `${i + 1}. ${r.action.toUpperCase()}  ${r.pattern}\n   id: ${r.id}`);

      await ctx.reply(`📜 Persistent Rules (${rules.length})\n\n${lines.join('\n\n')}`);
    });

    this.bot.command('unrule', async (ctx) => {
      if (!this.isAdmin(ctx)) return;

      const args = ctx.message.text.split(' ').slice(1);
      if (args.length < 1) {
        await ctx.reply('Usage: /unrule <id>');
        return;
      }

      const id = args[0];
      const ok = await this.policyRulesDB.remove(id);
      await ctx.reply(ok ? `🗑️ Rule removed: ${id}` : `Rule not found: ${id}`);
    });

    this.bot.command('tasks', async (ctx) => {
      if (!this.isAdmin(ctx)) return;

      const tasks = await this.tasksDB.listAll(30);

      if (tasks.length === 0) {
        await ctx.reply('No tasks yet');
        return;
      }

      const groups: Record<string, string[]> = {
        'Pending Approval': [],
        'Executing': [],
        'Completed': [],
        'Denied / Failed': [],
      };

      for (const t of tasks) {
        const age = this.formatAge(t.createdAt);
        const shortId = t.id.slice(0, 8);
        const checked = t.checkedAt ? ' (checked)' : '';

        if (t.status === 'pending-approval') {
          groups['Pending Approval'].push(`  ⏳ ${t.toolName} [${shortId}] ${age}`);
        } else if (t.status === 'approved-queued' || t.status === 'executing') {
          groups['Executing'].push(`  ⚙️ ${t.toolName} [${shortId}] ${age}`);
        } else if (t.status === 'completed') {
          groups['Completed'].push(`  ✅ ${t.toolName} [${shortId}] ${age}${checked}`);
        } else {
          const label = t.status === 'denied' ? '⛔' : '❌';
          groups['Denied / Failed'].push(`  ${label} ${t.toolName} [${shortId}] ${age}`);
        }
      }

      const lines: string[] = ['📋 Tasks'];
      for (const [title, items] of Object.entries(groups)) {
        if (items.length === 0) continue;
        lines.push('');
        lines.push(`${title}:`);
        lines.push(...items);
      }

      await ctx.reply(lines.join('\n'));
    });

    this.bot.command('pending', async (ctx) => {
      if (!this.isAdmin(ctx)) return;

      const pending = await this.tasksDB.listPending();

      if (pending.length === 0) {
        await ctx.reply('No pending approvals');
        return;
      }

      let message = `⏳ Pending Approvals: ${pending.length}\n\n`;
      message += pending
        .map((task, i) => {
          const age = this.formatAge(task.createdAt);
          return `${i + 1}. ${task.toolName}\n   ID: ${task.id}\n   Created: ${age}`;
        })
        .join('\n\n');

      await ctx.reply(message);
    });

    this.bot.command('logs', async (ctx) => {
      if (!this.isAdmin(ctx)) return;

      const logs = await this.auditDB.getRecent(10);

      if (logs.length === 0) {
        await ctx.reply('No audit logs yet');
        return;
      }

      let message = '📝 Recent Audit Logs:\n\n';
      message += logs
        .map((log) => {
          const time = log.timestamp.toLocaleTimeString();
          const status = log.error ? '❌' : '✅';
          return `${status} ${time} - ${log.toolName}`;
        })
        .join('\n');

      await ctx.reply(message);
    });
  }

  private setupCallbackHandlers(): void {
    this.bot.on('callback_query', async (ctx) => {
      try {
        if (!this.isAdmin(ctx)) return;

        const data = (ctx.callbackQuery as any)?.data as string | undefined;
        if (!data) return;

        // Handle change_policy callbacks from execution notices
        if (data.startsWith('change_policy:')) {
          const parts = data.split(':');
          // Format: change_policy:<action>:<toolName>
          const action = parts[1] as 'require-approval' | 'deny';
          const toolName = parts.slice(2).join(':'); // tool name might contain colons
          if (toolName && (action === 'require-approval' || action === 'deny')) {
            await this.policyRulesDB.upsert(toolName, action);
            const label = action === 'deny' ? '⛔ Denied' : '🔐 Require approval';
            await ctx.answerCbQuery(`${label}: ${toolName}`);
            await ctx.editMessageReplyMarkup(undefined);
            await ctx.reply(`${label}\nPattern: ${toolName}`);
            return;
          }
          await ctx.answerCbQuery('Invalid action');
          return;
        }

        // Task-based approval callbacks
        // Format: <action>:<taskId> — taskId is a full UUID (no colons)
        const colonIdx = data.indexOf(':');
        const action = colonIdx > 0 ? data.slice(0, colonIdx) : data;
        const taskId = colonIdx > 0 ? data.slice(colonIdx + 1) : '';
        const task = taskId ? await this.tasksDB.get(taskId) : null;

        if (!task) {
          await ctx.answerCbQuery('Task not found');
          return;
        }

        const finalize = async (status: 'approved' | 'denied', note: string) => {
          await ctx.answerCbQuery(note);
          await ctx.editMessageReplyMarkup(undefined);
          await ctx.reply(`${note} (${taskId.slice(0, 8)})`);
        };

        if (action === 'approve') {
          if (task.status === 'pending-approval') {
            await this.tasksDB.updateStatus(taskId, 'approved-queued');
            await finalize('approved', '✅ Approved');
            logger.info('Task approved via Telegram', { taskId });
            void this.executeApprovedTask(taskId);
          } else {
            await ctx.answerCbQuery('Task already processed');
          }
          return;
        }

        if (action === 'deny') {
          if (task.status === 'pending-approval') {
            await this.tasksDB.updateStatus(taskId, 'denied');
            await finalize('denied', '❌ Denied');
            logger.info('Task denied via Telegram', { taskId });
          } else {
            await ctx.answerCbQuery('Task already processed');
          }
          return;
        }

        if (action === 'approve_grant10m') {
          if (task.status === 'pending-approval') {
            await this.grantsDB.create(task.toolName, 10 * 60);
            await this.tasksDB.updateStatus(taskId, 'approved-queued');
            await finalize('approved', '✅ Approved + Grant 10m');
            void this.executeApprovedTask(taskId);
          } else {
            await ctx.answerCbQuery('Task already processed');
          }
          return;
        }

        if (action === 'approve_grant1h') {
          if (task.status === 'pending-approval') {
            await this.grantsDB.create(task.toolName, 60 * 60);
            await this.tasksDB.updateStatus(taskId, 'approved-queued');
            await finalize('approved', '✅ Approved + Grant 1h');
            void this.executeApprovedTask(taskId);
          } else {
            await ctx.answerCbQuery('Task already processed');
          }
          return;
        }

        if (action === 'approve_allow_tool') {
          if (task.status === 'pending-approval') {
            await this.policyRulesDB.upsert(task.toolName, 'allow');
            await this.tasksDB.updateStatus(taskId, 'approved-queued');
            await finalize('approved', '✅ Approved + Always allow tool');
            void this.executeApprovedTask(taskId);
          } else {
            await ctx.answerCbQuery('Task already processed');
          }
          return;
        }

        if (action === 'deny_always_tool') {
          if (task.status === 'pending-approval') {
            await this.policyRulesDB.upsert(task.toolName, 'deny');
            await this.tasksDB.updateStatus(taskId, 'denied');
            await finalize('denied', '⛔ Denied + Always deny tool');
          } else {
            await ctx.answerCbQuery('Task already processed');
          }
          return;
        }

        await ctx.answerCbQuery('Unknown action');
      } catch (error) {
        logger.error('Callback query handler failed', {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
        // Always answer the callback to prevent Telegram UI from hanging
        try {
          await ctx.answerCbQuery('Error processing action');
        } catch {
          // Already answered or timed out
        }
      }
    });
  }

  /**
   * Execute an approved task: call the MCP, deanonymize, store result
   */
  private async executeApprovedTask(taskId: string): Promise<void> {
    const task = await this.tasksDB.get(taskId);
    if (!task) return;

    await this.tasksDB.updateStatus(taskId, 'executing');

    try {
      const result = await this.router.callTool(task.toolName, task.args);
      const fakeResult = this.anonymizer.deanonymizeResponse(result);

      await this.tasksDB.setResult(taskId, fakeResult);

      await this.auditDB.log({
        toolName: task.toolName,
        args: task.originalArgs,
        result: fakeResult,
        policyAction: task.policyAction,
        approvalStatus: 'approved',
      });

      logger.info('Task executed successfully', { taskId, toolName: task.toolName });

      // Notify admin of completion
      if (this.adminChatId) {
        const shortId = taskId.slice(0, 8);
        try {
          await this.bot.telegram.sendMessage(
            this.adminChatId,
            `✅ Task completed: ${task.toolName} [${shortId}]\nUse portero/check_task to retrieve the result.`
          );
        } catch {
          // Non-critical
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.tasksDB.setError(taskId, errorMessage);

      await this.auditDB.log({
        toolName: task.toolName,
        args: task.originalArgs,
        policyAction: task.policyAction,
        approvalStatus: 'approved',
        error: errorMessage,
      });

      logger.error('Task execution failed', { taskId, toolName: task.toolName, error: errorMessage });

      // Notify admin of failure
      if (this.adminChatId) {
        const shortId = taskId.slice(0, 8);
        try {
          await this.bot.telegram.sendMessage(
            this.adminChatId,
            `❌ Task failed: ${task.toolName} [${shortId}]\n${this.truncate(errorMessage, 200)}`
          );
        } catch {
          // Non-critical
        }
      }
    }
  }

  private isAdmin(ctx: any): boolean {
    const chatId = ctx.chat?.id?.toString();

    // Not paired yet: block everything except /pair and /whoami (handled above)
    if (!this.adminChatId) {
      ctx.reply('🔐 Not paired yet. Use /pair <PAIRING_CODE>.');
      return false;
    }

    if (chatId !== this.adminChatId) {
      ctx.reply('⛔ Unauthorized');
      logger.warn('Unauthorized Telegram access attempt', { chatId });
      return false;
    }

    return true;
  }

  private parseDuration(str: string): number | null {
    const regex = /^(?:(\d+)h)?(?:(\d+)m)?$/;
    const match = str.match(regex);
    if (!match) return null;

    const hours = parseInt(match[1] || '0', 10);
    const minutes = parseInt(match[2] || '0', 10);
    if (hours === 0 && minutes === 0) return null;

    return hours * 3600 + minutes * 60;
  }

  private formatAge(date: Date): string {
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  async enqueueExecutionNotice(notice: ExecutionNotice): Promise<void> {
    // If we don't have an admin yet, don't spam random chats.
    if (!this.adminChatId) return;

    const enriched: ExecutionNotice = {
      at: new Date().toISOString(),
      usedGrant: Boolean(notice.usedGrant),
      usedApproval: Boolean(notice.usedApproval),
      ...notice,
    };

    this.noticeQueue.push(enriched);

    if (!this.noticeFlushTimer) {
      this.noticeFlushTimer = setTimeout(() => void this.flushExecutionNotices(), this.noticeBatchMs);
    }
  }

  private async flushExecutionNotices(): Promise<void> {
    const batch = this.noticeQueue.splice(0, 25);
    if (this.noticeFlushTimer) {
      clearTimeout(this.noticeFlushTimer);
      this.noticeFlushTimer = null;
    }
    if (batch.length === 0) return;
    if (!this.adminChatId) return;

    const text = this.formatExecutionBatch(batch);

    // Collect unique auto-allowed tool names for config change buttons
    const autoAllowed = new Set<string>();
    for (const n of batch) {
      if (n.status === 'ok' && n.policyAction === 'allow') {
        autoAllowed.add(n.toolName);
      }
    }

    const buttons: Array<Array<ReturnType<typeof Markup.button.callback>>> = [];
    if (autoAllowed.size > 0 && autoAllowed.size <= 3) {
      for (const toolName of autoAllowed) {
        const shortName = toolName.split('/').pop() || toolName;
        buttons.push([
          Markup.button.callback(`🔐 Require approval: ${shortName}`, `change_policy:require-approval:${toolName}`),
          Markup.button.callback(`⛔ Deny: ${shortName}`, `change_policy:deny:${toolName}`),
        ]);
      }
    }

    try {
      if (buttons.length > 0) {
        const keyboard = Markup.inlineKeyboard(buttons);
        await this.bot.telegram.sendMessage(this.adminChatId, text, keyboard);
      } else {
        await this.bot.telegram.sendMessage(this.adminChatId, text);
      }
    } catch (error) {
      logger.warn('Failed to send execution notice batch', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // If new notices came in while sending, schedule another flush.
    if (this.noticeQueue.length > 0 && !this.noticeFlushTimer) {
      this.noticeFlushTimer = setTimeout(() => void this.flushExecutionNotices(), this.noticeBatchMs);
    }
  }

  private formatExecutionBatch(batch: ExecutionNotice[]): string {
    const lines: string[] = [];
    lines.push('🧾 Portero — activity (last 3s)');

    type Preview =
      | { kind: 'none' }
      | { kind: 'file-write'; paths: string[]; lens: Array<number | null> }
      | { kind: 'file-read'; path: string };

    const reasonLabel = (n: ExecutionNotice): string | null => {
      // Keep reasons short and human.
      if (n.usedApproval) return 'approved';
      if (n.usedGrant) return 'grant';
      if (n.policySource === 'db-rule' && n.policyPattern) return 'rule';

      // Default config pattern "*" is too noisy; omit.
      if (n.policySource === 'config-pattern' && n.policyPattern === '*') return null;

      // Otherwise keep a small hint.
      if (n.policySource === 'config-exact') return 'config';
      if (n.policySource === 'config-pattern') return 'config';
      if (n.policySource === 'default') return 'default';
      return n.policyAction ? String(n.policyAction) : null;
    };

    const extractPreview = (n: ExecutionNotice): Preview => {
      const args = n.argsPreview;
      if (!args) return { kind: 'none' };

      if (n.toolName === 'filesystem/write_file') {
        const p = typeof args.path === 'string' ? args.path : null;
        const len = typeof args.content === 'string' ? args.content.length : null;
        if (!p) return { kind: 'none' };
        return { kind: 'file-write', paths: [p], lens: [len] };
      }

      if (n.toolName === 'filesystem/read_text_file' || n.toolName === 'filesystem/read_file') {
        const p = typeof args.path === 'string' ? args.path : null;
        if (!p) return { kind: 'none' };
        return { kind: 'file-read', path: p };
      }

      return { kind: 'none' };
    };

    // Group repeated events for scanability.
    type Group = {
      statusIcon: string;
      toolName: string;
      reason: string | null;
      count: number;
      previews: Preview[];
      errors: string[];
    };

    const groups = new Map<string, Group>();

    for (const n of batch) {
      const statusIcon = n.status === 'ok' ? '✅' : n.status === 'blocked' ? '⛔' : '❌';
      const r = reasonLabel(n);
      const key = `${statusIcon}|${n.toolName}|${r ?? ''}`;

      const g = groups.get(key) ?? {
        statusIcon,
        toolName: n.toolName,
        reason: r,
        count: 0,
        previews: [],
        errors: [],
      };

      g.count += 1;
      g.previews.push(extractPreview(n));
      if (n.status !== 'ok' && n.error) g.errors.push(String(n.error));

      groups.set(key, g);
    }

    for (const g of groups.values()) {
      const reason = g.reason ? ` (${g.reason})` : '';
      const count = g.count > 1 ? ` x${g.count}` : '';
      lines.push(`${g.statusIcon} ${g.toolName}${count}${reason}`);

      // Friendly details
      const writes = g.previews.filter((p) => p.kind === 'file-write') as Array<Extract<Preview, { kind: 'file-write' }>>;
      const reads = g.previews.filter((p) => p.kind === 'file-read') as Array<Extract<Preview, { kind: 'file-read' }>>;

      if (writes.length) {
        const paths = writes.flatMap((w) => w.paths);
        const lens = writes.flatMap((w) => w.lens).filter((x) => x !== null) as number[];
        const lenHint = lens.length ? `content(len=${lens[0]})` : 'content';
        lines.push(`   path=${paths.join(', ')} ${lenHint}`);
      } else if (reads.length) {
        // If grouped reads, list paths.
        const paths = reads.map((r) => r.path);
        lines.push(`   path=${paths.join(', ')}`);
      }

      if (g.errors.length) {
        lines.push(`   error: ${this.truncate(g.errors[0], 220)}`);
      }
    }

    if (this.noticeQueue.length > 0) {
      lines.push(`…and ${this.noticeQueue.length} more`);
    }

    return lines.join('\n');
  }

  private truncate(s: string, max: number): string {
    if (s.length <= max) return s;
    return `${s.slice(0, max)}…`;
  }

  async sendApprovalRequest(taskId: string, toolName: string, args: any): Promise<void> {
    const message = this.formatApprovalMessage(taskId, toolName, args);

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('✅ Approve', `approve:${taskId}`),
        Markup.button.callback('❌ Deny', `deny:${taskId}`),
      ],
      [
        Markup.button.callback('✅ + Grant 10m', `approve_grant10m:${taskId}`),
        Markup.button.callback('✅ + Grant 1h', `approve_grant1h:${taskId}`),
      ],
      [
        Markup.button.callback('✅ Always allow tool', `approve_allow_tool:${taskId}`),
        Markup.button.callback('⛔ Always deny tool', `deny_always_tool:${taskId}`),
      ],
    ]);

    if (!this.adminChatId) {
      throw new Error('Telegram bot not paired (adminChatId is not set)');
    }

    const sentMessage = await this.bot.telegram.sendMessage(this.adminChatId, message, keyboard);
    await this.tasksDB.setTelegramMessageId(taskId, sentMessage.message_id);

    logger.info('Sent approval request via Telegram', { taskId, toolName });
  }

  private formatApprovalMessage(taskId: string, toolName: string, args: any): string {
    const lines: string[] = [];
    lines.push('🔔 Approval Required');
    lines.push('');
    lines.push(`Tool: ${toolName}`);

    // Try type-specific formatters in order; first non-null wins
    const formatted =
      this.formatEmail(args) ??
      this.formatCalendar(toolName, args) ??
      this.formatFileOps(toolName, args) ??
      this.formatGitHub(toolName, args) ??
      this.formatNotion(toolName, args) ??
      this.formatStripe(toolName, args) ??
      this.formatGenericSmart(args);

    if (formatted) {
      lines.push(...formatted);
    }

    lines.push('');
    lines.push(`ID: ${taskId}`);

    return lines.join('\n');
  }

  // --- Type-specific formatters ---

  private formatEmail(args: any): string[] | null {
    if (!args) return null;
    const { to, cc, bcc, subject, body } = args;
    const looksLikeEmail =
      typeof to === 'string' || Array.isArray(to) || typeof subject === 'string' || typeof body === 'string';
    if (!looksLikeEmail) return null;

    const lines: string[] = [];
    if (to) lines.push(`To: ${Array.isArray(to) ? to.join(', ') : String(to)}`);
    if (cc) lines.push(`Cc: ${Array.isArray(cc) ? cc.join(', ') : String(cc)}`);
    if (bcc) lines.push(`Bcc: ${Array.isArray(bcc) ? bcc.join(', ') : String(bcc)}`);
    if (subject) lines.push(`Subject: ${String(subject)}`);
    if (typeof body === 'string') {
      const preview = body.length > 800 ? `${body.slice(0, 800)}\n…(truncated, ${body.length} chars)` : body;
      lines.push('');
      lines.push('Body:');
      lines.push(preview);
    }
    return lines;
  }

  private formatCalendar(toolName: string, args: any): string[] | null {
    if (!args) return null;
    if (!(/event|calendar/i.test(toolName))) return null;

    const lines: string[] = [];
    if (args.summary || args.title) lines.push(`Event: ${args.summary || args.title}`);
    if (args.start) lines.push(`Start: ${typeof args.start === 'object' ? JSON.stringify(args.start) : String(args.start)}`);
    if (args.end) lines.push(`End: ${typeof args.end === 'object' ? JSON.stringify(args.end) : String(args.end)}`);
    if (args.attendees) {
      const attendees = Array.isArray(args.attendees)
        ? args.attendees.map((a: any) => typeof a === 'string' ? a : a?.email || JSON.stringify(a)).join(', ')
        : String(args.attendees);
      lines.push(`Attendees: ${attendees}`);
    }
    if (args.location) lines.push(`Location: ${String(args.location)}`);
    if (args.description) lines.push(`Description: ${this.truncate(String(args.description), 300)}`);
    return lines.length > 0 ? lines : null;
  }

  private formatFileOps(toolName: string, args: any): string[] | null {
    if (!args) return null;
    if (!(/filesystem|file/i.test(toolName))) return null;

    const lines: string[] = [];
    const op = toolName.split('/').pop() || toolName;
    lines.push(`Operation: ${op}`);
    if (args.path) lines.push(`Path: ${String(args.path)}`);
    if (args.destination) lines.push(`Destination: ${String(args.destination)}`);
    if (typeof args.content === 'string') lines.push(`Content length: ${args.content.length} chars`);
    return lines;
  }

  private formatGitHub(toolName: string, args: any): string[] | null {
    if (!args) return null;
    if (!toolName.startsWith('github/')) return null;

    const lines: string[] = [];
    const action = toolName.split('/').pop() || toolName;
    lines.push(`Action: ${action}`);
    if (args.owner && args.repo) lines.push(`Repo: ${args.owner}/${args.repo}`);
    else if (args.repo) lines.push(`Repo: ${args.repo}`);
    if (args.title) lines.push(`Title: ${String(args.title)}`);
    if (args.body) lines.push(`Body: ${this.truncate(String(args.body), 300)}`);
    if (args.branch) lines.push(`Branch: ${String(args.branch)}`);
    if (args.head) lines.push(`Head: ${String(args.head)}`);
    if (args.base) lines.push(`Base: ${String(args.base)}`);
    return lines;
  }

  private formatNotion(toolName: string, args: any): string[] | null {
    if (!args) return null;
    if (!toolName.startsWith('notion/')) return null;

    const lines: string[] = [];
    const action = toolName.replace('notion/', '');
    lines.push(`Action: ${action}`);
    if (args.page_id) lines.push(`Page ID: ${String(args.page_id)}`);
    if (args.block_id) lines.push(`Block ID: ${String(args.block_id)}`);
    if (args.database_id) lines.push(`Database ID: ${String(args.database_id)}`);
    if (args.properties) {
      const keys = Object.keys(args.properties);
      lines.push(`Properties: ${keys.join(', ')}`);
    }
    return lines;
  }

  private formatStripe(toolName: string, args: any): string[] | null {
    if (!args) return null;
    if (!toolName.startsWith('stripe/')) return null;

    const lines: string[] = [];
    const action = toolName.replace('stripe/', '');
    lines.push(`Action: ${action}`);
    if (args.amount !== undefined) {
      const amount = typeof args.amount === 'number' ? (args.amount / 100).toFixed(2) : String(args.amount);
      const currency = args.currency ? ` ${String(args.currency).toUpperCase()}` : '';
      lines.push(`Amount: ${amount}${currency}`);
    }
    if (args.customer) lines.push(`Customer: ${String(args.customer)}`);
    if (args.description) lines.push(`Description: ${this.truncate(String(args.description), 200)}`);
    if (args.email) lines.push(`Email: ${String(args.email)}`);
    if (args.name) lines.push(`Name: ${String(args.name)}`);
    return lines;
  }

  private formatGenericSmart(args: any): string[] | null {
    if (!args || typeof args !== 'object') return null;

    const lines: string[] = [];
    const entries = Object.entries(args);
    for (const [key, value] of entries.slice(0, 8)) {
      if (value === null || value === undefined) continue;
      if (typeof value === 'string') {
        lines.push(`${key}: ${this.truncate(value, 200)}`);
      } else if (typeof value === 'number' || typeof value === 'boolean') {
        lines.push(`${key}: ${String(value)}`);
      } else if (Array.isArray(value)) {
        lines.push(`${key}: [${value.length} items]`);
      } else if (typeof value === 'object') {
        const keys = Object.keys(value as object);
        lines.push(`${key}: {${keys.slice(0, 5).join(', ')}${keys.length > 5 ? '...' : ''}}`);
      }
    }
    if (entries.length > 8) {
      lines.push(`…and ${entries.length - 8} more fields`);
    }
    return lines.length > 0 ? lines : null;
  }

  async start(): Promise<void> {
    logger.info('Starting Telegram bot');

    // Fast sanity: token validity + connectivity
    try {
      const me = await withTimeout(this.bot.telegram.getMe(), 5000);
      logger.info('Telegram getMe ok', { username: me.username, id: me.id });
    } catch (error) {
      logger.error('Telegram getMe failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    // Ensure polling works even if a webhook was previously set
    try {
      await withTimeout(this.bot.telegram.deleteWebhook({ drop_pending_updates: true } as any), 5000);
      logger.info('Telegram webhook cleared');
    } catch (error) {
      logger.warn('Failed to clear Telegram webhook (continuing)', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Telegraf long-polling startup can take longer than you expect.
    // We want the gateway to keep running even if polling takes a while.
    // So: warn if it's slow, but don't treat a timeout as a hard failure.
    const slowTimer = setTimeout(() => {
      logger.warn('Telegram bot launch is taking longer than expected (still starting)');
    }, 30000);

    try {
      await this.bot.launch({ dropPendingUpdates: true });
      logger.info('Telegram bot started (polling)');
    } catch (error) {
      // Diagnose common cause: another poller already running (409 Conflict)
      try {
        // telegraf types: getUpdates(offset, limit, timeout, allowed_updates)
        await withTimeout((this.bot.telegram as any).getUpdates(undefined, 1, 0, undefined), 5000);
      } catch (diag) {
        logger.error('Telegram polling diagnostic failed', {
          error: diag instanceof Error ? diag.message : String(diag),
        });
      }
      throw error;
    } finally {
      clearTimeout(slowTimer);
    }
  }

  async stop(): Promise<void> {
    logger.info('Stopping Telegram bot');
    this.bot.stop();
  }
}
