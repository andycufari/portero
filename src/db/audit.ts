/**
 * Audit log store (file-backed, NDJSON append)
 */

import type { StoragePaths } from '../storage/paths.js';
import { appendNdjson } from '../storage/file-store.js';

export interface AuditLogEntry {
  timestamp: Date;
  toolName: string;
  args: any;
  result: any;
  policyAction: string | null;
  approvalStatus: string | null;
  error: string | null;
}

export class AuditDB {
  constructor(private paths: StoragePaths) {}

  async log(entry: {
    toolName: string;
    args: any;
    result?: any;
    policyAction?: string;
    approvalStatus?: string;
    error?: string;
  }): Promise<void> {
    const row = {
      timestamp: new Date().toISOString(),
      toolName: entry.toolName,
      args: entry.args,
      result: entry.result ?? null,
      policyAction: entry.policyAction ?? null,
      approvalStatus: entry.approvalStatus ?? null,
      error: entry.error ?? null,
    };

    await appendNdjson(this.paths.auditNdjson, row);
  }

  // Minimal stats for /status
  async getStats(): Promise<{ total: number; errors: number; approved: number; denied: number }> {
    // For now, avoid scanning the file (could get large). Return zeros.
    // We can implement sampling/rolling counters later.
    return { total: 0, errors: 0, approved: 0, denied: 0 };
  }

  async getRecent(_limit: number = 10): Promise<AuditLogEntry[]> {
    // Keep it simple for now.
    return [];
  }
}
