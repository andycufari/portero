/**
 * Anonymizer - Bidirectional data replacement for privacy
 * Replaces fake data with real data in requests, and vice versa in responses
 */

import type { Replacement } from '../config/types.js';
import logger from '../utils/logger.js';

type Direction = 'toReal' | 'toFake';

export class Anonymizer {
  constructor(private replacements: Replacement[]) {
    logger.info('Anonymizer initialized', { replacementCount: replacements.length });
  }

  /**
   * Anonymize a request (fake → real)
   * Called before sending data to MCPs
   */
  anonymizeRequest(data: any): any {
    logger.debug('Anonymizing request (fake → real)');
    return this.deepTraverse(data, (value) => this.replaceInValue(value, 'toReal'));
  }

  /**
   * Deanonymize a response (real → fake)
   * Called before returning data to Claude
   */
  deanonymizeResponse(data: any): any {
    logger.debug('Deanonymizing response (real → fake)');
    return this.deepTraverse(data, (value) => this.replaceInValue(value, 'toFake'));
  }

  /**
   * Replace strings in a value based on direction
   */
  private replaceInValue(value: string, direction: Direction): string {
    let result = value;

    for (const replacement of this.replacements) {
      // Determine source and target based on direction
      let source: string;
      let target: string;

      if (direction === 'toReal') {
        source = replacement.fake;
        target = replacement.real;
      } else {
        // For toFake direction
        if (!replacement.bidirectional) {
          // Use responseReplacement if specified, otherwise use real value
          source = replacement.real;
          target = replacement.responseReplacement || '***REDACTED***';
        } else {
          source = replacement.real;
          target = replacement.fake;
        }
      }

      // Perform replacement
      const caseSensitive = replacement.caseSensitive !== false; // Default to true

      if (caseSensitive) {
        // Case-sensitive replacement
        result = result.split(source).join(target);
      } else {
        // Case-insensitive replacement
        const regex = new RegExp(this.escapeRegExp(source), 'gi');
        result = result.replace(regex, target);
      }
    }

    return result;
  }

  /**
   * Recursively traverse an object/array and apply replacements
   */
  private deepTraverse(obj: any, replacer: (str: string) => string): any {
    if (typeof obj === 'string') {
      return replacer(obj);
    }

    if (Array.isArray(obj)) {
      return obj.map((item) => this.deepTraverse(item, replacer));
    }

    if (obj !== null && typeof obj === 'object') {
      const result: any = {};
      for (const [key, value] of Object.entries(obj)) {
        // Also apply replacements to keys
        const newKey = typeof key === 'string' ? replacer(key) : key;
        result[newKey] = this.deepTraverse(value, replacer);
      }
      return result;
    }

    return obj;
  }

  /**
   * Escape special regex characters
   */
  private escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Get replacement statistics
   */
  getStats(): { count: number; bidirectional: number; oneWay: number } {
    return {
      count: this.replacements.length,
      bidirectional: this.replacements.filter((r) => r.bidirectional).length,
      oneWay: this.replacements.filter((r) => !r.bidirectional).length,
    };
  }
}
