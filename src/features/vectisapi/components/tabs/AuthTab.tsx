import type { ApiKeyIn, AuthType } from '../../types';
import { selectActiveTab, useApiStore } from '../../store/useApiStore';

const TYPES: { id: AuthType; label: string }[] = [
  { id: 'none', label: 'No Auth' },
  { id: 'bearer', label: 'Bearer Token' },
  { id: 'basic', label: 'Basic Auth' },
  { id: 'apikey', label: 'API Key' },
  { id: 'oauth2', label: 'OAuth 2.0' },
  { id: 'jwt', label: 'JWT Bearer' },
];

export function AuthTab() {
  const tab = useApiStore(selectActiveTab);
  const updateActiveTab = useApiStore((s) => s.updateActiveTab);
  const { auth } = tab;
  const patch = (u: Partial<typeof auth>) => updateActiveTab({ auth: { ...auth, ...u } });

  return (
    <>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '16px' }}>
        <span style={{ color: 'var(--md-sys-color-on-surface-variant)' }}>Type:</span>
        <select className="md-select" value={auth.type} onChange={(e) => patch({ type: e.target.value as AuthType })}>
          {TYPES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </div>

      {auth.type === 'bearer' && (
        <input
          className="md-input"
          placeholder="Token"
          value={auth.bearer}
          onChange={(e) => patch({ bearer: e.target.value })}
          style={{ maxWidth: '400px' }}
        />
      )}

      {auth.type === 'basic' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <input
            className="md-input"
            placeholder="Username"
            value={auth.basicUser}
            onChange={(e) => patch({ basicUser: e.target.value })}
            style={{ maxWidth: '300px' }}
          />
          <input
            type="password"
            className="md-input"
            placeholder="Password"
            value={auth.basicPass}
            onChange={(e) => patch({ basicPass: e.target.value })}
            style={{ maxWidth: '300px' }}
          />
        </div>
      )}

      {auth.type === 'apikey' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', maxWidth: '400px' }}>
          <input
            className="md-input"
            placeholder="Key (e.g. X-Api-Key)"
            value={auth.apiKeyName}
            onChange={(e) => patch({ apiKeyName: e.target.value })}
          />
          <input
            className="md-input"
            placeholder="Value"
            value={auth.apiKeyValue}
            onChange={(e) => patch({ apiKeyValue: e.target.value })}
          />
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <span style={{ color: 'var(--md-sys-color-on-surface-variant)' }}>Add to:</span>
            <select
              className="md-select"
              value={auth.apiKeyIn}
              onChange={(e) => patch({ apiKeyIn: e.target.value as ApiKeyIn })}
            >
              <option value="header">Header</option>
              <option value="query">Query Param</option>
            </select>
          </div>
        </div>
      )}

      {auth.type === 'oauth2' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxWidth: '500px' }}>
          <input
            className="md-input"
            placeholder="Access Token"
            value={auth.oauthToken}
            onChange={(e) => patch({ oauthToken: e.target.value })}
          />
          <span style={{ fontSize: '12px', color: 'var(--md-sys-color-on-surface-variant)' }}>
            Paste an access token — sent as <code>Authorization: Bearer …</code>. (No live token fetch.)
          </span>
        </div>
      )}

      {auth.type === 'jwt' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', maxWidth: '500px' }}>
          <input
            className="md-input"
            placeholder="JWT"
            value={auth.jwtToken}
            onChange={(e) => patch({ jwtToken: e.target.value })}
          />
          <input
            className="md-input"
            placeholder="Header prefix (default: Bearer)"
            value={auth.jwtPrefix}
            onChange={(e) => patch({ jwtPrefix: e.target.value })}
            style={{ maxWidth: '200px' }}
          />
        </div>
      )}
    </>
  );
}
