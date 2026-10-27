const SESSION_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const OWNER_ID = /(?<![0-9a-f])[0-9a-f]{12}(?![0-9a-f])/;

export type DiagTarget = { kind: 'session'; sid: string; oid: string | null } | { kind: 'owner'; oid: string } | { kind: 'invalid' };

/** Reads what an admin pastes from the phone: a session UUID, optionally with the owner short id. */
export function parseDiagInput(raw: string): DiagTarget {
  const text = raw.trim().toLowerCase();
  const sid = SESSION_ID.exec(text)?.[0];
  if (sid) {
    const rest = text.replace(sid, ' ');
    return { kind: 'session', sid, oid: OWNER_ID.exec(rest)?.[0] ?? null };
  }
  const oid = OWNER_ID.exec(text)?.[0];
  return oid ? { kind: 'owner', oid } : { kind: 'invalid' };
}
