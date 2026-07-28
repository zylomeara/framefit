import { vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export type ToolHandler = (args: Record<string, unknown>) =>
  Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;

export type Registration = {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: Record<string, unknown>;
  handler: ToolHandler;
};

/**
 * ONE fake McpServer for every tool test.
 *
 * It accepts BOTH registration shapes - the deprecated positional
 * `tool(name, description, schema, [annotations,] cb)` and the current
 * `registerTool(name, {description, inputSchema, annotations}, cb)` - because every fake in this
 * suite is cast `as unknown as McpServer`, and that cast erases arity: the compiler cannot tell a
 * stub built for the wrong overload from a correct one, so the mismatch lands at runtime as
 * "Tool X not registered". Taking the handler as the LAST argument makes the fake indifferent to
 * which overload the production code picks.
 */
export function makeFakeMcpServer() {
  const registrations = new Map<string, Registration>();

  const server = {
    tool: vi.fn((name: string, ...rest: unknown[]) => {
      registrations.set(name, {
        name,
        description: typeof rest[0] === 'string' ? rest[0] : undefined,
        inputSchema: typeof rest[0] === 'string' ? rest[1] : rest[0],
        handler: rest[rest.length - 1] as ToolHandler,
      });
    }),
    registerTool: vi.fn((
      name: string,
      config: { description?: string; inputSchema?: unknown; annotations?: Record<string, unknown> },
      cb: ToolHandler,
    ) => {
      registrations.set(name, {
        name,
        description: config.description,
        inputSchema: config.inputSchema,
        annotations: config.annotations,
        handler: cb,
      });
    }),
  } as unknown as McpServer;

  const get = (name: string): Registration | undefined => registrations.get(name);

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = registrations.get(name);
    if (!r) {
      throw new Error(
        `Tool ${name} not registered (registered: ${[...registrations.keys()].join(', ') || 'none'})`,
      );
    }
    return r.handler(args);
  };

  return { server, call, get, registrations };
}
