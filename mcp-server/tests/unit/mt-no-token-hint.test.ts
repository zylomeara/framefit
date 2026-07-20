import { describe, it, expect } from 'vitest';
import { runTool } from '../../src/adapters/driving/tools/shared-error-handler.js';
import { createLogger } from '../../src/infrastructure/logger.js';

const logger = createLogger({ level: 'silent' });

describe('runTool noTokenHint', () => {
  it('keeps the single-tenant message by default', async () => {
    const out = await runTool('t', logger, undefined, async () => ({ content: [] }));
    expect(out.isError).toBe(true);
    expect((out.content[0] as { text: string }).text).toContain('FIGMA_TOKEN env var');
  });

  it('uses the multi-tenant hint when provided', async () => {
    const out = await runTool('t', logger, undefined, async () => ({ content: [] }),
      'Add your Figma token in the portal: https://figma.mcp.example.com/portal');
    expect((out.content[0] as { text: string }).text).toContain('portal');
    expect((out.content[0] as { text: string }).text).not.toContain('FIGMA_TOKEN env var');
  });
});
