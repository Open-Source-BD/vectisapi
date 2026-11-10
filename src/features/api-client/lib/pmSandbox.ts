import type { EnvVar, TestResult } from '../types';

export interface PmResponse {
  code: number;
  status: string;
  text: () => string;
  json: () => unknown | null;
}

export interface Pm {
  environment: {
    set: (key: string, value: string) => void;
    get: (key: string) => string | undefined;
  };
  /** Read-only access to the current iteration's data row (Collection Runner). */
  iterationData: {
    get: (key: string) => string | undefined;
  };
  variables: Record<string, string>;
  test: (name: string, fn: () => void) => void;
  expect: (val: unknown) => {
    to: {
      eql: (exp: unknown) => void;
      be: { true: () => void; false: () => void };
    };
  };
  response?: PmResponse;
}

/**
 * Encapsulates the Postman-like `pm` sandbox used for pre-request and test
 * scripts. Scripts run via `new Function('pm', src)` exactly as before.
 */
export class PmSandbox {
  readonly testResults: TestResult[] = [];
  readonly pm: Pm;
  /** Live variable map: env/globals seed, iteration data on top, plus script writes. */
  private readonly envMap: Record<string, string> = {};

  constructor(
    environments: EnvVar[],
    onEnvSet: (key: string, value: string) => void,
    iterationData: Record<string, string> = {},
  ) {
    const envMap = this.envMap;
    environments.forEach((e) => {
      if (e.key) envMap[e.key] = e.value;
    });
    // Iteration data overrides env/globals for the current run row.
    Object.entries(iterationData).forEach(([k, v]) => {
      envMap[k] = v;
    });

    this.pm = {
      environment: {
        set: (k, v) => {
          envMap[k] = v;
          onEnvSet(k, v);
        },
        get: (k) => envMap[k],
      },
      iterationData: {
        get: (k) => iterationData[k],
      },
      variables: envMap,
      test: (name, fn) => {
        try {
          fn();
          this.testResults.push({ name, pass: true });
        } catch (e) {
          this.testResults.push({ name, pass: false, error: (e as Error).message });
        }
      },
      expect: (val) => ({
        to: {
          eql: (exp) => {
            if (val !== exp) throw new Error(`Expected ${val} to equal ${exp}`);
          },
          be: {
            true: () => {
              if (val !== true) throw new Error(`Expected ${val} to be true`);
            },
            false: () => {
              if (val !== false) throw new Error(`Expected ${val} to be false`);
            },
          },
        },
      }),
    };
  }

  /**
   * Current variable list (env/globals + iteration data + script writes), as an
   * EnvVar[] for `resolveEnv`. Read AFTER `runPreRequest` so pre-request script
   * mutations reach request interpolation.
   */
  currentVars(): EnvVar[] {
    return Object.entries(this.envMap).map(([key, value]) => ({ id: `v:${key}`, key, value }));
  }

  /** Run a pre-request script. Throws if the script throws. */
  runPreRequest(script: string): void {
    if (!script) return;
    new Function('pm', script)(this.pm);
  }

  /** Attach the response object so test scripts can read `pm.response`. */
  attachResponse(code: number, status: string, rawText: string): void {
    this.pm.response = {
      code,
      status,
      text: () => rawText,
      json: () => {
        try {
          return JSON.parse(rawText);
        } catch {
          return null;
        }
      },
    };
  }

  /** Run a test script. Caught errors land in testResults as "Script Error". */
  runTests(script: string): void {
    if (!script) return;
    try {
      new Function('pm', script)(this.pm);
    } catch (e) {
      this.testResults.push({ name: 'Script Error', pass: false, error: (e as Error).message });
    }
  }
}
