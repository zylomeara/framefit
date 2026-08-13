// The ONE version literal in the source tree (package.json holds the other; the stdio-smoke gate
// locks them together against the BUILT artifact). Deliberately a leaf: server.ts and the operator
// CLI both import it, and pulling server.ts into the CLI would drag express (server.ts:1) and all
// 26 tool registrations (server.ts:9) into every `framefit <command>` run.
export const VERSION = '0.28.0';
export const SERVER_INFO = { name: 'framefit', version: VERSION } as const;
