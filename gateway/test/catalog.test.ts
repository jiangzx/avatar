import { describe, expect, it } from 'vitest';
import { DEFAULT_ROLE, fixedRoleCatalog } from '../src/roles/catalog.ts';
import { devContext, devContextResolver } from '../src/session/context.ts';
import type { DirectorConfig } from '../src/session/director.ts';

const director = {
  followupAfterMs: 8000, idleNoticeAfterMs: 25000, maxConsecutive: 2, maxPerWindow: 3, windowMs: 300000,
  quietPhrases: [], greetingInstruction: 'G', greetingText: 'greeting', followupInstruction: 'F', followupText: 'followup', idleNoticeInstruction: 'I', idleNoticeText: 'idle', resumeInstruction: 'R', resumeText: 'resume', toolContinueInstruction: 'C', toolContinueText: '好。', memoryNoticeInstruction: 'N', memoryNoticeText: '记着。',
} satisfies DirectorConfig;

describe('fixedRoleCatalog', () => {
  it('stubs the care prompt', () => {
    expect(fixedRoleCatalog('P', director).carePrompt()).toBe('FIXTURE CARE');
  });

  it('exposes the default role with both stub styles sharing one persona', () => {
    const roles = fixedRoleCatalog('P', director);
    expect(roles.defaultRole()).toBe(DEFAULT_ROLE);
    expect(roles.defaultStyle(DEFAULT_ROLE)).toBe('grandchild');
    expect(roles.hasStyle(DEFAULT_ROLE, 'grandchild')).toBe(true);
    expect(roles.hasStyle(DEFAULT_ROLE, 'old-friend')).toBe(true);
    expect(roles.hasStyle(DEFAULT_ROLE, 'pirate')).toBe(false);
    expect(roles.hasStyle('other-role', 'grandchild')).toBe(false);
    expect(roles.buildPersona(DEFAULT_ROLE, 'old-friend')).toBe('P');
    expect(roles.voiceFor(DEFAULT_ROLE, 'grandchild')).toBeUndefined();
    expect(roles.director(DEFAULT_ROLE)).toBe(director);
    expect(roles.extractPrompt()).toBe('FIXTURE EXTRACT');
    expect(roles.recallPrompt()).toBe('FIXTURE RECALL');
    expect(roles.affectPrompt()).toBe('FIXTURE AFFECT');
  });

  it('exposes language-specific personas and directors', () => {
    const roles = fixedRoleCatalog('P-zh', director, {
      languages: ['zh', 'en'],
      defaultLanguage: 'zh',
      personas: { zh: 'P-zh', en: 'P-en' },
      directors: { en: { ...director, greetingText: 'hello' } },
    });
    expect(roles.supportedLanguages(DEFAULT_ROLE)).toEqual(['zh', 'en']);
    expect(roles.defaultLanguage(DEFAULT_ROLE)).toBe('zh');
    expect(roles.buildPersona(DEFAULT_ROLE, 'grandchild', 'en')).toBe('P-en');
    expect(roles.director(DEFAULT_ROLE, 'en').greetingText).toBe('hello');
    expect(roles.director(DEFAULT_ROLE).greetingText).toBe('greeting');
  });

  it('builds a dev context from the catalog defaults', () => {
    expect(devContext(fixedRoleCatalog('P', director))).toEqual({ roleId: DEFAULT_ROLE, styleId: 'grandchild', voice: undefined, language: 'zh' });
  });

  it('builds a dev context in the role default language', () => {
    const roles = fixedRoleCatalog('P', director, { languages: ['zh', 'en'], defaultLanguage: 'en' });
    expect(devContext(roles)).toEqual({ roleId: DEFAULT_ROLE, styleId: 'grandchild', voice: undefined, language: 'en' });
  });

  it('keeps the stub default language inside its supported languages', () => {
    const roles = fixedRoleCatalog('P', director, { languages: ['zh'], defaultLanguage: 'en' });
    expect(roles.supportedLanguages(DEFAULT_ROLE)).toEqual(['en', 'zh']);
    expect(roles.defaultLanguage(DEFAULT_ROLE)).toBe('en');

    const noList = fixedRoleCatalog('P', director, { defaultLanguage: 'en' });
    expect(noList.supportedLanguages(DEFAULT_ROLE)).toEqual(['en']);
    expect(noList.defaultLanguage(DEFAULT_ROLE)).toBe('en');
  });
});

describe('devContextResolver', () => {
  it('accepts requests without a bearer and rejects any bearer until identity exists', () => {
    const resolver = devContextResolver(fixedRoleCatalog('P', director));
    expect(resolver.resolve(undefined)).toEqual({ ok: true, ctx: { roleId: DEFAULT_ROLE, styleId: 'grandchild', voice: undefined, language: 'zh' }, noticePending: false });
    expect(resolver.resolve('device-token-0123456789')).toEqual({ ok: false });
  });
});
