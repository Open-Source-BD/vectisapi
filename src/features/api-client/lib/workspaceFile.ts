import type { Collection, EnvVar, Environment, TabState, TreeNode } from '../types';

/**
 * Git-native workspace serialization. Turns the in-memory collections +
 * environments into a set of human-readable, diffable files (one per request,
 * folders mirroring the tree) and back. Stable ids live INSIDE file content,
 * not in filenames, so renames/dupes/illegal chars don't break git history.
 *
 * Lossy by design: formdata `File` bodies cannot be serialized to disk, so they
 * are written as null (the UI surfaces a "file not saved" marker). Round-trip
 * is otherwise lossless.
 */

export interface FileEntry {
  /** POSIX-style relative path within the workspace folder. */
  path: string;
  content: string;
}

export interface WorkspaceData {
  collections: Collection[];
  environments: Environment[];
  globals: EnvVar[];
}

const COLLECTIONS_DIR = 'collections';
const ENV_DIR = 'environments';
const GLOBALS_FILE = `${ENV_DIR}/_globals.json`;
const GLOBALS_SECRET_FILE = `${ENV_DIR}/_globals.secret.json`;
const GITIGNORE = '.gitignore';

/** Heuristic: does this variable key hold a secret that must stay out of git? */
const SECRET_RE = /(token|secret|password|passwd|pwd|api[-_]?key|apikey|auth|bearer|credential)/i;
const isSecret = (key: string): boolean => SECRET_RE.test(key);
const splitVars = (vars: EnvVar[]) => ({
  safe: vars.filter((v) => !isSecret(v.key)),
  secret: vars.filter((v) => isSecret(v.key)),
});

