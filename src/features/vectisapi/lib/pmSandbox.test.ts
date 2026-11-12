import { describe, expect, it, vi } from 'vitest';
import { PmSandbox } from './pmSandbox';
import type { EnvVar } from '../types';

const env: EnvVar[] = [{ id: '1', key: 'base', value: 'x' }];

describe('PmSandbox', () => {
  it('runs pre-request scripts and exposes variables', () => {
    const sandbox = new PmSandbox(env, () => {});
    expect(() => sandbox.runPreRequest('if (pm.variables.base !== "x") throw new Error("bad")')).not.toThrow();
  });

  it('pm.environment.set invokes the callback and updates the map', () => {
    const onSet = vi.fn();
    const sandbox = new PmSandbox(env, onSet);
    sandbox.runPreRequest('pm.environment.set("token", "abc")');
    expect(onSet).toHaveBeenCalledWith('token', 'abc');
    expect(sandbox.pm.environment.get('token')).toBe('abc');
  });

  it('propagates pre-request script errors', () => {
    const sandbox = new PmSandbox(env, () => {});
    expect(() => sandbox.runPreRequest('throw new Error("boom")')).toThrow('boom');
  });

  it('records passing and failing tests', () => {
    const sandbox = new PmSandbox(env, () => {});
    sandbox.attachResponse(200, 'OK', '{"ok":true}');
    sandbox.runTests(`
      pm.test("status is 200", () => pm.expect(pm.response.code).to.eql(200));
      pm.test("fails", () => pm.expect(pm.response.code).to.eql(404));
      pm.test("json parsed", () => pm.expect(pm.response.json().ok).to.be.true());
    `);
    expect(sandbox.testResults).toHaveLength(3);
    expect(sandbox.testResults[0]).toMatchObject({ name: 'status is 200', pass: true });
    expect(sandbox.testResults[1].pass).toBe(false);
    expect(sandbox.testResults[2]).toMatchObject({ name: 'json parsed', pass: true });
  });

  it('exposes iteration data and seeds it into currentVars (overriding env)', () => {
    const sandbox = new PmSandbox(env, () => {}, { base: 'override', n: '2' });
    expect(sandbox.pm.iterationData.get('n')).toBe('2');
    expect(sandbox.pm.iterationData.get('missing')).toBeUndefined();
    const vars = sandbox.currentVars();
    expect(vars.find((v) => v.key === 'base')?.value).toBe('override');
    expect(vars.find((v) => v.key === 'n')?.value).toBe('2');
  });

  it('currentVars reflects pre-request script writes', () => {
    const sandbox = new PmSandbox(env, () => {});
    sandbox.runPreRequest('pm.environment.set("token", "T9")');
    expect(sandbox.currentVars().find((v) => v.key === 'token')?.value).toBe('T9');
  });

  it('captures a thrown test-script error as Script Error', () => {
    const sandbox = new PmSandbox(env, () => {});
    sandbox.attachResponse(500, 'Error', 'oops');
    sandbox.runTests('this is not valid js ((');
    expect(sandbox.testResults[0]).toMatchObject({ name: 'Script Error', pass: false });
  });
});
