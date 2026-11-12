import type { EnvVar } from '../types';

/** Replace `{{key}}` tokens in a string using the given environment variables. */
export function resolveEnv(str: string, environments: EnvVar[]): string {
  if (typeof str !== 'string') return str;
  let res = str;
  environments.forEach((env) => {
    if (env.key) {
      const regex = new RegExp(`\\{\\{${env.key}\\}\\}`, 'g');
      res = res.replace(regex, env.value);
    }
  });
  return res;
}
