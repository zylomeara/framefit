import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import { createLogger } from '../../src/infrastructure/logger.js';

function collectLogger(level = 'info') {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  const logger = createLogger({ level, destination: stream });
  return { logger, lines };
}

describe('logger redaction', () => {
  it('redacts known token fields', () => {
    const { logger, lines } = collectLogger();
    logger.info(
      {
        token: 'figd_SECRET',
        figma_token: 'figd_SECRET',
        authorization: 'Bearer figd_SECRET',
        headers: { 'x-figma-token': 'figd_SECRET' },
      },
      'request',
    );

    const out = lines.join('');
    expect(out).not.toContain('figd_SECRET');
    expect(out).toContain('[Redacted]');
  });

  it('keeps non-sensitive fields visible', () => {
    const { logger, lines } = collectLogger();
    logger.info({ tool: 'get_comments', file_key_prefix: 'ABC12345' }, 'call');
    const out = lines.join('');
    expect(out).toContain('get_comments');
    expect(out).toContain('ABC12345');
  });
});
