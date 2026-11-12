import { describe, expect, it } from 'vitest';
import { fromOpenApi, isOpenApi } from './parseOpenApi';
import type { RequestNode, TreeNode } from '../types';

const spec = {
  openapi: '3.0.0',
  info: { title: 'Pet API' },
  servers: [{ url: 'https://api.pets.io/v1' }],
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer' },
      apiKey: { type: 'apiKey', name: 'X-Key', in: 'header' },
    },
    schemas: {
      Pet: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string', example: 'Rex' } } },
    },
    parameters: {
      LimitParam: { name: 'limit', in: 'query', schema: { type: 'integer', default: 10 } },
    },
  },
  paths: {
    '/pets': {
      get: {
        tags: ['pets'],
        summary: 'List pets',
        parameters: [
          { $ref: '#/components/parameters/LimitParam' },
          { name: 'X-Trace', in: 'header', schema: { type: 'string' } },
        ],
      },
      post: {
        tags: ['pets'],
        operationId: 'createPet',
        requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } },
        security: [{ apiKey: [] }],
      },
    },
    '/health': { get: { summary: 'Health' } },
  },
};

function findReq(nodes: TreeNode[], name: string): RequestNode | undefined {
  for (const n of nodes) {
    if (n.type === 'request' && n.name === name) return n;
    if (n.type === 'folder') {
      const f = findReq(n.children, name);
      if (f) return f;
    }
  }
  return undefined;
}

describe('parseOpenApi', () => {
  it('detects OpenAPI 3.x and Swagger 2.0, rejects others', () => {
    expect(isOpenApi(spec)).toBe(true);
    expect(isOpenApi({ swagger: '2.0', paths: {} })).toBe(true);
    expect(isOpenApi({ info: {}, item: [] })).toBe(false);
    expect(isOpenApi(null)).toBe(false);
  });

  it('maps title + servers[0] to collection name and baseUrl', () => {
    const { collection, baseUrl } = fromOpenApi(spec);
    expect(collection.name).toBe('Pet API');
    expect(baseUrl).toBe('https://api.pets.io/v1');
  });

  it('groups tagged operations into folders, untagged at root', () => {
    const { collection } = fromOpenApi(spec);
    const petsFolder = collection.children.find((c) => c.type === 'folder' && c.name === 'pets');
    expect(petsFolder).toBeTruthy();
    expect(collection.children.some((c) => c.type === 'request' && c.name === 'Health')).toBe(true);
  });

  it('maps query (with default) and header params', () => {
    const { collection } = fromOpenApi(spec);
    const list = findReq(collection.children, 'List pets')!;
    expect(list.request.method).toBe('GET');
    expect(list.request.url).toBe('{{baseUrl}}/pets');
    expect(list.request.params.find((p) => p.key === 'limit')?.value).toBe('10');
    expect(list.request.headers.some((h) => h.key === 'X-Trace')).toBe(true);
  });

  it('resolves $ref request body into a JSON sample with Content-Type', () => {
    const { collection } = fromOpenApi(spec);
    const create = findReq(collection.children, 'createPet')!;
    expect(create.request.method).toBe('POST');
    expect(create.request.body.type).toBe('raw');
    expect(JSON.parse(create.request.body.rawContent)).toEqual({ id: 0, name: 'Rex' });
    expect(create.request.headers.some((h) => h.key === 'Content-Type')).toBe(true);
  });

  it('applies global security and operation-level override', () => {
    const { collection } = fromOpenApi(spec);
    expect(findReq(collection.children, 'List pets')!.request.auth.type).toBe('bearer'); // global
    const create = findReq(collection.children, 'createPet')!;
    expect(create.request.auth.type).toBe('apikey'); // op-level override
    expect(create.request.auth.apiKeyName).toBe('X-Key');
  });

  it('handles an empty / minimal spec without throwing', () => {
    expect(() => fromOpenApi({ openapi: '3.1.0', info: { title: 'Empty' }, paths: {} })).not.toThrow();
    const { collection, baseUrl } = fromOpenApi({ openapi: '3.1.0', paths: {} });
    expect(collection.name).toBe('OpenAPI Import');
    expect(baseUrl).toBe('');
  });
});
