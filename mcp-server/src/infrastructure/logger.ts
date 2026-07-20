import pino, { type Logger, type DestinationStream } from 'pino';

export type CreateLoggerOptions = {
  level?: string;
  destination?: DestinationStream;
};

export function createLogger(opts: CreateLoggerOptions = {}): Logger {
  return pino(
    {
      level: opts.level ?? 'info',
      redact: {
        paths: [
          'token',
          'figma_token',
          'authorization',
          'headers.authorization',
          'headers["x-figma-token"]',
          'headers["X-Figma-Token"]',
          '*.token',
          '*.figma_token',
          '*.authorization',
          'pat',
          '*.pat',
          'encrypted_pat',
          '*.encrypted_pat',
          'bearer',
          '*.bearer',
        ],
        censor: '[Redacted]',
      },
    },
    opts.destination,
  );
}

export type { Logger };
