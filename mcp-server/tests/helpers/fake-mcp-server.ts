import { vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * One content-block type for every tool in this server, mirroring shared-error-handler's
 * TextContent | ImageContent.
 *
 * It has to be a union: get_screenshot and get_pin_detail return image blocks, which the previous
 * text-only declaration excluded outright. The worse half of that declaration was that
 * `const t: string = res.content[0].text` compiled clean while being `undefined` at runtime on an
 * image block - a test could assert over a value the type system had promised was a string.
 *
 * Each member declares the other member's fields as optional-`undefined`, so an UN-NARROWED
 * `content[0].text` still compiles - as `string | undefined`, which is the truth - rather than
 * erroring outright on the union. That keeps every existing consumer source-compatible while
 * removing the false green: assigning it to a bare `string`, or handing it to `JSON.parse`, is now
 * a type error until the caller narrows. `content.find((c) => c.type === 'image')` narrows
 * normally, and so does `if (c.type === 'text')`.
 */
export type ToolTextContent = { type: 'text'; text: string; data?: undefined; mimeType?: undefined };
export type ToolImageContent = { type: 'image'; data: string; mimeType: string; text?: undefined };
export type ToolContent = ToolTextContent | ToolImageContent;
export type ToolResult = { content: ToolContent[]; isError?: boolean };

export type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

/**
 * The text of a content block as a `string` - the accessor the widened union makes callers go
 * through. It exists so a test that reaches for `.text` on an image block (or on an index that
 * holds nothing) fails at the assertion site with a sentence naming the problem, instead of
 * silently comparing against `undefined`, which is what the old text-only handler type allowed.
 */
export function textOf(block: ToolContent | undefined): string {
  if (block === undefined) throw new Error('textOf: no content block at that index');
  if (block.type !== 'text') throw new Error(`textOf: content block is "${block.type}", not text`);
  return block.text;
}

export type Registration = {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: Record<string, unknown>;
  handler: ToolHandler;
  /**
   * Absolute paths of every project module on the registration call stack, innermost first -
   * the full synchronous path from the `registerTool` call site down to whatever drove the
   * registration. It exists so a checker can ask WHERE a tool was registered without matching
   * source text - a regex over a directory answers "is there a file here spelled the way I
   * expect", and both the quoting of the name and the location of the file turned out to be
   * spellable around. The whole PATH is recorded rather than the top frame alone because the
   * top frame answers "where was registerTool called", which stops being "where does this
   * tool's code live" the moment a shared helper sits between the tool and the SDK: a tool
   * registered through a five-line helper was attributed to the helper, and the module holding
   * its handler was inspected by no check at all (measured 2026-07-28, review round 3).
   */
  sites?: string[];
};

const helperFile = fileURLToPath(import.meta.url);

/**
 * Every stack frame that is neither this helper, nor a runtime internal, nor a dependency,
 * innermost first, consecutive duplicates collapsed. `vi.fn()` wraps each registration entry
 * point, so @vitest/spy sits between the caller and here; skipping node_modules is what makes
 * the frames the CALLING modules rather than the spy.
 *
 * The stack-trace limit is raised for the capture: V8's default of 10 frames is enough for the
 * top frame but can cut the stack off before the driver, and the checks in
 * tool-annotations.test.ts need the whole registration path to tell a tool's own modules from
 * the shared driver's.
 *
 * node_modules is matched as a PATH SEGMENT, not a substring: a checkout living under a
 * directory whose name merely contains the text (".../node_modules_probe/repo") used to have
 * every frame skipped, making the annotations file unrunnable with a diagnostic that never
 * named the cause.
 */
function callerSites(): string[] {
  const savedLimit = Error.stackTraceLimit;
  Error.stackTraceLimit = 64;
  const stack = new Error().stack ?? '';
  Error.stackTraceLimit = savedLimit;
  const out: string[] = [];
  for (const line of stack.split('\n').slice(1)) {
    const m = /\((.*):\d+:\d+\)\s*$/.exec(line) ?? /\bat\s+(.*):\d+:\d+\s*$/.exec(line);
    if (!m) continue;
    const file = m[1].startsWith('file://') ? fileURLToPath(m[1]) : m[1];
    if (file.startsWith('node:') || file === helperFile) continue;
    if (file.split(/[\\/]/).includes('node_modules')) continue;
    if (out[out.length - 1] !== file) out.push(file);
  }
  return out;
}

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
        sites: callerSites(),
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
        sites: callerSites(),
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
