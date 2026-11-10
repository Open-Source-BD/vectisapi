import { describe, expect, it } from 'vitest';
import { importFromDoc } from './importExport';
import type { ExportData } from '../types';

const postmanDoc = {
  info: { name: 'PM Collection', schema: 'https://schema.getpostman.com/collection/v2.1.0/' },
  item: [{ name: 'Req', request: { method: 'GET', url: { raw: 'https://api.test' } } }],
};

const openApiDoc = {
  openapi: '3.1.0',
  info: { title: 'API', version: '1.0' },
  servers: [{ url: 'https://api.example.com' }],
  paths: {
    '/users': {
      get: {
        responses: { '200': { description: 'OK' } },
      },
    },
  },
};

const nativeExport: ExportData = {
  version: 2,
  collections: [
    {
      id: 'c1',
      name: 'Native',
      date: '2026-01-01',
      children: [
        {
          type: 'request',
          id: 'r1',
          name: 'Get Users',
          request: {
            id: 'r1',
            method: 'GET',
            url: 'https://api.test/users',
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
          },
        },
      ],
    },
  ],
  environments: [],
  globals: [],
};

describe('importFromDoc', () => {
  it('detects and imports Postman collection', () => {
    const result = importFromDoc(postmanDoc);
    expect(result.collections).toHaveLength(1);
    expect(result.collections[0].name).toBe('PM Collection');
    expect(result.environments).toHaveLength(0);
  });

  it('detects and imports OpenAPI spec', () => {
    const result = importFromDoc(openApiDoc);
    expect(result.collections).toHaveLength(1);
    expect(result.collections[0].name).toBe('API');
    expect(result.environments).toHaveLength(1);
    expect(result.environments[0].vars).toContainEqual(expect.objectContaining({ key: 'baseUrl' }));
  });

  it('imports native export format', () => {
    const result = importFromDoc(nativeExport);
    expect(result.collections).toHaveLength(1);
    expect(result.collections[0].name).toBe('Native');
    expect(result.collections[0].children).toHaveLength(1);
  });

  it('handles null/undefined gracefully', () => {
    const result = importFromDoc(null);
    expect(result.collections).toHaveLength(0);
    expect(result.environments).toHaveLength(0);
  });

  it('handles empty object gracefully', () => {
    const result = importFromDoc({});
    expect(result.collections).toHaveLength(0);
    expect(result.environments).toHaveLength(0);
  });
});

describe('importFromDoc — environments', () => {
  it('migrates legacy flat EnvVar[] to Environment[]', () => {
    const doc = { ...nativeExport, environments: [{ id: 'e1', key: 'TOKEN', value: 'abc' }] };
    delete (doc as Record<string, unknown>).version;
    const result = importFromDoc(doc);
    expect(result.environments).toHaveLength(1);
    expect(result.environments[0].name).toBe('Imported');
  });

  it('passes through structured Environment[] unchanged', () => {
    const doc = {
      ...nativeExport,
      environments: [{ id: 'e1', name: 'Prod', vars: [{ id: 'v1', key: 'URL', value: 'https://prod' }] }],
      globals: [],
    };
    const result = importFromDoc(doc);
    expect(result.environments).toHaveLength(1);
    expect(result.environments[0].name).toBe('Prod');
  });
});