/** Filesystem-safe segment. Order/identity never depend on this (id is in content). */
function sanitize(name: string): string {
  return (name.trim() || 'unnamed')
    .replace(/[/\\:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .slice(0, 80);
}

const pad = (n: number) => String(n).padStart(3, '0');

/** Deep-clone a request, nulling unserializable File bodies. */
function stripFiles(request: TabState): TabState {
  const clone: TabState = JSON.parse(JSON.stringify({ ...request, response: null }));
  clone.body.formdata = clone.body.formdata.map((item) => (item.type === 'file' ? { ...item, file: null } : item));
  return clone;
}

// --- Serialize ---

function serializeNodes(nodes: TreeNode[], dir: string, out: FileEntry[]): void {
  nodes.forEach((node, i) => {
    const base = `${dir}/${pad(i)}__${sanitize(node.name)}`;
    if (node.type === 'request') {
      out.push({
        path: `${base}.json`,
        content: JSON.stringify({ id: node.id, name: node.name, request: stripFiles(node.request) }, null, 2),
      });
    } else {
      out.push({ path: `${base}/_folder.json`, content: JSON.stringify({ id: node.id, name: node.name }, null, 2) });
      serializeNodes(node.children, base, out);
    }
  });
}

export function serializeWorkspace(data: WorkspaceData): FileEntry[] {
  const out: FileEntry[] = [];

  data.collections.forEach((col, ci) => {
    const dir = `${COLLECTIONS_DIR}/${pad(ci)}__${sanitize(col.name)}`;
    out.push({
      path: `${dir}/_collection.json`,
      content: JSON.stringify({ id: col.id, name: col.name, description: col.description ?? '' }, null, 2),
    });
    serializeNodes(col.children, dir, out);
  });

  // Environments: non-secret vars in the versioned file, secrets in a sibling
  // *.secret.json (gitignored) so tokens never land in committed history.
  data.environments.forEach((env, ei) => {
    const { safe, secret } = splitVars(env.vars);
    const stem = `${ENV_DIR}/${pad(ei)}__${sanitize(env.name)}`;
    out.push({ path: `${stem}.json`, content: JSON.stringify({ id: env.id, name: env.name, vars: safe }, null, 2) });
    if (secret.length) {
      out.push({ path: `${stem}.secret.json`, content: JSON.stringify({ id: env.id, vars: secret }, null, 2) });
    }
  });

  const g = splitVars(data.globals);
  out.push({ path: GLOBALS_FILE, content: JSON.stringify(g.safe, null, 2) });
  if (g.secret.length) out.push({ path: GLOBALS_SECRET_FILE, content: JSON.stringify(g.secret, null, 2) });

  out.push({
    path: GITIGNORE,
    content: '# Workspace secrets — keep tokens/keys out of version control.\n*.secret.json\n',
  });

  return out;
}

// --- Deserialize ---

interface DirNode {
  collectionMeta?: { id: string; name: string; description?: string };
  folderMeta?: { id: string; name: string };
  /** child entries directly in this dir: ordering key → {kind, ...} */
  requests: Map<string, { id: string; name: string; request: TabState }>;
  subdirs: Map<string, DirNode>;
}

const newDir = (): DirNode => ({ requests: new Map(), subdirs: new Map() });

function safeParse(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/** Build nodes from a DirNode, ordering by the numeric filename prefix. */
function buildNodes(dir: DirNode): TreeNode[] {
  const entries: { key: string; node: TreeNode }[] = [];

  for (const [key, req] of dir.requests) {
    entries.push({ key, node: { id: req.id, type: 'request', name: req.name, request: req.request } });
  }
  for (const [key, sub] of dir.subdirs) {
    if (!sub.folderMeta) continue;
    entries.push({
      key,
      node: { id: sub.folderMeta.id, type: 'folder', name: sub.folderMeta.name, children: buildNodes(sub) },
    });
  }

  entries.sort((a, b) => a.key.localeCompare(b.key));
  return entries.map((e) => e.node);
}

export function deserializeWorkspace(entries: FileEntry[]): WorkspaceData {
  const collectionsRoot = new Map<string, DirNode>(); // collection dir name → DirNode
  const envMap = new Map<string, Environment>(); // env id → merged env (safe + secret)
  let globalsSafe: EnvVar[] = [];
  let globalsSecret: EnvVar[] = [];

  // First pass: index everything into a dir tree.
  for (const entry of entries) {
    const parts = entry.path.split('/');
    const top = parts[0];

    if (entry.path === GLOBALS_FILE) {
      const parsed = safeParse(entry.content);
      if (Array.isArray(parsed)) globalsSafe = parsed as EnvVar[];
      continue;
    }
    if (entry.path === GLOBALS_SECRET_FILE) {
      const parsed = safeParse(entry.content);
      if (Array.isArray(parsed)) globalsSecret = parsed as EnvVar[];
      continue;
    }
    if (top === ENV_DIR) {
      const parsed = safeParse(entry.content) as { id?: string; name?: string; vars?: EnvVar[] } | null;
      if (parsed && typeof parsed === 'object' && parsed.id) {
        const ex = envMap.get(parsed.id) ?? { id: parsed.id, name: parsed.name ?? 'Environment', vars: [] };
        if (parsed.name) ex.name = parsed.name;
        if (Array.isArray(parsed.vars)) ex.vars = [...ex.vars, ...parsed.vars];
        envMap.set(parsed.id, ex);
      }
      continue;
    }
    if (top !== COLLECTIONS_DIR || parts.length < 2) continue;

    // collections/<colDir>/...rest
    const colDirName = parts[1];
    if (!collectionsRoot.has(colDirName)) collectionsRoot.set(colDirName, newDir());
    let dir = collectionsRoot.get(colDirName)!;
    const rest = parts.slice(2); // path within the collection
    const file = rest[rest.length - 1];

    // Walk/create intermediate folder dirs.
    for (let i = 0; i < rest.length - 1; i++) {
      const seg = rest[i];
      if (!dir.subdirs.has(seg)) dir.subdirs.set(seg, newDir());
      dir = dir.subdirs.get(seg)!;
    }

    const parsed = safeParse(entry.content);
    if (file === '_collection.json') {
      if (parsed && typeof parsed === 'object')
        collectionsRoot.get(colDirName)!.collectionMeta = parsed as DirNode['collectionMeta'];
    } else if (file === '_folder.json') {
      if (parsed && typeof parsed === 'object') dir.folderMeta = parsed as DirNode['folderMeta'];
    } else if (file.endsWith('.json') && parsed && typeof parsed === 'object') {
      const r = parsed as { id: string; name: string; request: TabState };
      dir.requests.set(file, r);
    }
  }

  // Second pass: build collections, ordered by dir name (numeric prefix).
  const collections: Collection[] = [...collectionsRoot.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, dir]) => ({
      id: dir.collectionMeta?.id ?? '',
      name: dir.collectionMeta?.name ?? 'Imported',
      description: dir.collectionMeta?.description,
      children: buildNodes(dir),
      date: new Date(0).toISOString(),
    }))
    .filter((c) => c.id);

  const environments = [...envMap.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { collections, environments, globals: [...globalsSafe, ...globalsSecret] };
}
