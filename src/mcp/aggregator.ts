/**
 * Aggregator - Merges tools and resources from all connected MCPs
 * Supports smart tool visibility via pinned tools and recently-used tracking.
 */

import type { MCPClientManager } from './client-manager.js';
import type { MCPConfig } from '../config/types.js';
import logger from '../utils/logger.js';

export interface Tool {
  name: string;
  description?: string;
  inputSchema: {
    type: string;
    properties?: Record<string, any>;
    required?: string[];
  };
}

export interface Resource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export class Aggregator {
  private toolsCache: Tool[] | null = null;
  private resourcesCache: Resource[] | null = null;
  private cacheTimestamp: number = 0;
  private cacheTTL: number = 60000; // 1 minute
  private pinnedToolsByMCP: Map<string, string[] | undefined> = new Map();
  private recentlyUsed: Set<string> = new Set();

  constructor(private clientManager: MCPClientManager, mcpConfigs?: MCPConfig[]) {
    if (mcpConfigs) {
      for (const config of mcpConfigs) {
        this.pinnedToolsByMCP.set(config.name, config.pinnedTools);
      }
    }
  }

  /**
   * Mark a tool as recently used so it appears in filtered tools/list
   */
  markUsed(toolName: string): void {
    this.recentlyUsed.add(toolName);
    logger.debug('Tool marked as recently used', { toolName });
  }

  /**
   * List all tools from all connected MCPs (unfiltered).
   * Used internally by search_tools and for cache population.
   */
  async listAllToolsUnfiltered(refresh: boolean = false): Promise<Tool[]> {
    // Return cached tools if available and not expired
    if (!refresh && this.toolsCache && Date.now() - this.cacheTimestamp < this.cacheTTL) {
      return this.toolsCache;
    }

    logger.info('Aggregating tools from all MCPs');

    const allTools: Tool[] = [];
    const clients = this.clientManager.getAllClients();

    for (const [mcpName, client] of clients) {
      try {
        const response = await client.listTools();

        if (response.tools) {
          for (const tool of response.tools) {
            // Prefix tool name with MCP name
            const namespacedTool: Tool = {
              ...tool,
              name: `${mcpName}/${tool.name}`,
              description: tool.description || `[${mcpName}] ${tool.name}`,
            };
            allTools.push(namespacedTool);
          }

          logger.debug('Listed tools from MCP', {
            mcpName,
            count: response.tools.length,
          });
        }
      } catch (error) {
        logger.error('Failed to list tools from MCP', {
          mcpName,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logger.info('Aggregated tools', { totalCount: allTools.length });

    // Update cache
    this.toolsCache = allTools;
    this.cacheTimestamp = Date.now();

    return allTools;
  }

  /**
   * List visible tools based on pinned config and recently-used tracking.
   * MCPs without pinnedTools show all their tools (backward compatible).
   * MCPs with pinnedTools only show those + any recently used from that MCP.
   */
  async listAllTools(refresh: boolean = false): Promise<Tool[]> {
    const allTools = await this.listAllToolsUnfiltered(refresh);

    // If no MCP has pinnedTools configured, return everything (fully backward compatible)
    const hasPinning = Array.from(this.pinnedToolsByMCP.values()).some(pins => pins !== undefined);
    if (!hasPinning) {
      return allTools;
    }

    return allTools.filter(tool => {
      const slashIdx = tool.name.indexOf('/');
      if (slashIdx === -1) return true;

      const mcpName = tool.name.substring(0, slashIdx);
      const localName = tool.name.substring(slashIdx + 1);

      const pinnedTools = this.pinnedToolsByMCP.get(mcpName);

      // No pinnedTools config for this MCP → show all its tools
      if (pinnedTools === undefined) {
        return true;
      }

      // Show if pinned
      if (pinnedTools.includes(localName)) {
        return true;
      }

      // Show if recently used
      if (this.recentlyUsed.has(tool.name)) {
        return true;
      }

      return false;
    });
  }

  /**
   * List all resources from all connected MCPs with namespace prefixes
   */
  async listAllResources(refresh: boolean = false): Promise<Resource[]> {
    // Return cached resources if available and not expired
    if (!refresh && this.resourcesCache && Date.now() - this.cacheTimestamp < this.cacheTTL) {
      return this.resourcesCache;
    }

    logger.info('Aggregating resources from all MCPs');

    const allResources: Resource[] = [];
    const clients = this.clientManager.getAllClients();

    for (const [mcpName, client] of clients) {
      try {
        const response = await client.listResources();

        if (response.resources) {
          for (const resource of response.resources) {
            // Prefix resource URI with MCP name
            const namespacedResource: Resource = {
              ...resource,
              uri: `${mcpName}://${resource.uri}`,
              name: `[${mcpName}] ${resource.name}`,
            };
            allResources.push(namespacedResource);
          }

          logger.debug('Listed resources from MCP', {
            mcpName,
            count: response.resources.length,
          });
        }
      } catch (error) {
        logger.error('Failed to list resources from MCP', {
          mcpName,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logger.info('Aggregated resources', { totalCount: allResources.length });

    // Update cache
    this.resourcesCache = allResources;
    this.cacheTimestamp = Date.now();

    return allResources;
  }

  /**
   * Invalidate the cache
   */
  invalidateCache(): void {
    this.toolsCache = null;
    this.resourcesCache = null;
    this.cacheTimestamp = 0;
    logger.debug('Cache invalidated');
  }
}
