/**
 * Shared Pino logger for the scrape/ engine modules. Centralized here so
 * every split module logs through one configured instance instead of each
 * re-creating its own. Level comes from the validated LOG_LEVEL env var.
 */
import pino from 'pino';
import { LOG_LEVEL } from './config.js';

export const logger = pino({ level: LOG_LEVEL });
