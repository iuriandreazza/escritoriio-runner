import { describe, expect, it } from 'vitest';
import { CREDENTIAL_PLACES, credentialPaths } from './credential-places.ts';

describe('where credentials are kept', () => {
  it('are named one by one, under home', () => {
    expect(credentialPaths('/Users/ana', undefined)).toEqual(CREDENTIAL_PLACES.map((place) => `/Users/ana/${place}`));
    expect(credentialPaths('/Users/ana', undefined)).toEqual(expect.arrayContaining(['/Users/ana/.ssh', '/Users/ana/.aws', '/Users/ana/Library/Keychains', '/Users/ana/.config/gh']));
  });

  it('include the login of the coding agent when it is kept elsewhere', () => {
    expect(credentialPaths('/Users/ana', '/opt/claude-config')).toContain('/opt/claude-config/.credentials.json');
    expect(credentialPaths('/Users/ana', undefined)).not.toContain('/opt/claude-config/.credentials.json');
  });

  it('are written once with a slash between, whether home ends in one or not', () => {
    expect(credentialPaths('/Users/ana/', undefined)[0]).toBe('/Users/ana/.ssh');
  });
});
