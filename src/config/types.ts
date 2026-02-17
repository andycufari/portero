/**
 * Configuration type definitions for Portero
 */

export interface MCPConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  pinnedTools?: string[];
}

export interface MCPsConfig {
  mcps: MCPConfig[];
}

export interface Replacement {
  fake: string;
  real: string;
  bidirectional: boolean;
  caseSensitive?: boolean;
  responseReplacement?: string;
}

export interface ReplacementsConfig {
  replacements: Replacement[];
}

export type PolicyAction = 'allow' | 'deny' | 'require-approval';

export interface PoliciesConfig {
  policies: Record<string, PolicyAction>;
  defaultPolicy: PolicyAction;
}

export interface GatewayConfig {
  port: number;
  bearerToken: string;
  sslCertPath?: string;
  sslKeyPath?: string;
  approvalTimeoutSeconds: number;
}

export interface TelegramConfig {
  botToken: string;
  adminChatId?: string;
}
