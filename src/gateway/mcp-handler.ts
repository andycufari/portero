/**
 * MCP Handler - Main orchestrator for JSON-RPC requests
 * Coordinates the entire middleware pipeline
 */

import type { Aggregator, Tool } from '../mcp/aggregator.js';
import type { Router } from '../mcp/router.js';
import type { Anonymizer } from '../middleware/anonymizer.js';
import type { PolicyEngine } from '../middleware/policy.js';
import type { ApprovalGate } from '../middleware/approval.js';
import type { GrantsDB } from '../db/grants.js';
import type { AuditDB } from '../db/audit.js';
import type { TelegramBot } from '../telegram/bot.js';
import logger from '../utils/logger.js';

interface JSONRPCRequest {
  jsonrpc: string;
  id?: string | number | null;
  method: string;
  params?: any;
}

interface JSONRPCResponse {
  jsonrpc: string;
  id?: string | number | null;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

/** Virtual tool definitions injected by Portero */
const VIRTUAL_TOOLS: Tool[] = [
  {
    name: 'portero/search_tools',
    description:
      'Search available tools by keyword or category. Use this to discover tools before calling them.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search keyword (matches tool name and description)',
        },
        category: {
          type: 'string',
          description:
            'Filter by category: filesystem, google, gmail, calendar, drive',
        },
      },
    },
  },
  {
    name: 'portero/call',
    description:
      'Call any available tool by its full name. Use portero/search_tools first to discover tool names.',
    inputSchema: {
      type: 'object',
      properties: {
        tool: {
          type: 'string',
          description: "Full tool name, e.g. 'google/share_drive_file'",
        },
        args: {
          type: 'object',
          description: 'Arguments to pass to the tool',
        },
      },
      required: ['tool', 'args'],
    },
  },
];

/** Category keywords mapped from tool name prefixes and known subcategories */
const CATEGORY_KEYWORDS: Record<string, string[]> = {
  filesystem: ['filesystem'],
  google: ['google'],
  gmail: ['gmail', 'message', 'label', 'filter', 'thread'],
  calendar: ['calendar', 'event', 'freebusy'],
  drive: ['drive', 'file', 'folder', 'permission'],
  email: ['mail', 'message', 'send_email', 'gmail', 'send_gmail'],
};

export class MCPHandler {
  constructor(
    private aggregator: Aggregator,
    private router: Router,
    private anonymizer: Anonymizer,
    private policyEngine: PolicyEngine,
    private approvalGate: ApprovalGate,
    private grantsDB: GrantsDB,
    private auditDB: AuditDB,
    private telegramBot?: TelegramBot
  ) {}

  /**
   * Handle an incoming JSON-RPC request
   */
  async handleRequest(request: JSONRPCRequest): Promise<JSONRPCResponse> {
    logger.info('Handling JSON-RPC request', { method: request.method });

    try {
      let result: any;

      switch (request.method) {
        case 'initialize':
          result = await this.handleInitialize(request.params);
          break;

        case 'tools/list':
          result = await this.handleToolsList();
          break;

        case 'tools/call':
          result = await this.handleToolsCall(request.params);
          break;

        case 'resources/list':
          result = await this.handleResourcesList();
          break;

        case 'resources/read':
          result = await this.handleResourcesRead(request.params);
          break;

        case 'ping':
          result = {};
          break;

        // MCP clients may send lifecycle notifications after initialize.
        // These are JSON-RPC notifications (no id) and should not error.
        case 'notifications/initialized':
          result = {};
          break;

        default:
          throw new Error(`Unsupported method: ${request.method}`);
      }

      return {
        jsonrpc: '2.0',
        id: request.id,
        result,
      };
    } catch (error) {
      logger.error('Request handling failed', {
        method: request.method,
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : 'Internal error',
        },
      };
    }
  }

  /**
   * Handle initialize request
   */
  private async handleInitialize(params: any): Promise<any> {
    logger.info('Initializing MCP connection');

    return {
      protocolVersion: '2024-11-05',
      serverInfo: {
        name: 'portero',
        version: '1.0.0',
      },
      capabilities: {
        tools: {},
        resources: {},
      },
    };
  }

  /**
   * Handle tools/list request
   * Returns virtual tools + filtered (pinned + recently used) tools
   */
  private async handleToolsList(): Promise<any> {
    logger.info('Listing tools (filtered)');

    const filteredTools = await this.aggregator.listAllTools();

    // Combine virtual tools with filtered real tools
    const tools = [...VIRTUAL_TOOLS, ...filteredTools];

    logger.info('Returning tools', {
      virtual: VIRTUAL_TOOLS.length,
      real: filteredTools.length,
      total: tools.length,
    });

    return { tools };
  }

  /**
   * Handle tools/call request - THE MAIN PIPELINE
   */
  private async handleToolsCall(params: any): Promise<any> {
    const { name, arguments: args } = params;

    logger.info('Tool call requested', { name });

    // Handle virtual tools
    if (name === 'portero/search_tools') {
      return this.handleSearchTools(args);
    }
    if (name === 'portero/call') {
      return this.handlePorteroCall(args);
    }

    // Regular tool call — run through the pipeline and mark as used
    const result = await this.executeToolPipeline(name, args);
    this.aggregator.markUsed(name);
    return result;
  }

