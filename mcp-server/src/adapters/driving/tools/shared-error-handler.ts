import type { Logger } from '../../../infrastructure/logger.js';
import { FigmaApiError } from '../../../ports/errors.js';
import { serializeForDelivery } from './serialize.js';

type TextContent = { type: 'text'; text: string };
type ImageContent = { type: 'image'; data: string; mimeType: string };
type ToolResult = { content: (TextContent | ImageContent)[]; isError?: boolean };

export type ReadOnlyGate = { isReadOnly: () => Promise<boolean> };

/**
 * Returns a polite refusal ToolResult when the user is in read-only mode, else null
 * (caller proceeds). When gate is undefined (single-tenant/stdio) writes are always allowed.
 */
export async function assertWritable(gate: ReadOnlyGate | undefined): Promise<ToolResult | null> {
  if (!gate) return null;
  if (!(await gate.isReadOnly())) return null;
  return {
    isError: true,
    content: [{
      type: 'text',
      text: 'This MCP connection is in read-only mode, so write actions (comments) are disabled. ' +
        'Uncheck "Read only" on the Figma tokens page of your framefit portal, then try again.',
    }],
  };
}

// Resolve token, run fn, map errors to a tool result. Returns a ready MCP result.
export async function runTool(
  toolName: string,
  logger: Logger,
  token: string | undefined,
  fn: (token: string) => Promise<ToolResult>,
  noTokenHint?: string,
): Promise<ToolResult> {
  if (!token) {
    const hint = noTokenHint ?? 'Set FIGMA_TOKEN env var or pass figma_token parameter.';
    return {
      isError: true,
      content: [{ type: 'text', text: `No Figma token configured. ${hint}` }],
    };
  }
  try {
    return await fn(token);
  } catch (err) {
    logger.warn({ tool: toolName, error_kind: kindOf(err) }, 'tool.error');
    return { isError: true, content: [{ type: 'text', text: formatError(err) }] };
  }
}

export function jsonResult(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: serializeForDelivery(value) }] };
}

export function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

function formatError(err: unknown): string {
  if (err instanceof FigmaApiError) return `[${err.kind}] ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

function kindOf(err: unknown): string {
  if (err instanceof FigmaApiError) return err.kind;
  return 'validation';
}
