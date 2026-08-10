import type { Logger } from '../../../infrastructure/logger.js';
import { FigmaApiError } from '../../../ports/errors.js';
import { serializeForDelivery } from './serialize.js';

type TextContent = { type: 'text'; text: string };
type ImageContent = { type: 'image'; data: string; mimeType: string };
type ToolResult = { content: (TextContent | ImageContent)[]; isError?: boolean };

export type ReadOnlyGate = {
  isReadOnly: () => Promise<boolean>;
  /**
   * The next step THIS deployment's reader can actually take. Carried on the gate rather than
   * hard-coded in the refusal because the two modes have different answers: the portal sentence is
   * true only in multi-tenant - the admin portal UI is not in this repository (docs/deployment.md,
   * docker/README.md), so a single-tenant refusal pointing at it would end at software the reader
   * cannot obtain.
   */
  remediation: string;
};

export const PORTAL_READ_ONLY_REMEDIATION =
  'Uncheck "Read only" on the Figma tokens page of your framefit portal, then try again.';

export const SINGLE_TENANT_READ_ONLY_REMEDIATION =
  'Unset FRAMEFIT_READ_ONLY (or set it to false) in the server environment and restart, then try again.';

/**
 * Returns a polite refusal ToolResult when this connection is in read-only mode, else null
 * (caller proceeds). An absent gate means no read-only mode was configured at all, so writes are
 * allowed - which is what an unset FRAMEFIT_READ_ONLY, and every pre-existing single-tenant
 * deployment, gets.
 */
export async function assertWritable(gate: ReadOnlyGate | undefined): Promise<ToolResult | null> {
  if (!gate) return null;
  if (!(await gate.isReadOnly())) return null;
  return {
    isError: true,
    content: [{
      type: 'text',
      text: 'This MCP connection is in read-only mode, so write actions (comments) are disabled. '
        + gate.remediation,
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

// compare_dom_to_dom makes ZERO Figma calls - no token gate, same uniform error surface.
export async function runTokenlessTool(
  toolName: string, logger: Logger, fn: () => Promise<ToolResult>,
): Promise<ToolResult> {
  try {
    return await fn();
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
