/**
 * Configuration loader - loads and validates JSON configs with environment variable substitution
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import type {
  MCPsConfig,
  ReplacementsConfig,
  PoliciesConfig,
  GatewayConfig,
  TelegramConfig
} from './types.js';

/**
 * Substitute environment variables in a string (e.g., "${GITHUB_TOKEN}" -> actual value)
 */
function substituteEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (match, varName) => {
    const envValue = process.env[varName];
    // Community-friendly: do not hard-fail on missing env vars.
    // Leave the placeholder as-is so downstream code can decide to skip/deny.
    if (envValue === undefined) return match;
    return envValue;
  });
}

/**
 * Recursively substitute environment variables in an object
 */
function substituteEnvVarsInObject<T>(obj: T): T {
  if (typeof obj === 'string') {
    return substituteEnvVars(obj) as T;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => substituteEnvVarsInObject(item)) as T;
  }

  if (obj !== null && typeof obj === 'object') {
    const result: any = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = substituteEnvVarsInObject(value);
    }
    return result;
  }

  return obj;
}

/**
 * Load and parse a JSON config file
 */
function loadJsonConfig<T>(filePath: string): T {
  const absolutePath = resolve(process.cwd(), filePath);
  const content = readFileSync(absolutePath, 'utf-8');
  const parsed = JSON.parse(content);
  return substituteEnvVarsInObject(parsed);
}

export function loadMCPsConfig(filePath: string = 'config/mcps.json'): MCPsConfig {
  return loadJsonConfig<MCPsConfig>(filePath);
}

export function loadReplacementsConfig(filePath: string = 'config/replacements.json'): ReplacementsConfig {
  return loadJsonConfig<ReplacementsConfig>(filePath);
}

export function loadPoliciesConfig(filePath: string = 'config/policies.json'): PoliciesConfig {
  return loadJsonConfig<PoliciesConfig>(filePath);
}

export function loadGatewayConfig(): GatewayConfig {
  return {
    port: parseInt(process.env.PORT || '8443', 10),
    bearerToken: process.env.BEARER_TOKEN || '',
    sslCertPath: process.env.SSL_CERT_PATH,
    sslKeyPath: process.env.SSL_KEY_PATH,
    approvalTimeoutSeconds: parseInt(process.env.APPROVAL_TIMEOUT_SECONDS || '300', 10),
  };
}

export function loadTelegramConfig(): TelegramConfig {
  return {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    adminChatId: process.env.TELEGRAM_ADMIN_CHAT_ID || undefined,
  };
}