  /**
   * Handle portero/search_tools virtual tool
   */
  private async handleSearchTools(args: any): Promise<any> {
    const { query, category } = args || {};

    logger.info('search_tools called', { query, category });

    const allTools = await this.aggregator.listAllToolsUnfiltered();

    let results = allTools;

    // Filter by category
    if (category) {
      const lowerCat = category.toLowerCase();
      const keywords = CATEGORY_KEYWORDS[lowerCat] || [lowerCat];

      results = results.filter(tool => {
        const lowerName = tool.name.toLowerCase();
        const lowerDesc = (tool.description || '').toLowerCase();
        return keywords.some(kw => lowerName.includes(kw) || lowerDesc.includes(kw));
      });
    }

    // Filter by query
    if (query) {
      const lowerQuery = query.toLowerCase();
      results = results.filter(tool => {
        const lowerName = tool.name.toLowerCase();
        const lowerDesc = (tool.description || '').toLowerCase();
        return lowerName.includes(lowerQuery) || lowerDesc.includes(lowerQuery);
      });
    }

    const toolSummaries = results.map(t => ({
      name: t.name,
      description: t.description || '',
    }));

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            { count: toolSummaries.length, tools: toolSummaries },
            null,
            2
          ),
        },
      ],
    };
  }

  /**
   * Handle portero/call virtual tool — delegates to the full pipeline
   */
  private async handlePorteroCall(args: any): Promise<any> {
    const { tool, args: toolArgs } = args || {};

    if (!tool) {
      throw new Error('portero/call requires a "tool" parameter');
    }

    logger.info('portero/call delegating', { tool });

    const result = await this.executeToolPipeline(tool, toolArgs || {});
    this.aggregator.markUsed(tool);
    return result;
  }

  /**
   * The actual tool execution pipeline (policy, approval, routing, anonymization)
   */
  private async executeToolPipeline(name: string, args: any): Promise<any> {
    let policyAction: string = 'unknown';
    let approvalStatus: string | null = null;
    let hasGrant: boolean = false;
    let policySource: string | undefined;
    let policyPattern: string | undefined;
    let policyRuleId: string | undefined;

    try {
      // STEP 1: Anonymize request (fake → real)
      const realArgs = this.anonymizer.anonymizeRequest(args);
      logger.debug('Request anonymized', { name });

      // STEP 2: Check policy
      const policy = await this.policyEngine.checkPolicyDetailed(name);
      policyAction = policy.action;
      policySource = policy.source;
      policyPattern = policy.pattern;
      policyRuleId = policy.ruleId;
      logger.info('Policy checked', { name, policyAction, source: policySource, pattern: policyPattern });

      // STEP 3: Check for active grant (skip approval if granted)
      hasGrant = await this.grantsDB.hasActiveGrant(name);

      if (policyAction === 'deny') {
        throw new Error(`Tool ${name} is denied by policy`);
      }

      // STEP 4: Request approval if needed
      if (policyAction === 'require-approval' && !hasGrant) {
        logger.info('Approval required', { name });

        const approval = await this.approvalGate.requestApproval(name, realArgs);
        approvalStatus = approval;

        if (approval !== 'approved') {
          throw new Error(`Tool ${name} was ${approval}`);
        }

        logger.info('Tool approved', { name });
      }

      // STEP 5: Route to MCP
      logger.info('Routing to MCP', { name });
      const result = await this.router.callTool(name, realArgs);

      // STEP 6: Deanonymize response (real → fake)
      const fakeResult = this.anonymizer.deanonymizeResponse(result);
      logger.debug('Response deanonymized', { name });

      // Log successful call
      await this.auditDB.log({
        toolName: name,
        args: args, // Log fake args (anonymized)
        result: fakeResult,
        policyAction: policyAction as any,
        approvalStatus: approvalStatus || undefined,
      });

      // Notify execution (batched)
      await this.telegramBot?.enqueueExecutionNotice({
        status: 'ok',
        toolName: name,
        policyAction: policyAction as any,
        policySource: policySource,
        policyPattern: policyPattern,
        policyRuleId: policyRuleId,
        usedGrant: hasGrant,
        usedApproval: approvalStatus === 'approved',
        argsPreview: args,
        resultPreview: fakeResult,
      });

      return fakeResult;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Log failed call
      await this.auditDB.log({
        toolName: name,
        args: args, // Log fake args (anonymized)
        policyAction: policyAction as any,
        approvalStatus: approvalStatus || undefined,
        error: errorMessage,
      });

      await this.telegramBot?.enqueueExecutionNotice({
        status: policyAction === 'deny' ? 'blocked' : 'error',
        toolName: name,
        policyAction: policyAction as any,
        policySource,
        policyPattern,
        policyRuleId,
        usedGrant: hasGrant,
        usedApproval: approvalStatus === 'approved',
        argsPreview: args,
        error: errorMessage,
      });

      throw error;
    }
  }

  /**
   * Handle resources/list request
   */
  private async handleResourcesList(): Promise<any> {
    logger.info('Listing all resources');

    const resources = await this.aggregator.listAllResources();

    return { resources };
  }

  /**
   * Handle resources/read request
   */
  private async handleResourcesRead(params: any): Promise<any> {
    const { uri } = params;

    logger.info('Resource read requested', { uri });

    const result = await this.router.readResource(uri);

    return result;
  }
}
