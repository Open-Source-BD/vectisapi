import { useCallback } from 'react';
import { executeActiveSend } from '../lib/sendActive';

export { executeActiveSend };

/** Returns a `send` callback that runs scripts, sends via proxy/direct, records history. */
export function useRequestRunner(): () => Promise<void> {
  return useCallback(() => executeActiveSend(), []);
}
