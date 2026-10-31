const TOOL_SYNTAX_PREFIXES = ['[', '{', '```', '<tool', 'set_memory_consent('];

function startsWithToolSyntax(line: string): boolean {
  const leading = line.trimStart();
  return TOOL_SYNTAX_PREFIXES.some((prefix) => leading.startsWith(prefix));
}

/** Qwen can print a tool call as text instead of emitting a function call. Never treat that as speech. */
export function isTextualToolCall(text: string): boolean {
  return startsWithToolSyntax(text);
}

/** Keeps any normal lines before the first textual tool call; drops the call and everything after it. */
export function stripTextualToolCall(text: string): string {
  const lines = text.split('\n');
  const index = lines.findIndex(startsWithToolSyntax);
  return index === -1 ? text : lines.slice(0, index).join('\n').trimEnd();
}
