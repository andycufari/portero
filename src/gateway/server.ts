/**
 * HTTPS Server for MCP Gateway
 */

import express from 'express';
import https from 'https';
import http from 'http';
import { readFileSync, existsSync } from 'fs';
import type { MCPHandler } from './mcp-handler.js';
import { bearerAuthMiddleware } from './auth.js';
import logger from '../utils/logger.js';

export class GatewayServer {
  private app: express.Application;
  private server: https.Server | http.Server | null = null;

  constructor(
    private mcpHandler: MCPHandler,
    private port: number,
    private bearerToken: string,
    private sslCertPath?: string,
    private sslKeyPath?: string
  ) {
    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
  }

  /**
   * Set up Express middleware
   */
  private setupMiddleware(): void {
    // JSON body parser
    this.app.use(express.json({ limit: '10mb' }));

    // Request logging
    this.app.use((req, res, next) => {
      logger.debug('Incoming request', {
        method: req.method,
        path: req.path,
        ip: req.ip,
      });
      next();
    });
  }

  /**
   * Set up Express routes
   */
  private setupRoutes(): void {
    // Health check endpoint (no auth required)
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      });
    });

    // Main MCP endpoint (requires auth)
    this.app.post('/mcp/message', bearerAuthMiddleware(this.bearerToken), async (req, res) => {
      try {
        const request = req.body;

        if (!request || typeof request !== 'object') {
          res.status(400).json({
            jsonrpc: '2.0',
            id: null,
            error: {
              code: -32700,
              message: 'Parse error: Invalid JSON-RPC request',
            },
          });
          return;
        }

        // Handle the request through MCP handler
        const response = await this.mcpHandler.handleRequest(request);

        res.json(response);
      } catch (error) {
        logger.error('Error handling MCP request', {
          error: error instanceof Error ? error.message : String(error),
        });

        res.status(500).json({
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32603,
            message: 'Internal error',
          },
        });
      }
    });

    // 404 handler
    this.app.use((req, res) => {
      res.status(404).json({ error: 'Not found' });
    });

    // Error handler
    this.app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
      logger.error('Express error', {
        error: err.message,
        stack: err.stack,
      });

      res.status(500).json({ error: 'Internal server error' });
    });
  }

  /**
   * Start the server
   */
  async start(): Promise<void> {
    // Check if we should use HTTPS
    const useHttps = this.sslCertPath && this.sslKeyPath;

    if (useHttps) {
      if (!existsSync(this.sslCertPath!) || !existsSync(this.sslKeyPath!)) {
        throw new Error('SSL certificate or key file not found');
      }

      logger.info('Starting HTTPS server', { port: this.port });

      const options = {
        cert: readFileSync(this.sslCertPath!),
        key: readFileSync(this.sslKeyPath!),
      };

      this.server = https.createServer(options, this.app);
    } else {
      logger.warn('Starting HTTP server (no SSL certificates provided)', { port: this.port });
      this.server = http.createServer(this.app);
    }

    return new Promise((resolve) => {
      this.server!.listen(this.port, () => {
        logger.info(`Gateway server listening on port ${this.port}`, {
          protocol: useHttps ? 'https' : 'http',
        });
        resolve();
      });
    });
  }

  /**
   * Stop the server
   */
  async stop(): Promise<void> {
    if (!this.server) return;

    return new Promise((resolve, reject) => {
      this.server!.close((err) => {
        if (err) {
          logger.error('Error stopping server', { error: err.message });
          reject(err);
        } else {
          logger.info('Server stopped');
          resolve();
        }
      });
    });
  }
}
