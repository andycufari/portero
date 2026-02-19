/**
 * Portero - Main Entry Point
 */

import 'dotenv/config';
import { mkdirSync, existsSync } from 'fs';
import { MCPClientManager } from './mcp/client-manager.js';
import { Aggregator } from './mcp/aggregator.js';
import { Router } from './mcp/router.js';
import { Anonymizer } from './middleware/anonymizer.js';
import { PolicyEngine } from './middleware/policy.js';
import { ApprovalGate } from './middleware/approval.js';
import { MCPHandler } from './gateway/mcp-handler.js';
import { GatewayServer } from './gateway/server.js';
import { TelegramBot } from './telegram/bot.js';
import { AdminStore } from './telegram/admin-store.js';
import { defaultStoragePaths } from './storage/paths.js';
import { initStorage, startCleanupTask } from './db/index.js';
import { ApprovalsDB } from './db/approvals.js';
import { GrantsDB } from './db/grants.js';
import { PolicyRulesDB } from './db/policy-rules.js';
import { AuditDB } from './db/audit.js';
import { TasksDB } from './db/tasks.js';
import {
  loadMCPsConfig,
  loadReplacementsConfig,
  loadPoliciesConfig,
  loadGatewayConfig,
  loadTelegramConfig,
} from './config/loader.js';
import logger from './utils/logger.js';

async function main() {
  logger.info('Starting Portero');

  // Ensure logs directory exists
  if (!existsSync('logs')) {
    mkdirSync('logs', { recursive: true });
  }

  // Load configurations
  logger.info('Loading configurations');
  const mcpsConfig = loadMCPsConfig();
  const replacementsConfig = loadReplacementsConfig();
  const policiesConfig = loadPoliciesConfig();
  const gatewayConfig = loadGatewayConfig();
  const telegramConfig = loadTelegramConfig();

  // Validate required configs
  if (!gatewayConfig.bearerToken) {
    throw new Error('BEARER_TOKEN environment variable is required');
  }

  if (!telegramConfig.botToken) {
    throw new Error('TELEGRAM_BOT_TOKEN environment variable is required');
  }

  // Telegram admin chat id can be paired at runtime via /pair

  // Initialize storage (file-backed)
  logger.info('Initializing storage');
  const paths = defaultStoragePaths();
  await initStorage(paths);

  const approvalsDB = new ApprovalsDB(paths);
  const grantsDB = new GrantsDB(paths);
  const policyRulesDB = new PolicyRulesDB(paths);
  const auditDB = new AuditDB(paths);
  const tasksDB = new TasksDB(paths);

  // Start cleanup task
  startCleanupTask(paths);

  // Initialize MCP Client Manager
  logger.info('Initializing MCP clients');
  const clientManager = new MCPClientManager();
  await clientManager.connectAll(mcpsConfig.mcps);

  // Initialize core components
  logger.info('Initializing core components');
  const aggregator = new Aggregator(clientManager, mcpsConfig.mcps);
  const router = new Router(clientManager);
  const anonymizer = new Anonymizer(replacementsConfig.replacements);
  const policyEngine = new PolicyEngine(policiesConfig.policies, policiesConfig.defaultPolicy, policyRulesDB);

  // Initialize Telegram bot
  logger.info('Initializing Telegram bot');
  const adminStore = new AdminStore();
  const adminState = await adminStore.get();
  const initialAdminChatId = telegramConfig.adminChatId || adminState.adminChatId || '';

  const telegramBot = new TelegramBot(
    telegramConfig.botToken,
    initialAdminChatId,
    {
      pairingCode: process.env.PAIRING_CODE || '',
      adminStore,
    },
    clientManager,
    grantsDB,
    approvalsDB,
    policyRulesDB,
    auditDB,
    tasksDB,
    router,
    anonymizer
  );

  // Initialize approval gate
  const approvalGate = new ApprovalGate(tasksDB, telegramBot);

  // Initialize MCP handler
  const mcpHandler = new MCPHandler(
    aggregator,
    router,
    anonymizer,
    policyEngine,
    approvalGate,
    grantsDB,
    auditDB,
    tasksDB,
    telegramBot
  );

  // Initialize gateway server
  logger.info('Initializing gateway server');
  const server = new GatewayServer(
    mcpHandler,
    gatewayConfig.port,
    gatewayConfig.bearerToken,
    gatewayConfig.sslCertPath,
    gatewayConfig.sslKeyPath
  );

  // Start services
  // Start the HTTP server first so health checks work even if Telegram is slow/unavailable.
  await server.start();

  // Start Telegram bot (best effort, do not block gateway startup)
  void telegramBot.start().catch((error) => {
    logger.error('Telegram bot failed to start (gateway will still run)', {
      error: error instanceof Error ? error.message : String(error),
    });
  });

  logger.info('Portero started successfully', {
    port: gatewayConfig.port,
    mcpCount: mcpsConfig.mcps.length,
    replacementCount: replacementsConfig.replacements.length,
    policyCount: Object.keys(policiesConfig.policies).length,
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down gracefully`);

    await server.stop();
    await telegramBot.stop();
    await clientManager.disconnectAll();

    logger.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  logger.error('Fatal error', {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});
