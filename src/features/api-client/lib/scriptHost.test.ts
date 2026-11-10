import { describe, expect, it, vi } from 'vitest';
import { runScript } from './scriptHost';

describe('runScript', () => {
  it('pre-request sets var visible to request', async () => {
    const r = await runScript({ phase: 'pre', code: 'pm.environment.set("a", pm.environment.get("x") + "!")', vars: { x: '1' } });
    expect(r.error).toBeUndefined();
    expect(r.setVars).toEqual([['a', '1!']]);
    expect(r.vars).toEqual({ x: '1', a: '1!' });
  });

  it('pm.test results returned', async () => {
    const r = await runScript({
      phase: 'test',
      code: 'pm.test("ok", () => pm.expect(pm.response.code).to.eql(200)); pm.test("bad", () => pm.expect(1).to.eql(2))',
      vars: {},
      response: { code: 200, status: 'OK', body: '{}' },
    });
    expect(r.testResults).toEqual([
      { name: 'ok', pass: true },
      { name: 'bad', pass: false, error: 'Expected 1 to equal 2' },
    ]);
  });

  it('reports thrown errors', async () => {
    const r = await runScript({ phase: 'pre', code: 'throw new Error("boom")', vars: {} });
    expect(r.error).toBe('boom');
  });

  it('hung worker times out, is terminated, and the next run works', async () => {
    // @vitest/web-worker runs workers on the test thread, so a real `while(true)` would
    // hang the runner. A worker that never answers exercises the same timeout path.
    const RealWorker = globalThis.Worker;
    const terminate = vi.fn();
    class HungWorker extends EventTarget {
      postMessage() {}
      terminate = terminate;
    }
    let first = true;
    const ctor = vi.fn(function (...a: ConstructorParameters<typeof Worker>) {
      if (!first) return new RealWorker(...a);
      first = false;
      return new HungWorker();
    });
    vi.stubGlobal('Worker', ctor);
    try {
      // Fresh module instance so no worker from an earlier test is reused.
      vi.resetModules();
      const { runScript } = await import('./scriptHost');
      const r = await runScript({ phase: 'pre', code: 'while(true){}', vars: {} }, 100);
      expect(r.error).toBe('Script timed out after 0.1s');
      expect(terminate).toHaveBeenCalledOnce();
      const ok = await runScript({ phase: 'pre', code: 'pm.environment.set("k","v")', vars: {} });
      expect(ok.setVars).toEqual([['k', 'v']]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('script cannot access window/document', async () => {
    const r = await runScript({
      phase: 'pre',
      code: 'pm.environment.set("t", typeof document + "," + typeof window)',
      vars: {},
    });
    expect(r.setVars).toEqual([['t', 'undefined,undefined']]);
  });

  it('empty script does not spawn worker', async () => {
    const spy = vi.spyOn(globalThis, 'Worker');
    const r = await runScript({ phase: 'pre', code: '  \n', vars: { a: 'b' } });
    expect(spy).not.toHaveBeenCalled();
    expect(r).toEqual({ vars: { a: 'b' }, setVars: [], testResults: [] });
    spy.mockRestore();
  });
});
