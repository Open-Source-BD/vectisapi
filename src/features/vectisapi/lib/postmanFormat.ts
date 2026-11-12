import type {
  Collection,
  HttpMethod,
  KvItem,
  PostmanCollection,
  PostmanItem,
  PostmanRequest,
  RawType,
  TabState,
  TreeNode,
} from '../types';
import { generateId } from './id';

const SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';
const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

const LANG_TO_MIME: Record<string, RawType> = {
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  text: 'text/plain',
};
const MIME_TO_LANG: Record<RawType, string> = {
  'application/json': 'json',
  'application/xml': 'xml',
  'text/html': 'html',
  'text/plain': 'text',
};

function kv(key: string, value: string, type: 'text' | 'file' = 'text'): KvItem {
  return { id: generateId(), key, value, type };
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

// --- Detection ---

export function isPostmanCollection(json: unknown): json is PostmanCollection {
  const j = json as PostmanCollection | undefined;
  return !!j && typeof j === 'object' && !!j.info && Array.isArray(j.item);
}

// --- Postman → app ---

function mapRequest(req: PostmanRequest | undefined, events: PostmanItem['event']): TabState {
  const tab = blankTab();
  if (!req) return tab;

  const method = (req.method || 'GET').toUpperCase() as HttpMethod;
  tab.method = METHODS.includes(method) ? method : 'GET';
  tab.url = typeof req.url === 'string' ? req.url : req.url?.raw || '';

  tab.headers = (req.header || []).filter((h) => !h.disabled).map((h) => kv(h.key, h.value));

  if (req.auth?.type === 'bearer') {
    tab.auth.type = 'bearer';
    tab.auth.bearer = req.auth.bearer?.find((b) => b.key === 'token')?.value || '';
  } else if (req.auth?.type === 'basic') {
    tab.auth.type = 'basic';
    tab.auth.basicUser = req.auth.basic?.find((b) => b.key === 'username')?.value || '';
    tab.auth.basicPass = req.auth.basic?.find((b) => b.key === 'password')?.value || '';
  }

  const body = req.body;
  if (body?.mode === 'raw') {
    tab.body.type = 'raw';
    tab.body.rawContent = body.raw || '';
    tab.body.rawType = LANG_TO_MIME[body.options?.raw?.language || 'text'] || 'text/plain';
  } else if (body?.mode === 'urlencoded') {
    tab.body.type = 'urlencoded';
    tab.body.urlencoded = (body.urlencoded || []).filter((u) => !u.disabled).map((u) => kv(u.key, u.value));
  } else if (body?.mode === 'formdata') {
    tab.body.type = 'formdata';
    tab.body.formdata = (body.formdata || [])
      .filter((f) => !f.disabled)
      .map((f) => kv(f.key, f.value || '', f.type === 'file' ? 'file' : 'text'));
  }

  for (const ev of events || []) {
    const src = (ev.script?.exec || []).join('\n');
    if (ev.listen === 'prerequest') tab.scripts = src;
    else if (ev.listen === 'test') tab.tests = src;
  }

  return tab;
}

function mapItem(item: PostmanItem): TreeNode {
  if (Array.isArray(item.item)) {
    return { id: generateId(), type: 'folder', name: item.name, children: item.item.map(mapItem) };
  }
  return {
    id: generateId(),
    type: 'request',
    name: item.name,
    request: mapRequest(item.request, item.event),
  };
}

export function fromPostman(json: PostmanCollection): Collection {
  return {
    id: generateId(),
    name: json.info?.name || 'Imported Collection',
    children: (json.item || []).map(mapItem),
    date: new Date().toISOString(),
  };
}

// --- app → Postman ---

function requestToPostman(tab: TabState): PostmanRequest {
  const req: PostmanRequest = {
    method: tab.method,
    header: tab.headers.filter((h) => h.key).map((h) => ({ key: h.key, value: h.value })),
    url: { raw: tab.url },
  };

  if (tab.auth.type === 'bearer') {
    req.auth = { type: 'bearer', bearer: [{ key: 'token', value: tab.auth.bearer }] };
  } else if (tab.auth.type === 'basic') {
    req.auth = {
      type: 'basic',
      basic: [
        { key: 'username', value: tab.auth.basicUser },
        { key: 'password', value: tab.auth.basicPass },
      ],
    };
  }

  if (tab.body.type === 'raw') {
    req.body = {
      mode: 'raw',
      raw: tab.body.rawContent,
      options: { raw: { language: MIME_TO_LANG[tab.body.rawType] } },
    };
  } else if (tab.body.type === 'urlencoded') {
    req.body = {
      mode: 'urlencoded',
      urlencoded: tab.body.urlencoded.filter((u) => u.key).map((u) => ({ key: u.key, value: u.value })),
    };
  } else if (tab.body.type === 'formdata') {
    req.body = {
      mode: 'formdata',
      formdata: tab.body.formdata
        .filter((f) => f.key)
        .map((f) => ({ key: f.key, value: f.value, type: f.type === 'file' ? 'file' : 'text' })),
    };
  }

  return req;
}

function nodeToItem(node: TreeNode): PostmanItem {
  if (node.type === 'folder') {
    return { name: node.name, item: node.children.map(nodeToItem) };
  }
  const item: PostmanItem = { name: node.name, request: requestToPostman(node.request) };
  const events: NonNullable<PostmanItem['event']> = [];
  if (node.request.scripts) {
    events.push({ listen: 'prerequest', script: { type: 'text/javascript', exec: node.request.scripts.split('\n') } });
  }
  if (node.request.tests) {
    events.push({ listen: 'test', script: { type: 'text/javascript', exec: node.request.tests.split('\n') } });
  }
  if (events.length) item.event = events;
  return item;
}

export function toPostman(collection: Collection): PostmanCollection {
  return {
    info: { name: collection.name, schema: SCHEMA, _postman_id: collection.id },
    item: collection.children.map(nodeToItem),
  };
}
