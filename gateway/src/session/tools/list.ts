import { z } from 'zod';
import type { ListCopy } from '../../i18n/types.ts';
import { oneLine } from '../../memory/userText.ts';
import type { ToolContext, ToolHandler, ToolOutcome } from './registry.ts';

/** No arguments: what to read is decided by the server-side scope only. */
const ListSchema = z.object({}).strict();

export interface ListOptions {
  copy: ListCopy;
  /** gateway/config/memory.json listMaxItems. */
  maxItems: number;
}

/** Trailing sentence punctuation would double up with the joiner. */
function bare(text: string): string {
  return oneLine(text).replace(/[\s。．.!！?？；;，,、]+$/u, '');
}

/** Template only, never a text model: zero room for invented memories (spec 语音能力). */
export function listTool(options: ListOptions): ToolHandler {
  const { copy } = options;
  return {
    spec: {
      name: 'list_memory',
      description: copy.toolDescription,
      parameters: { type: 'object', properties: {} },
    },
    async handle(args: unknown, ctx: ToolContext): Promise<ToolOutcome> {
      if (!ListSchema.safeParse(args ?? {}).success) return { ok: false, error: 'invalid_args' };
      const { store, ownerId, agentId } = ctx;
      if (!store || !ownerId || !agentId) return { ok: false, error: 'memory_unavailable' };
      const pinned = store.listPinned(ownerId, agentId);
      const profile = store.listProfileFacts(ownerId).filter((row) => row.category === 'profile');
      const facts = store.listAgentFacts(ownerId, agentId);
      const candidates = [
        ...pinned.filter((row) => !row.sensitive).map((row) => row.text),
        ...profile.map((row) => row.text),
        ...facts.filter((row) => !row.sensitive).map((row) => row.text),
      ].map(bare).filter((text) => text.length > 0);
      const items = [...new Set(candidates)].slice(0, options.maxItems);
      // Health stays off the speaker (others in the room); the settings page shows it.
      const hasHealth = pinned.some((row) => row.sensitive) || facts.some((row) => row.category === 'health');
      if (items.length === 0) {
        return hasHealth
          ? { ok: true, spokenText: copy.sensitiveHint, spokenFound: true }
          : { ok: true, spokenText: copy.emptyText, spokenFound: false };
      }
      const body = `${copy.introText}${items.join(copy.itemJoiner)}${copy.itemEnd}${hasHealth ? copy.sensitiveHint : ''}`;
      return { ok: true, spokenText: body.trim(), spokenFound: true };
    },
  };
}
