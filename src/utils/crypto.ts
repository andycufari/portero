/**
 * Crypto utilities for token generation
 */

import { randomBytes } from 'crypto';

/**
 * Generate a random token
 */
export function generateToken(length: number = 32): string {
  return randomBytes(length).toString('hex');
}

/**
 * Generate a secure bearer token
 */
export function generateBearerToken(): string {
  return generateToken(32);
}
