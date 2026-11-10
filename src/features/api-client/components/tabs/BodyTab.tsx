import type { BodyType, RawType } from '../../types';
import { selectActiveTab, useApiStore } from '../../store/useApiStore';
import { KvEditor, CodeTextarea } from '@/components/ui';
import type { EditorLang } from '@/components/ui';
import { beautify } from '../../lib/format';

const RAW_LANG: Record<RawType, EditorLang> = {
  'application/json': 'json',
  'application/xml': 'xml',
  'text/html': 'html',
  'text/plain': 'text',
};

const BODY_TYPES: BodyType[] = ['none', 'formdata', 'urlencoded', 'raw', 'graphql'];

export function BodyTab() {
  const tab = useApiStore(selectActiveTab);
  const updateActiveTab = useApiStore((s) => s.updateActiveTab);
  const { body } = tab;

  return (
    <>
      <div style={{ display: 'flex', gap: '16px', marginBottom: '12px', alignItems: 'center' }}>
        {BODY_TYPES.map((t) => (
          <label key={t} className="md-radio">
            <input
              type="radio"
              name={`body-type-${tab.id}`}
              value={t}
              checked={body.type === t}
              onChange={() => updateActiveTab({ body: { ...body, type: t } })}
            />{' '}
            <span>{t}</span>
          </label>
        ))}
        {body.type === 'raw' && (
          <select
            className="md-select"
            value={body.rawType}
            onChange={(e) => updateActiveTab({ body: { ...body, rawType: e.target.value as RawType } })}
            style={{ marginLeft: '12px', padding: '4px 8px', fontSize: '13px' }}
          >
            <option value="application/json">JSON</option>
            <option value="text/plain">Text</option>
            <option value="application/xml">XML</option>
            <option value="text/html">HTML</option>
          </select>
        )}
      </div>

      {body.type === 'none' && (
        <div style={{ color: 'var(--md-sys-color-on-surface-variant)', padding: '16px' }}>
          This request does not have a body.
        </div>
      )}
      {body.type === 'formdata' && (
        <>
          {body.formdata.some((item) => item.type === 'file' && item.file) && (
            <div
              className="body-file-note"
              title="File attachments live only in this session — they are not written to disk, git, or shared/exported collections."
            >
              <span className="material-symbols-outlined" style={{ fontSize: '15px' }}>
                info
              </span>
              Attached files aren&apos;t saved to disk or git — re-attach after reload or on another machine.
            </div>
          )}
          <KvEditor
            items={body.formdata}
            allowFile
            onChange={(formdata) => updateActiveTab({ body: { ...body, formdata } })}
          />
        </>
      )}
      {body.type === 'urlencoded' && (
        <KvEditor
          items={body.urlencoded}
          onChange={(urlencoded) => updateActiveTab({ body: { ...body, urlencoded } })}
        />
      )}
      {body.type === 'raw' && (
        <>
          {(body.rawType === 'application/json' ||
            body.rawType === 'application/xml' ||
            body.rawType === 'text/html') && (
            <div style={{ marginBottom: '8px' }}>
              <button
                className="md-text-btn"
                onClick={() =>
                  updateActiveTab({ body: { ...body, rawContent: beautify(body.rawContent, body.rawType) } })
                }
              >
                <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>
                  auto_fix_high
                </span>{' '}
                Beautify
              </button>
            </div>
          )}
          <CodeTextarea
            className="md-textarea body-textarea"
            language={RAW_LANG[body.rawType]}
            value={body.rawContent}
            onChange={(rawContent) => updateActiveTab({ body: { ...body, rawContent } })}
            spellCheck={false}
            placeholder="Enter request body here..."
          />
        </>
      )}
      {body.type === 'graphql' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <label className="modal-label">Query</label>
          <CodeTextarea
            className="md-textarea body-textarea"
            language="js"
            value={body.graphql?.query ?? ''}
            onChange={(query) =>
              updateActiveTab({ body: { ...body, graphql: { query, variables: body.graphql?.variables ?? '' } } })
            }
            spellCheck={false}
            placeholder="query { ... }"
          />
          <label className="modal-label">Variables (JSON)</label>
          <CodeTextarea
            className="md-textarea body-textarea"
            language="json"
            value={body.graphql?.variables ?? ''}
            onChange={(variables) =>
              updateActiveTab({ body: { ...body, graphql: { query: body.graphql?.query ?? '', variables } } })
            }
            spellCheck={false}
            placeholder='{ "id": 1 }'
            style={{ minHeight: '100px' }}
          />
        </div>
      )}
    </>
  );
}
