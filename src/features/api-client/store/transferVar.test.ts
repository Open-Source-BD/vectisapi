import { describe, it, expect, beforeEach } from 'vitest';
import { useApiStore } from './useApiStore';

const seed = () =>
  useApiStore.setState({
    environments: [
      { id: 'e1', name: 'A', vars: [{ id: 'v1', key: 'token', value: 'T' }] },
      { id: 'e2', name: 'B', vars: [] },
    ],
    globals: [],
  });

describe('transferVar', () => {
  beforeEach(seed);

  it('copies a var to another env, keeping the source', () => {
    useApiStore.getState().transferVar('v1', 'e1', 'e2', 'copy');
    const s = useApiStore.getState();
    expect(s.environments[0].vars).toHaveLength(1);
    expect(s.environments[1].vars[0]).toMatchObject({ key: 'token', value: 'T' });
  });

  it('moves a var, removing it from the source', () => {
    useApiStore.getState().transferVar('v1', 'e1', 'e2', 'move');
    const s = useApiStore.getState();
    expect(s.environments[0].vars).toHaveLength(0);
    expect(s.environments[1].vars[0].key).toBe('token');
  });

  it('transfers to globals (null target)', () => {
    useApiStore.getState().transferVar('v1', 'e1', null, 'copy');
    expect(useApiStore.getState().globals[0]).toMatchObject({ key: 'token', value: 'T' });
  });

  it('upserts by key — overwrites an existing same-key value in the target', () => {
    useApiStore.setState({
      environments: [
        { id: 'e1', name: 'A', vars: [{ id: 'v1', key: 'token', value: 'NEW' }] },
        { id: 'e2', name: 'B', vars: [{ id: 'v2', key: 'token', value: 'OLD' }] },
      ],
      globals: [],
    });
    useApiStore.getState().transferVar('v1', 'e1', 'e2', 'copy');
    const e2 = useApiStore.getState().environments[1].vars;
    expect(e2).toHaveLength(1);
    expect(e2[0].value).toBe('NEW');
  });

  it('is a no-op when source and target are the same', () => {
    useApiStore.getState().transferVar('v1', 'e1', 'e1', 'move');
    expect(useApiStore.getState().environments[0].vars).toHaveLength(1);
  });
});
