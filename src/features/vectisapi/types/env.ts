import type { KvItemType } from './http';

export interface EnvVar {
  id: string;
  key: string;
  value: string;
  type?: KvItemType;
}

/** A named environment holding a set of variables. */
export interface Environment {
  id: string;
  name: string;
  vars: EnvVar[];
}
