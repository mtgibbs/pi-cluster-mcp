import { describe, it, expect } from 'vitest';
import { validateImportUrl, validateSlug, beginImport, endImport } from '../tools/mealie.js';

function isError(v: unknown): boolean {
  return typeof v === 'object' && v !== null && (v as { error?: boolean }).error === true;
}

describe('mealie import URL gate', () => {
  it('accepts public recipe sites', () => {
    expect(validateImportUrl('https://www.seriouseats.com/foo-recipe')).toBeInstanceOf(URL);
    expect(validateImportUrl('http://cooking.nytimes.com/recipes/1')).toBeInstanceOf(URL);
  });

  it('rejects non-http(s) schemes', () => {
    expect(isError(validateImportUrl('file:///etc/passwd'))).toBe(true);
    expect(isError(validateImportUrl('ftp://example.com/x'))).toBe(true);
    expect(isError(validateImportUrl('gopher://example.com'))).toBe(true);
  });

  it('rejects cluster-internal and LAN targets (SSRF gate)', () => {
    expect(isError(validateImportUrl('http://localhost:9000/api'))).toBe(true);
    expect(isError(validateImportUrl('http://127.0.0.1/'))).toBe(true);
    expect(isError(validateImportUrl('http://10.43.0.1/'))).toBe(true);
    expect(isError(validateImportUrl('http://192.168.1.61/'))).toBe(true);
    expect(isError(validateImportUrl('http://172.16.5.4/'))).toBe(true);
    expect(isError(validateImportUrl('http://169.254.169.254/latest/meta-data'))).toBe(true);
    expect(isError(validateImportUrl('http://mealie-postgresql.mealie.svc.cluster.local:5432'))).toBe(true);
    expect(isError(validateImportUrl('http://qnap.local/'))).toBe(true);
    expect(isError(validateImportUrl('https://pihole.lab.mtgibbs.dev/admin'))).toBe(true);
    expect(isError(validateImportUrl('http://[::1]/'))).toBe(true);
  });

  it('rejects malformed and oversized input', () => {
    expect(isError(validateImportUrl('not a url'))).toBe(true);
    expect(isError(validateImportUrl(''))).toBe(true);
    expect(isError(validateImportUrl(undefined))).toBe(true);
    expect(isError(validateImportUrl(42))).toBe(true);
    expect(isError(validateImportUrl(`https://example.com/${'a'.repeat(2100)}`))).toBe(true);
  });

  it('does not block public 172.x addresses outside 172.16/12', () => {
    expect(validateImportUrl('http://172.32.0.1/')).toBeInstanceOf(URL);
  });
});

describe('mealie import active-run guard', () => {
  it('blocks a second import of the same URL while one is in flight', () => {
    const key = 'https://example.com/soup';
    expect(beginImport(key)).toBe(true);
    expect(beginImport(key)).toBe(false); // overlap refused
    endImport(key);
    expect(beginImport(key)).toBe(true); // released after completion
    endImport(key);
  });

  it('allows different URLs to import concurrently', () => {
    expect(beginImport('https://example.com/a')).toBe(true);
    expect(beginImport('https://example.com/b')).toBe(true);
    endImport('https://example.com/a');
    endImport('https://example.com/b');
  });
});

describe('mealie slug validation', () => {
  it('accepts normal slugs', () => {
    expect(validateSlug('grandmas-chicken-soup')).toBe('grandmas-chicken-soup');
    expect(validateSlug('recipe-123')).toBe('recipe-123');
  });

  it('rejects path traversal and injection shapes', () => {
    expect(isError(validateSlug('../admin'))).toBe(true);
    expect(isError(validateSlug('a/b'))).toBe(true);
    expect(isError(validateSlug('a?x=1'))).toBe(true);
    expect(isError(validateSlug(''))).toBe(true);
    expect(isError(validateSlug(undefined))).toBe(true);
    expect(isError(validateSlug('a'.repeat(300)))).toBe(true);
  });
});
