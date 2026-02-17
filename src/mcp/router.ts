/**
 * Router - Routes tool calls to the correct MCP client
 */

import type { MCPClientManager } from './client-manager.js';
import logger from '../utils/logger.js';

export class Router {
  constructor(private clientManager: MCPClientManager) {}

  /**
   * Parse a namespaced tool name into MCP name and tool name
   * Example: "github/create_issue" -> { mcpName: "github", toolName: "create_issue" }
   */
  private parseNamespace(namespacedName: string): { mcpName: string; toolName: string } {
    const parts = namespacedName.split('/');

    if (parts.length < 2) {
      throw new Error(`Invalid namespaced tool name: ${namespacedName}. Expected format: "mcp_name/tool_name"`);
    }

    const mcpName = parts[0];
    const toolName = parts.slice(1).join('/'); // Handle tool names with slashes

    return { mcpName, toolName };
  }

  /**
   * Call a tool on the appropriate MCP server
   */
  async callTool(namespacedName: string, args: any): Promise<any> {
    const { mcpName, toolName } = this.parseNamespace(namespacedName);

    logger.info('Routing tool call', {
      namespacedName,
      mcpName,
      toolName,
    });

    // Get the appropriate client
    const client = this.clientManager.getClient(mcpName);

    if (!client) {
      throw new Error(`MCP server "${mcpName}" is not connected`);
    }

    // Call the tool with the un-namespaced name
    try {
      const response = await client.callTool({
        name: toolName,
        arguments: args,
      });

      logger.info('Tool call succeeded', {
        namespacedName,
        mcpName,
        toolName,
      });

      return response;
    } catch (error) {
      logger.error('Tool call failed', {
        namespacedName,
        mcpName,
        toolName,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Read a resource from the appropriate MCP server
   */
  async readResource(namespacedUri: string): Promise<any> {
    // Parse URI format: "mcp_name://original_uri"
    const match = namespacedUri.match(/^([^:]+):\/\/(.+)$/);

    if (!match) {
      throw new Error(`Invalid namespaced resource URI: ${namespacedUri}. Expected format: "mcp_name://uri"`);
    }

    const mcpName = match[1];
    const originalUri = match[2];

    logger.info('Routing resource read', {
      namespacedUri,
      mcpName,
      originalUri,
    });

    // Get the appropriate client
    const client = this.clientManager.getClient(mcpName);

    if (!client) {
      throw new Error(`MCP server "${mcpName}" is not connected`);
    }

    // Read the resource with the original URI
    try {
      const response = await client.readResource({ uri: originalUri });

      logger.info('Resource read succeeded', {
        namespacedUri,
        mcpName,
        originalUri,
      });

      return response;
    } catch (error) {
      logger.error('Resource read failed', {
        namespacedUri,
        mcpName,
        originalUri,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
