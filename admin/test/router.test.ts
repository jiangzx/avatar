import { describe, expect, it } from 'vitest';
import { href, parseHash } from '../src/router.ts';

describe('hash router', () => {
  it('defaults to the overview', () => {
    expect(parseHash('').path).toBe('/overview');
    expect(parseHash('#').path).toBe('/overview');
  });

  it('splits segments and query', () => {
    const route = parseHash('#/trace/1b4e28ba-2fa1-11d2-883f-0016d3cca427?level=error');
    expect(route.segments).toEqual(['trace', '1b4e28ba-2fa1-11d2-883f-0016d3cca427']);
    expect(route.query.get('level')).toBe('error');
  });

  it('builds hrefs with encoded query', () => {
    expect(href('/sessions', { oid: 'abc', char: '' })).toBe('#/sessions?oid=abc');
    expect(href('/users/abc')).toBe('#/users/abc');
  });
});
