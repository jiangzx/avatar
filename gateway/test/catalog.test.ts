import { describe, expect, it } from 'vitest';
import { DEFAULT_ROLE, fixedRoleCatalog } from '../src/roles/catalog.ts';
import { devContext, devContextResolver } from '../src/session/context.ts';
import type { DirectorConfig } from '../src/session/director.ts';
import { shippedCharacters, shippedRoles } from './support/shipped.ts';

const director = {
  followupAfterMs: 8000, idleNoticeAfterMs: 25000, maxConsecutive: 2, maxPerWindow: 3, windowMs: 300000,
  quietPhrases: [], greetingInstruction: 'G', greetingText: 'greeting', followupInstruction: 'F', followupText: 'followup', idleNoticeInstruction: 'I', idleNoticeText: 'idle', resumeInstruction: 'R', resumeText: 'resume', toolContinueInstruction: 'C', toolContinueText: '好。', memoryNoticeInstruction: 'N', memoryNoticeText: '记着。',
} satisfies DirectorConfig;

describe('fixedRoleCatalog', () => {
  it('stubs the shared prompts for any character', () => {
    const roles = fixedRoleCatalog('P', director);
    expect(roles.carePrompt('xiaokai')).toBe('FIXTURE CARE');
    expect(roles.recallPrompt('xiaonuan')).toBe('FIXTURE RECALL');
    expect(roles.affectPrompt('xiaoxin')).toBe('FIXTURE AFFECT');
    expect(roles.extractPrompt()).toBe('FIXTURE EXTRACT');
  });

  it('shares one persona and director across characters', () => {
    const roles = fixedRoleCatalog('P', director);
    expect(roles.defaultRole()).toBe(DEFAULT_ROLE);
    expect(roles.buildPersona('xiaonuan')).toBe('P');
    expect(roles.buildPersona('xiaokai')).toBe('P');
    expect(roles.director('xiaoxin')).toBe(director);
    expect('defaultStyle' in roles || 'hasStyle' in roles || 'voiceFor' in roles || 'pairs' in roles).toBe(false);
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
    expect(roles.buildPersona('xiaonuan', 'en')).toBe('P-en');
    expect(roles.director('xiaonuan', 'en').greetingText).toBe('hello');
    expect(roles.director('xiaonuan').greetingText).toBe('greeting');
  });

  it('builds a dev context for the requested character in its role language', () => {
    expect(devContext(fixedRoleCatalog('P', director), undefined, 'xiaokai')).toEqual({ characterId: 'xiaokai', language: 'zh', firstMeet: true });
    const shipped = shippedRoles();
    expect(devContext(shipped, shippedCharacters(), 'xiaoxin')).toEqual({ characterId: 'xiaoxin', language: 'zh', firstMeet: true });
  });

  it('builds a dev context in the role default language', () => {
    const roles = fixedRoleCatalog('P', director, { languages: ['zh', 'en'], defaultLanguage: 'en' });
    expect(devContext(roles, undefined, 'xiaonuan')).toEqual({ characterId: 'xiaonuan', language: 'en', firstMeet: true });
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
  it('accepts requests without a bearer for any character and rejects any bearer', () => {
    const resolver = devContextResolver(fixedRoleCatalog('P', director));
    expect(resolver.resolve(undefined, 'xiaoxin')).toEqual({ ok: true, ctx: { characterId: 'xiaoxin', language: 'zh', firstMeet: true }, noticePending: false });
    expect(resolver.resolve('device-token-0123456789', 'xiaonuan')).toEqual({ ok: false });
  });
});
