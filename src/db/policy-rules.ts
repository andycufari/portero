/**
 * Policy rules store (file-backed)
 */

import { v4 as uuidv4 } from 'uuid';
import type { StoragePaths } from '../storage/paths.js';
import { readJsonFile, writeJsonFileAtomic } from '../storage/file-store.js';
import type { PolicyAction } from '../config/types.js';
import logger from '../utils/logger.js';

export interface PolicyRule {
  id: string;
  pattern: string;
  action: PolicyAction;
  createdAt: Date;
}

type RulesFile = {
  rules: Array<{ id: string; pattern: string; action: PolicyAction; createdAt: string }>;
};

export type ResolvedPolicyRule = {
  action: PolicyAction;
  rule: { id: string; pattern: string };
};

export class PolicyRulesDB {
  constructor(private paths: StoragePaths) {}

  async upsert(pattern: string, action: PolicyAction): Promise<PolicyRule> {
    const data = await readJsonFile<RulesFile>(this.paths.rulesJson, { rules: [] });
    const existing = data.rules.find((r) => r.pattern === pattern);
    const now = new Date();

    if (existing) {
      existing.action = action;
      await writeJsonFileAtomic(this.paths.rulesJson, data);
      logger.info('Updated policy rule', { id: existing.id, pattern, action });
      return { id: existing.id, pattern, action, createdAt: new Date(existing.createdAt) };
    }

    const id = uuidv4();
    data.rules.unshift({ id, pattern, action, createdAt: now.toISOString() });
    await writeJsonFileAtomic(this.paths.rulesJson, data);
    logger.info('Created policy rule', { id, pattern, action });

    return { id, pattern, action, createdAt: now };
  }

  async remove(id: string): Promise<boolean> {
    const data = await readJsonFile<RulesFile>(this.paths.rulesJson, { rules: [] });
    const before = data.rules.length;
    data.rules = data.rules.filter((r) => r.id !== id);
    await writeJsonFileAtomic(this.paths.rulesJson, data);
    const found = before !== data.rules.length;
    logger.info('Removed policy rule', { id, found });
    return found;
  }

  async list(): Promise<PolicyRule[]> {
    const data = await readJsonFile<RulesFile>(this.paths.rulesJson, { rules: [] });
    return data.rules.map((r) => ({ id: r.id, pattern: r.pattern, action: r.action, createdAt: new Date(r.createdAt) }));
  }

  async resolve(toolName: string): Promise<PolicyAction | null> {
    const resolved = await this.resolveDetailed(toolName);
    return resolved ? resolved.action : null;
  }

  async resolveDetailed(toolName: string): Promise<ResolvedPolicyRule | null> {
    const data = await readJsonFile<RulesFile>(this.paths.rulesJson, { rules: [] });

    // Exact first
    const exact = data.rules.find((r) => r.pattern === toolName);
    if (exact) return { action: exact.action, rule: { id: exact.id, pattern: exact.pattern } };

    for (const rule of data.rules) {
      if (matchesPattern(toolName, rule.pattern)) {
        return { action: rule.action, rule: { id: rule.id, pattern: rule.pattern } };
      }
    }

    return null;
  }
}

function matchesPattern(toolName: string, pattern: string): boolean {
  if (pattern === '*') return true;

  let regexPattern = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '__DOUBLE_WILDCARD__')
    .replace(/\*/g, '[^/]*')
    .replace(/__DOUBLE_WILDCARD__/g, '.*');

  regexPattern = `^${regexPattern}$`;
  return new RegExp(regexPattern).test(toolName);
}
