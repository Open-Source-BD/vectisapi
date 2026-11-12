import type { Collection } from './collection';
import type { Environment, EnvVar } from './env';

export interface ExportData {
  collections: Collection[];
  environments: Environment[];
  globals?: EnvVar[];
  version: number;
}

// --- Postman Collection v2.1 (subset we map to/from) ---

export interface PostmanHeader {
  key: string;
  value: string;
  disabled?: boolean;
}

export interface PostmanUrl {
  raw: string;
}

export interface PostmanAuth {
  type: 'bearer' | 'basic' | 'noauth';
  bearer?: { key: string; value: string }[];
  basic?: { key: string; value: string }[];
}

export interface PostmanBody {
  mode?: 'raw' | 'urlencoded' | 'formdata';
  raw?: string;
  urlencoded?: { key: string; value: string; disabled?: boolean }[];
  formdata?: { key: string; value?: string; type?: 'text' | 'file'; disabled?: boolean }[];
  options?: { raw?: { language?: string } };
}

export interface PostmanRequest {
  method?: string;
  header?: PostmanHeader[];
  url?: PostmanUrl | string;
  auth?: PostmanAuth;
  body?: PostmanBody;
}

export interface PostmanEvent {
  listen: 'prerequest' | 'test';
  script: { exec: string[]; type?: string };
}

export interface PostmanItem {
  name: string;
  item?: PostmanItem[];
  request?: PostmanRequest;
  event?: PostmanEvent[];
}

export interface PostmanCollection {
  info: { name: string; schema: string; _postman_id?: string };
  item: PostmanItem[];
}
