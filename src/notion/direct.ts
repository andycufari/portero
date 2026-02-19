/**
 * Notion Direct API client — bypasses the broken data_sources endpoint
 * in @notionhq/notion-mcp-server by calling Notion REST API directly.
 *
 * @see https://github.com/makenotion/notion-mcp-server/issues/185
 */

import logger from '../utils/logger.js';

const NOTION_API_BASE = 'https://api.notion.com';
const NOTION_VERSION = '2022-06-28';

export class NotionDirect {
  private headers: Record<string, string>;

  constructor(private token: string) {
    this.headers = {
      'Authorization': `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    };
  }

  /**
   * POST /v1/databases/{database_id}/query
   */
  async queryDatabase(databaseId: string, params: {
    filter?: any;
    sorts?: any[];
    start_cursor?: string;
    page_size?: number;
  } = {}): Promise<any> {
    const url = `${NOTION_API_BASE}/v1/databases/${databaseId}/query`;

    logger.info('Notion direct: querying database', { databaseId, url });

    const body: any = {};
    if (params.filter) body.filter = params.filter;
    if (params.sorts) body.sorts = params.sorts;
    if (params.start_cursor) body.start_cursor = params.start_cursor;
    if (params.page_size) body.page_size = params.page_size;

    const response = await fetch(url, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });

    const data = await response.json();

    if (!response.ok) {
      logger.error('Notion direct: query failed', {
        status: response.status,
        code: (data as any)?.code,
        message: (data as any)?.message,
      });
      throw new Error(`Notion API error ${response.status}: ${(data as any)?.message || response.statusText}`);
    }

    logger.info('Notion direct: query succeeded', {
      databaseId,
      resultCount: (data as any)?.results?.length ?? 0,
      hasMore: (data as any)?.has_more,
    });

    return data;
  }

  /**
   * GET /v1/databases/{database_id}
   */
  async retrieveDatabase(databaseId: string): Promise<any> {
    const url = `${NOTION_API_BASE}/v1/databases/${databaseId}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: this.headers,
    });

    const data = await response.json();

    if (!response.ok) {
      logger.error('Notion direct: retrieve failed', {
        status: response.status,
        code: (data as any)?.code,
        message: (data as any)?.message,
      });
      throw new Error(`Notion API error ${response.status}: ${(data as any)?.message || response.statusText}`);
    }

    return data;
  }
}
