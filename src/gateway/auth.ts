/**
 * Authentication middleware for Express
 */

import type { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger.js';

/**
 * Bearer token authentication middleware
 */
export function bearerAuthMiddleware(expectedToken: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      logger.warn('Missing Authorization header', { ip: req.ip });
      res.status(401).json({ error: 'Unauthorized: Missing Authorization header' });
      return;
    }

    const match = authHeader.match(/^Bearer (.+)$/);

    if (!match) {
      logger.warn('Invalid Authorization header format', { ip: req.ip });
      res.status(401).json({ error: 'Unauthorized: Invalid Authorization header format' });
      return;
    }

    const token = match[1];

    if (token !== expectedToken) {
      logger.warn('Invalid bearer token', { ip: req.ip });
      res.status(401).json({ error: 'Unauthorized: Invalid token' });
      return;
    }

    next();
  };
}
