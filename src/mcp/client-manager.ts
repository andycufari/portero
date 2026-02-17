/**
 * MCP Client Manager - Spawns and manages connections to child MCP servers
 */

import type { ChildProcess } from 'child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { MCPConfig } from '../config/types.js';
import logger from '../utils/logger.js';

function hasUnresolvedEnvPlaceholders(obj: unknown): boolean {
  if (typeof obj === 'string') return /\$\{[^}]+\}/.test(obj);
  if (Array.isArray(obj)) return obj.some((v) => hasUnresolvedEnvPlaceholders(v));
  if (obj && typeof obj === 'object') {
    return Object.values(obj as Record<string, unknown>).some((v) => hasUnresolvedEnvPlaceholders(v));
  }
  return false;
}

export class MCPClientManager {
  private clients: Map<string, Client> = new Map();
  private transports: Map<string, StdioClientTransport> = new Map();
  // NOTE: StdioClientTransport manages the underlying child process internally.
  private processes: Map<string, ChildProcess> = new Map();

  /**
   * Connect to all configured MCP servers
   */
  async connectAll(configs: MCPConfig[]): Promise<void> {
    logger.info('Connecting to MCP servers', { count: configs.length });

    const eligible = configs.filter((c) => {
      if (hasUnresolvedEnvPlaceholders(c)) {
        logger.warn('Skipping MCP server due to missing env vars', { name: c.name });
        return false;
      }
      return true;
    });

    const results = await Promise.allSettled(eligible.map((config) => this.connect(config)));

    const connected: string[] = [];
    results.forEach((r, i) => {
      const name = eligible[i]?.name;
      if (!name) return;
      if (r.status === 'fulfilled') connected.push(name);
      else logger.error('Failed to connect MCP (continuing startup)', { name, error: String(r.reason) });
    });

    logger.info('MCP connection phase complete', { connected, skipped: configs.length - eligible.length });
  }

  /**
   * Connect to a single MCP server
   */
  async connect(config: MCPConfig): Promise<void> {
    try {
      logger.info('Connecting to MCP server', { name: config.name });

      // Create transport (spawns the MCP server process)
      // Strip Portero-specific vars so child MCPs don't inherit them (e.g. PORT)
      const { PORT, BEARER_TOKEN, TELEGRAM_BOT_TOKEN, TELEGRAM_ADMIN_CHAT_ID, PAIRING_CODE, ...parentEnv } = process.env;
      const mergedEnv = { ...parentEnv, ...config.env };
      const env: Record<string, string> = Object.fromEntries(
        Object.entries(mergedEnv).filter(([, v]) => typeof v === 'string')
      ) as Record<string, string>;

      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env,
      });

      const client = new Client(
        {
          name: 'portero',
          version: '1.0.0',
        },
        {
          capabilities: {},
        }
      );

      // Connect the client
      await client.connect(transport);

      // Store everything
      this.transports.set(config.name, transport);
      this.clients.set(config.name, client);

      logger.info('Successfully connected to MCP server', { name: config.name });
    } catch (error) {
      logger.error('Failed to connect to MCP server', {
        name: config.name,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Disconnect from an MCP server
   */
  async disconnect(name: string): Promise<void> {
    logger.info('Disconnecting from MCP server', { name });

    const client = this.clients.get(name);
    if (client) {
      await client.close();
      this.clients.delete(name);
    }

    const transport = this.transports.get(name);
    if (transport) {
      await transport.close();
      this.transports.delete(name);
    }

    const process = this.processes.get(name);
    if (process && !process.killed) {
      process.kill();
      this.processes.delete(name);
    }

    logger.info('Disconnected from MCP server', { name });
  }

  /**
   * Disconnect from all MCP servers
   */
  async disconnectAll(): Promise<void> {
    logger.info('Disconnecting from all MCP servers');
    const names = Array.from(this.clients.keys());
    await Promise.all(names.map(name => this.disconnect(name)));
  }

  /**
   * Get a client by name
   */
  getClient(name: string): Client | undefined {
    return this.clients.get(name);
  }

  /**
   * Get all clients
   */
  getAllClients(): Map<string, Client> {
    return this.clients;
  }

  /**
   * Check if a client is connected
   */
  isConnected(name: string): boolean {
    return this.clients.has(name);
  }

  /**
   * Get all connected MCP names
   */
  getConnectedNames(): string[] {
    return Array.from(this.clients.keys());
  }
}
