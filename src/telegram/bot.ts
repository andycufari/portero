/**
 * Telegram Bot - Handle admin commands and approval requests
 */

import { Telegraf, Markup } from 'telegraf';
import type { GrantsDB } from '../db/grants.js';
import type { ApprovalsDB } from '../db/approvals.js';
import type { AuditDB } from '../db/audit.js';
import type { PolicyRulesDB } from '../db/policy-rules.js';
import type { MCPClientManager } from '../mcp/client-manager.js';
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
    private auditDB: AuditDB
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

    this.bot.command('pending', async (ctx) => {
      if (!this.isAdmin(ctx)) return;

      const pending = await this.approvalsDB.getPending();

      if (pending.length === 0) {
        await ctx.reply('No pending approvals');
        return;
      }

      let message = `⏳ Pending Approvals: ${pending.length}\n\n`;
      message += pending
        .map((approval, i) => {
          const remaining = Math.ceil((approval.expiresAt.getTime() - Date.now()) / 1000 / 60);
          return `${i + 1}. ${approval.toolName}\n   ID: ${approval.id}\n   Expires in: ${remaining}m`;
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
      if (!this.isAdmin(ctx)) return;

      const data = (ctx.callbackQuery as any)?.data as string | undefined;
      if (!data) return;

      const [action, approvalId] = data.split(':');
      const approval = approvalId ? await this.approvalsDB.get(approvalId) : null;

      const finalize = async (status: 'approved' | 'denied', note: string) => {
        if (approvalId) await this.approvalsDB.updateStatus(approvalId, status);
        await ctx.answerCbQuery(note);
        await ctx.editMessageReplyMarkup(undefined);
        await ctx.reply(`${note} (${approvalId})`);
      };

      if (action === 'approve') {
        await finalize('approved', '✅ Approved');
        logger.info('Approval approved via Telegram', { approvalId });
        return;
      }

      if (action === 'deny') {
        await finalize('denied', '❌ Denied');
        logger.info('Approval denied via Telegram', { approvalId });
        return;
      }

      if (action === 'approve_grant10m') {
        if (approval) await this.grantsDB.create(approval.toolName, 10 * 60);
        await finalize('approved', '✅ Approved + Grant 10m');
        return;
      }

      if (action === 'approve_grant1h') {
        if (approval) await this.grantsDB.create(approval.toolName, 60 * 60);
        await finalize('approved', '✅ Approved + Grant 1h');
        return;
      }

      if (action === 'approve_allow_tool') {
        if (approval) await this.policyRulesDB.upsert(approval.toolName, 'allow');
        await finalize('approved', '✅ Approved + Always allow tool');
        return;
      }

      if (action === 'deny_always_tool') {
        if (approval) await this.policyRulesDB.upsert(approval.toolName, 'deny');
        await finalize('denied', '⛔ Denied + Always deny tool');
        return;
      }

      await ctx.answerCbQuery('Unknown action');
    });
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

    try {
      await this.bot.telegram.sendMessage(this.adminChatId, text);
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

  private previewArgs(toolName: string, args: any): string | null {
    if (!args) return null;

    // Friendly previews for common tools
    if (toolName === 'filesystem/write_file') {
      const path = args?.path;
      const content = args?.content;
      const len = typeof content === 'string' ? content.length : null;
      // Privacy-friendly preview: do not echo full content.
      const contentMeta = typeof content === 'string' ? `len=${len}` : `type=${typeof content}`;
      if (path) return `path=${path} content(${contentMeta})`;
      return null;
    }

    if (toolName === 'filesystem/read_text_file' || toolName === 'filesystem/read_file') {
      const path = args?.path;
      if (path) return `path=${path}`;
      return null;
    }

    // Generic JSON preview
    try {
      const s = JSON.stringify(args);
      return `args=${this.truncate(s, 200)}`;
    } catch {
      return null;
    }
  }

  private truncate(s: string, max: number): string {
    if (s.length <= max) return s;
    return `${s.slice(0, max)}…`;
  }

  async sendApprovalRequest(approvalId: string, toolName: string, args: any): Promise<void> {
    const message = this.formatApprovalMessage(approvalId, toolName, args);

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('✅ Approve', `approve:${approvalId}`),
        Markup.button.callback('❌ Deny', `deny:${approvalId}`),
      ],
      [
        Markup.button.callback('✅ + Grant 10m', `approve_grant10m:${approvalId}`),
        Markup.button.callback('✅ + Grant 1h', `approve_grant1h:${approvalId}`),
      ],
      [
        Markup.button.callback('✅ Always allow tool', `approve_allow_tool:${approvalId}`),
        Markup.button.callback('⛔ Always deny tool', `deny_always_tool:${approvalId}`),
      ],
    ]);

    if (!this.adminChatId) {
      throw new Error('Telegram bot not paired (adminChatId is not set)');
    }

    const sentMessage = await this.bot.telegram.sendMessage(this.adminChatId, message, keyboard);
    await this.approvalsDB.setTelegramMessageId(approvalId, sentMessage.message_id);

    logger.info('Sent approval request via Telegram', { approvalId, toolName });
  }

  private formatApprovalMessage(approvalId: string, toolName: string, args: any): string {
    const lines: string[] = [];
    lines.push('🔔 Approval Required');
    lines.push('');
    lines.push(`Tool: ${toolName}`);

    const to = args?.to;
    const cc = args?.cc;
    const bcc = args?.bcc;
    const subject = args?.subject;
    const body = args?.body;

    const looksLikeEmail =
      typeof to === 'string' || Array.isArray(to) || typeof subject === 'string' || typeof body === 'string';

    if (looksLikeEmail) {
      if (to) lines.push(`To: ${Array.isArray(to) ? to.join(', ') : String(to)}`);
      if (cc) lines.push(`Cc: ${Array.isArray(cc) ? cc.join(', ') : String(cc)}`);
      if (bcc) lines.push(`Bcc: ${Array.isArray(bcc) ? bcc.join(', ') : String(bcc)}`);
      if (subject) lines.push(`Subject: ${String(subject)}`);

      if (typeof body === 'string') {
        const preview = body.length > 800 ? `${body.slice(0, 800)}\n…(truncated, ${body.length} chars)` : body;
        lines.push('');
        lines.push('Body:');
        lines.push(preview);
      } else {
        lines.push('');
        lines.push(`Args: ${JSON.stringify(args, null, 2)}`);
      }
    } else {
      lines.push(`Args: ${JSON.stringify(args, null, 2)}`);
    }

    lines.push('');
    lines.push(`ID: ${approvalId}`);

    return lines.join('\n');
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
