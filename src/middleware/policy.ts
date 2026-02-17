/**
 * Policy Engine - Check tool permissions against configured policies
 */

import type { PolicyAction } from '../config/types.js';
import type { PolicyRulesDB } from '../db/policy-rules.js';
import logger from '../utils/logger.js';

export class PolicyEngine {
  private policies: Record<string, PolicyAction>;
  private defaultPolicy: PolicyAction;

  constructor(
    policies: Record<string, PolicyAction>,
    defaultPolicy: PolicyAction = 'allow',
    private policyRulesDB?: PolicyRulesDB
  ) {
    this.policies = policies;
    this.defaultPolicy = defaultPolicy;
    logger.info('PolicyEngine initialized', {
      policyCount: Object.keys(policies).length,
      defaultPolicy,
      hasPolicyRulesDb: Boolean(policyRulesDB),
    });
  }

  /**
   * Check the policy for a given tool name
   */
  async checkPolicy(toolName: string): Promise<PolicyAction> {
    const detailed = await this.checkPolicyDetailed(toolName);
    return detailed.action;
  }

  async checkPolicyDetailed(
    toolName: string
  ): Promise<{ action: PolicyAction; source: 'db-rule' | 'config-exact' | 'config-pattern' | 'default'; pattern?: string; ruleId?: string }> {
    logger.debug('Checking policy', { toolName });

    // 0) Telegram-managed persistent rules (DB) take precedence
    if (this.policyRulesDB) {
      const resolved = await this.policyRulesDB.resolveDetailed(toolName);
      if (resolved) {
        logger.debug('Policy matched (db-rule)', { toolName, action: resolved.action, pattern: resolved.rule.pattern });
        return { action: resolved.action, source: 'db-rule', pattern: resolved.rule.pattern, ruleId: resolved.rule.id };
      }
    }

    // 1) Static config policies
    // Try exact match first
    if (this.policies[toolName]) {
      const action = this.policies[toolName];
      logger.debug('Policy matched (exact)', { toolName, action });
      return { action, source: 'config-exact', pattern: toolName };
    }

    // Try pattern matching (wildcards)
    for (const [pattern, action] of Object.entries(this.policies)) {
      if (this.matchesPattern(toolName, pattern)) {
        logger.debug('Policy matched (pattern)', { toolName, pattern, action });
        return { action, source: 'config-pattern', pattern };
      }
    }

    // Return default policy
    logger.debug('Policy matched (default)', { toolName, action: this.defaultPolicy });
    return { action: this.defaultPolicy, source: 'default' };
  }

  /**
   * Check if a tool name matches a pattern
   * Supports wildcards: * and **
   * Examples:
   *   - "github/*" matches "github/create_issue"
   *   - "* /delete_*" matches "filesystem/delete_file", "github/delete_repo"
   *   - "*" matches everything
   */
  private matchesPattern(toolName: string, pattern: string): boolean {
    // Handle exact wildcard
    if (pattern === '*') {
      return true;
    }

    // Convert pattern to regex
    // Escape special regex characters except * and **
    let regexPattern = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // Escape special chars
      .replace(/\*\*/g, '__DOUBLE_WILDCARD__') // Temporarily replace **
      .replace(/\*/g, '[^/]*') // * matches anything except /
      .replace(/__DOUBLE_WILDCARD__/g, '.*'); // ** matches anything including /

    // Anchor the pattern
    regexPattern = `^${regexPattern}$`;

    const regex = new RegExp(regexPattern);
    return regex.test(toolName);
  }

  /**
   * Get all policies
   */
  getPolicies(): Record<string, PolicyAction> {
    return { ...this.policies };
  }

  /**
   * Update a policy
   */
  updatePolicy(toolName: string, action: PolicyAction): void {
    logger.info('Updating policy', { toolName, action });
    this.policies[toolName] = action;
  }

  /**
   * Remove a policy
   */
  removePolicy(toolName: string): void {
    logger.info('Removing policy', { toolName });
    delete this.policies[toolName];
  }

  /**
   * Get policy statistics
   */
  getStats(): { total: number; allow: number; deny: number; requireApproval: number } {
    const stats = {
      total: Object.keys(this.policies).length,
      allow: 0,
      deny: 0,
      requireApproval: 0,
    };

    for (const action of Object.values(this.policies)) {
      if (action === 'allow') stats.allow++;
      else if (action === 'deny') stats.deny++;
      else if (action === 'require-approval') stats.requireApproval++;
    }

    return stats;
  }
}
