import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadRoleCatalog } from '../src/roles/fileCatalog.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixtures = `${root}test/fixtures/roles`;
const temps: string[] = [];

function copyFixtures(): string {
  const dir = mkdtempSync(join(tmpdir(), 'roles-'));
  temps.push(dir);
  cpSync(fixtures, dir, { recursive: true });
  return dir;
}

function patchRole(dir: string, patch: Record<string, unknown>): void {
  const base = { id: 'test-role', defaultStyle: 'plain', styles: { plain: { file: 'styles/plain.md', voice: null } }, activityIntro: 'A', activities: [] };
  writeFileSync(join(dir, 'test-role', 'role.json'), JSON.stringify({ ...base, ...patch }));
}

describe('FileRoleCatalog', () => {
  afterEach(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it('loads the fixture role with safety first and the activity directory last', () => {
    const roles = loadRoleCatalog(fixtures, 'test-role');
    expect(roles.defaultRole()).toBe('test-role');
    expect(roles.defaultStyle('test-role')).toBe('plain');
    expect(roles.hasStyle('test-role', 'second')).toBe(true);
    expect(roles.hasStyle('test-role', 'pirate')).toBe(false);
    expect(roles.hasStyle('other', 'plain')).toBe(false);
    expect(roles.voiceFor('test-role', 'plain')).toBeUndefined();
    expect(roles.voiceFor('test-role', 'second')).toBe('fixture-voice');
    expect(roles.buildPersona('test-role', 'second')).toBe('FIXTURE SAFETY RULES\n\nFIXTURE SECOND STYLE\n\nFIXTURE ACTIONS\n\n## FIXTURE ACTIVITIES\n- 活动一：第一个活动');
    expect(roles.activityText('test-role', 'one')).toBe('FIXTURE ACTIVITY ONE');
    expect(roles.pairs()).toEqual([{ roleId: 'test-role', styleId: 'plain' }, { roleId: 'test-role', styleId: 'second' }]);
    const d = roles.director('test-role');
    expect(d.topicInstruction).toBe('T {topic}');
    expect(d.topics).toEqual([{ id: 't1', prompt: '天气', fallbackText: '今天天气不错。' }]);
  });

  it('ships an elder-companion role with a grandchild default and an old-friend style', () => {
    const roles = loadRoleCatalog(`${root}roles`);
    expect(roles.defaultRole()).toBe('elder-companion');
    expect(roles.defaultStyle('elder-companion')).toBe('grandchild');
    const grandchild = roles.buildPersona('elder-companion', 'grandchild');
    expect(grandchild.indexOf('安全底线')).toBe(grandchild.indexOf('##') + 3);
    expect(grandchild.indexOf('安全底线')).toBeLessThan(grandchild.indexOf('孙辈'));
    expect(grandchild).toContain('perform_action');
    expect(roles.buildPersona('elder-companion', 'old-friend')).toContain('老朋友');
    expect(roles.director('elder-companion').topics?.length).toBeGreaterThanOrEqual(5);
  });

  it('rejects a role whose default style is not declared', () => {
    const dir = copyFixtures();
    patchRole(dir, { defaultStyle: 'missing' });
    expect(() => loadRoleCatalog(dir, 'test-role')).toThrow('default_style_missing:test-role');
  });

  it('rejects style paths that leave the role directory', () => {
    const dir = copyFixtures();
    patchRole(dir, { styles: { plain: { file: '../escape.md', voice: null } } });
    expect(() => loadRoleCatalog(dir, 'test-role')).toThrow();
  });

  it('rejects a missing style file and a missing shared safety file', () => {
    const a = copyFixtures();
    patchRole(a, { styles: { plain: { file: 'styles/nope.md', voice: null } } });
    expect(() => loadRoleCatalog(a, 'test-role')).toThrow();
    const b = copyFixtures();
    rmSync(join(b, '_shared', 'safety.md'));
    expect(() => loadRoleCatalog(b, 'test-role')).toThrow();
  });

  it('rejects a topic instruction without the {topic} placeholder', () => {
    const dir = copyFixtures();
    const director = { followupAfterMs: 8000, idleNoticeAfterMs: 25000, maxConsecutive: 2, maxPerWindow: 3, windowMs: 300000, quietPhrases: [], greetingInstruction: 'G', greetingText: 'g', followupInstruction: 'F', followupText: 'f', idleNoticeInstruction: 'I', idleNoticeText: 'i', resumeInstruction: 'R', resumeText: 'r', topicInstruction: 'no placeholder' };
    writeFileSync(join(dir, 'test-role', 'director.json'), JSON.stringify(director));
    expect(() => loadRoleCatalog(dir, 'test-role')).toThrow();
  });
});
