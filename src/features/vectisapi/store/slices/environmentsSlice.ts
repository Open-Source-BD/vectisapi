import type { StateCreator } from 'zustand';
import type { StoreState } from './types';
import type { Environment, EnvVar } from '../../types';
import { generateId } from '../../lib/id';

export interface EnvironmentsSlice {
  environments: Environment[];
  activeEnvId: string | null;
  globals: EnvVar[];

  createEnvironment: (name: string) => void;
  renameEnvironment: (id: string, name: string) => void;
  deleteEnvironment: (id: string) => void;
  setActiveEnv: (id: string | null) => void;
  setEnvVars: (envId: string, vars: EnvVar[]) => void;
  setGlobals: (vars: EnvVar[]) => void;
  setEnvVar: (key: string, value: string) => void;
  /** Copy or move a variable between containers (env id, or null for globals). */
  transferVar: (varId: string, fromId: string | null, toId: string | null, mode: 'copy' | 'move') => void;
}

export const createEnvironmentsSlice: StateCreator<StoreState, [], [], EnvironmentsSlice> = (set, _get) => ({
  environments: [],
  activeEnvId: null,
  globals: [],

  createEnvironment: (name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const env: Environment = { id: generateId(), name: trimmed, vars: [] };
    set((s) => ({ environments: [...s.environments, env], activeEnvId: env.id }));
  },

  renameEnvironment: (id, name) =>
    set((s) => ({ environments: s.environments.map((e) => (e.id === id ? { ...e, name } : e)) })),

  deleteEnvironment: (id) =>
    set((s) => ({
      environments: s.environments.filter((e) => e.id !== id),
      activeEnvId: s.activeEnvId === id ? null : s.activeEnvId,
    })),

  setActiveEnv: (activeEnvId) => set({ activeEnvId }),

  setEnvVars: (envId, vars) =>
    set((s) => ({ environments: s.environments.map((e) => (e.id === envId ? { ...e, vars } : e)) })),

  setGlobals: (globals) => set({ globals }),

  setEnvVar: (key, value) =>
    set((s) => {
      const upsert = (vars: EnvVar[]) => {
        const exists = vars.find((p) => p.key === key);
        return exists
          ? vars.map((p) => (p.key === key ? { ...p, value } : p))
          : [...vars, { id: generateId(), key, value }];
      };
      const active = s.environments.find((e) => e.id === s.activeEnvId);
      if (active) {
        return { environments: s.environments.map((e) => (e.id === active.id ? { ...e, vars: upsert(e.vars) } : e)) };
      }
      return { globals: upsert(s.globals) };
    }),

  transferVar: (varId, fromId, toId, mode) =>
    set((s) => {
      if (fromId === toId) return {};
      const varsOf = (id: string | null) =>
        id === null ? s.globals : (s.environments.find((e) => e.id === id)?.vars ?? []);
      const fromVars = varsOf(fromId);
      const v = fromVars.find((x) => x.id === varId);
      if (!v) return {};

      const toVars = varsOf(toId);
      const nextTo = toVars.some((x) => x.key === v.key)
        ? toVars.map((x) => (x.key === v.key ? { ...x, value: v.value, type: v.type } : x))
        : [...toVars, { id: generateId(), key: v.key, value: v.value, type: v.type }];
      const nextFrom = mode === 'move' ? fromVars.filter((x) => x.id !== varId) : fromVars;

      let environments = s.environments;
      let globals = s.globals;
      const apply = (id: string | null, vars: EnvVar[]) => {
        if (id === null) globals = vars;
        else environments = environments.map((e) => (e.id === id ? { ...e, vars } : e));
      };
      apply(toId, nextTo);
      if (mode === 'move') apply(fromId, nextFrom);
      return { environments, globals };
    }),
});
