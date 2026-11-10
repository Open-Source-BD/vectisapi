import type { AuthConfig, Collection, HttpMethod, KvItem, RawType, TabState, TreeNode } from '../types';
import { generateId } from './id';

/**
 * OpenAPI 3.0 / 3.1 importer. Maps paths+operations to a collection tree
 * (grouped by tag), resolves internal `$ref` (with cycle guards), maps query/
 * header params, JSON/urlencoded request bodies, security schemes to auth, and
 * `servers[0]` to a `{{baseUrl}}` variable. Swagger 2.0 and external/remote
 * `$ref` are out of scope. Pure: takes an already-parsed object.
 */

const HTTP_METHODS: Record<string, HttpMethod> = {
  get: 'GET',
  post: 'POST',
  put: 'PUT',
  patch: 'PATCH',
  delete: 'DELETE',
  options: 'OPTIONS',
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function kv(key: string, value: string): KvItem {
  return { id: generateId(), key, value, type: 'text' };
}

function blankTab(): TabState {
  return {
    id: generateId(),
    method: 'GET',
    url: '',
    params: [],
    headers: [],
    auth: {
      type: 'none',
      bearer: '',
      basicUser: '',
      basicPass: '',
      apiKeyName: '',
      apiKeyValue: '',
      apiKeyIn: 'header',
      oauthToken: '',
      jwtToken: '',
      jwtPrefix: 'Bearer',
    },
    body: { type: 'none', formdata: [], urlencoded: [], rawContent: '', rawType: 'application/json' },
    scripts: '',
    tests: '',
    response: null,
    activeSubTab: 'params',
    activeResTab: 'body',
  };
}

export function isOpenApi(json: unknown): boolean {
  if (!isObj(json)) return false;
  return (typeof json.openapi === 'string' || typeof json.swagger === 'string') && isObj(json.paths);
}

/** Resolve a local JSON-pointer `$ref` like "#/components/schemas/User". */
function resolveRef(doc: Obj, ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined; // external/remote refs unsupported
  const parts = ref
    .slice(2)
    .split('/')
    .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur: unknown = doc;
  for (const part of parts) {
    if (!isObj(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

/** Follow a single `$ref` (one level) with cycle protection. */
function deref(doc: Obj, node: unknown, seen: Set<string>): unknown {
  let cur = node;
  let guard = 0;
  while (isObj(cur) && typeof cur.$ref === 'string') {
    if (seen.has(cur.$ref) || guard++ > 50) return {};
    seen.add(cur.$ref);
    cur = resolveRef(doc, cur.$ref);
  }
  return cur;
}

/** Build a sample value from a JSON schema (example/default/enum preferred). */
function sampleFromSchema(doc: Obj, schemaRaw: unknown, seen: Set<string>, depth = 0): unknown {
  if (depth > 8) return null;
  const schema = deref(doc, schemaRaw, new Set(seen));
  if (!isObj(schema)) return null;

  if ('example' in schema) return schema.example;
  if ('default' in schema) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];

  const type = typeof schema.type === 'string' ? schema.type : isObj(schema.properties) ? 'object' : undefined;
  switch (type) {
    case 'object': {
      const out: Obj = {};
      const props = isObj(schema.properties) ? schema.properties : {};
      for (const [k, v] of Object.entries(props)) {
        out[k] = sampleFromSchema(doc, v, seen, depth + 1);
      }
      return out;
    }
    case 'array':
      return [sampleFromSchema(doc, schema.items, seen, depth + 1)];
    case 'integer':
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'string':
      return schema.format === 'date-time' ? new Date(0).toISOString() : '';
    default:
      return null;
  }
}

function mapSecurity(tab: TabState, schemes: Obj, requirement: Obj | undefined): void {
  if (!requirement) return;
  const schemeName = Object.keys(requirement)[0];
  if (!schemeName) return;
  const scheme = schemes[schemeName];
  if (!isObj(scheme)) return;

  const type = scheme.type;
  const auth: AuthConfig = tab.auth;
  if (type === 'http' && scheme.scheme === 'bearer') auth.type = 'bearer';
  else if (type === 'http' && scheme.scheme === 'basic') auth.type = 'basic';
  else if (type === 'oauth2' || type === 'openIdConnect') auth.type = 'oauth2';
  else if (type === 'apiKey' && typeof scheme.name === 'string') {
    auth.type = 'apikey';
    auth.apiKeyName = scheme.name;
    auth.apiKeyIn = scheme.in === 'query' ? 'query' : 'header';
  }
}

function mapOperation(
  doc: Obj,
  path: string,
  method: HttpMethod,
  op: Obj,
  pathLevelParams: unknown[],
  schemes: Obj,
  globalSecurity: Obj | undefined,
  baseVar: string,
): { node: TreeNode; tag: string } {
  const tab = blankTab();
  tab.method = method;
  tab.url = `${baseVar}${path}`;

  // Parameters: path-level + operation-level, deref'd.
  const params = [...pathLevelParams, ...(Array.isArray(op.parameters) ? op.parameters : [])];
  for (const pRaw of params) {
    const p = deref(doc, pRaw, new Set());
    if (!isObj(p) || typeof p.name !== 'string') continue;
    const example = String(sampleFromSchema(doc, p.schema, new Set()) ?? p.example ?? '');
    if (p.in === 'query') tab.params.push(kv(p.name, example === 'null' ? '' : example));
    else if (p.in === 'header') tab.headers.push(kv(p.name, example === 'null' ? '' : example));
  }

  // Request body.
  const body = deref(doc, op.requestBody, new Set());
  if (isObj(body) && isObj(body.content)) {
    const content = body.content as Obj;
    if (isObj(content['application/json'])) {
      const media = content['application/json'] as Obj;
      const sample = 'example' in media ? media.example : sampleFromSchema(doc, media.schema, new Set());
      tab.body.type = 'raw';
      tab.body.rawType = 'application/json' as RawType;
      tab.body.rawContent = JSON.stringify(sample ?? {}, null, 2);
      if (!tab.headers.some((h) => h.key.toLowerCase() === 'content-type')) {
        tab.headers.push(kv('Content-Type', 'application/json'));
      }
    } else if (isObj(content['application/x-www-form-urlencoded'])) {
      const media = content['application/x-www-form-urlencoded'] as Obj;
      const schema = deref(doc, media.schema, new Set());
      tab.body.type = 'urlencoded';
      if (isObj(schema) && isObj(schema.properties)) {
        for (const k of Object.keys(schema.properties)) tab.body.urlencoded.push(kv(k, ''));
      }
    }
  }

  // Security: operation-level overrides global.
  const opSecurity = Array.isArray(op.security) ? op.security[0] : undefined;
  mapSecurity(tab, schemes, (isObj(opSecurity) ? opSecurity : undefined) ?? globalSecurity);

  const name =
    (typeof op.summary === 'string' && op.summary) ||
    (typeof op.operationId === 'string' && op.operationId) ||
    `${method} ${path}`;
  const tag = Array.isArray(op.tags) && typeof op.tags[0] === 'string' ? op.tags[0] : '';
  return { node: { id: generateId(), type: 'request', name, request: tab }, tag };
}

export interface OpenApiImport {
  collection: Collection;
  /** Base URL from `servers[0]`, surfaced as a `{{baseUrl}}` variable. Empty if none. */
  baseUrl: string;
}

export function fromOpenApi(spec: unknown): OpenApiImport {
  const doc = isObj(spec) ? spec : {};
  const info = isObj(doc.info) ? doc.info : {};
  const title = typeof info.title === 'string' && info.title ? info.title : 'OpenAPI Import';

  const servers = Array.isArray(doc.servers) ? doc.servers : [];
  const firstServer = isObj(servers[0]) ? servers[0] : undefined;
  const baseUrl = firstServer && typeof firstServer.url === 'string' ? firstServer.url : '';
  const baseVar = baseUrl ? '{{baseUrl}}' : '';

  const components = isObj(doc.components) ? doc.components : {};
  const schemes = isObj(components.securitySchemes) ? (components.securitySchemes as Obj) : {};
  const globalSecurity = Array.isArray(doc.security) && isObj(doc.security[0]) ? (doc.security[0] as Obj) : undefined;

  const paths = isObj(doc.paths) ? doc.paths : {};
  const byTag = new Map<string, TreeNode[]>();
  const rootNodes: TreeNode[] = [];

  for (const [path, itemRaw] of Object.entries(paths)) {
    const item = deref(doc, itemRaw, new Set());
    if (!isObj(item)) continue;
    const pathLevelParams = Array.isArray(item.parameters) ? item.parameters : [];

    for (const [methodKey, opRaw] of Object.entries(item)) {
      const method = HTTP_METHODS[methodKey.toLowerCase()];
      if (!method || !isObj(opRaw)) continue;
      const { node, tag } = mapOperation(doc, path, method, opRaw, pathLevelParams, schemes, globalSecurity, baseVar);
      if (tag) {
        if (!byTag.has(tag)) byTag.set(tag, []);
        byTag.get(tag)!.push(node);
      } else {
        rootNodes.push(node);
      }
    }
  }

  const children: TreeNode[] = [
    ...[...byTag.entries()].map(([tag, nodes]) => ({
      id: generateId(),
      type: 'folder' as const,
      name: tag,
      children: nodes,
    })),
    ...rootNodes,
  ];

  return {
    collection: { id: generateId(), name: title, children, date: new Date().toISOString() },
    baseUrl,
  };
}
