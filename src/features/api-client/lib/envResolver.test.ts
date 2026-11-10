import { describe, expect, it } from 'vitest';
import { resolveEnv } from './envResolver';
import type { EnvVar } from '../types';

const env: EnvVar[] = [
  { id: '1', key: 'host', value: 'api.example.com' },
  { id: '2', key: 'ver', value: 'v1' },
];

describe('resolveEnv', () => {
  it('replaces single token', () => {
    expect(resolveEnv('https://{{host}}/users', env)).toBe('https://api.example.com/users');
  });

  it('replaces multiple tokens incl. repeats', () => {
    expect(resolveEnv('{{host}}/{{ver}}/{{host}}', env)).toBe('api.example.com/v1/api.example.com');
  });

  it('leaves unknown tokens untouched', () => {
    expect(resolveEnv('{{missing}}', env)).toBe('{{missing}}');
  });

  it('ignores env vars with empty key', () => {
    expect(resolveEnv('x', [{ id: '3', key: '', value: 'nope' }])).toBe('x');
  });
});
