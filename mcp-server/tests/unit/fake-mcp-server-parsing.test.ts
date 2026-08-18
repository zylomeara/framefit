import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { makeFakeMcpServer, textOf } from '../helpers/fake-mcp-server.js';

describe('makeFakeMcpServer callParsed', () => {
  it('applies registered Zod defaults before the handler runs', async () => {
    const { server, callParsed } = makeFakeMcpServer();
    server.registerTool('probe', {
      inputSchema: {
        depth: z.number().int().min(1).default(4),
      },
    }, async (args) => ({
      content: [{ type: 'text', text: JSON.stringify(args) }],
    }));

    const result = await callParsed('probe');

    expect(JSON.parse(textOf(result.content[0]))).toEqual({ depth: 4 });
  });

  it('rejects invalid arguments before the handler runs', async () => {
    const { server, callParsed } = makeFakeMcpServer();
    server.registerTool('probe', {
      inputSchema: {
        depth: z.number().int().min(1).default(4),
      },
    }, async () => {
      throw new Error('handler must not run');
    });

    await expect(callParsed('probe', { depth: 0 })).rejects.toBeInstanceOf(z.ZodError);
  });
});
