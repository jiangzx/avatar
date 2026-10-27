import { describe, expect, it } from 'vitest';
import { parseDiagInput } from '../src/diag.ts';

const SID = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';

describe('parseDiagInput', () => {
  it('finds the session id in a pasted diagnostic code, with or without the owner id', () => {
    expect(parseDiagInput(` ${SID} `)).toEqual({ kind: 'session', sid: SID, oid: null });
    expect(parseDiagInput(`${SID}-3f9a1c2b4d5e`)).toEqual({ kind: 'session', sid: SID, oid: '3f9a1c2b4d5e' });
    expect(parseDiagInput(`诊断编号：${SID.toUpperCase()} / 3F9A1C2B4D5E`)).toEqual({ kind: 'session', sid: SID, oid: '3f9a1c2b4d5e' });
  });

  it('accepts a bare owner id', () => {
    expect(parseDiagInput('3f9a1c2b4d5e')).toEqual({ kind: 'owner', oid: '3f9a1c2b4d5e' });
  });

  it('rejects anything else', () => {
    expect(parseDiagInput('')).toEqual({ kind: 'invalid' });
    expect(parseDiagInput('hello')).toEqual({ kind: 'invalid' });
    expect(parseDiagInput('3f9a1c2b4d5e7')).toEqual({ kind: 'invalid' });
  });
});
