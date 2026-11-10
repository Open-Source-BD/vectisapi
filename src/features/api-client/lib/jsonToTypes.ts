export type TypeLang = 'typescript' | 'dart' | 'go' | 'python' | 'rust' | 'kotlin' | 'swift' | 'java' | 'csharp';

export const TYPE_LANGS: { id: TypeLang; label: string }[] = [
  { id: 'typescript', label: 'TypeScript' },
  { id: 'dart', label: 'Dart (Flutter)' },
  { id: 'go', label: 'Go' },
  { id: 'python', label: 'Python' },
  { id: 'rust', label: 'Rust' },
  { id: 'kotlin', label: 'Kotlin' },
  { id: 'swift', label: 'Swift' },
  { id: 'java', label: 'Java' },
  { id: 'csharp', label: 'C#' },
];

type Shape =
  | { t: 'string' | 'integer' | 'number' | 'boolean' | 'null' | 'any' }
  | { t: 'array'; el: Shape }
  | { t: 'object'; name: string; fields: { key: string; node: Shape }[] };

type ObjShape = Extract<Shape, { t: 'object' }>;

const pascal = (s: string): string =>
  s.replace(/(^|[_\s-]+)(\w)/g, (_, __, c: string) => c.toUpperCase()).replace(/[^A-Za-z0-9]/g, '') || 'Field';

const camel = (s: string): string => {
  const p = pascal(s);
  return p.charAt(0).toLowerCase() + p.slice(1);
};

const singular = (s: string): string => (s.length > 1 && s.endsWith('s') ? s.slice(0, -1) : s);

const snake = (s: string): string =>
  s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase();

function infer(value: unknown, nameHint: string, used: Set<string>): Shape {
  if (value === null) return { t: 'null' };
  if (Array.isArray(value)) {
    return { t: 'array', el: value.length ? infer(value[0], singular(nameHint), used) : { t: 'any' } };
  }
  if (typeof value === 'object') {
    let name = pascal(nameHint);
    while (used.has(name)) name += '_';
    used.add(name);
    const fields = Object.entries(value as Record<string, unknown>).map(([key, v]) => ({
      key,
      node: infer(v, key, used),
    }));
    return { t: 'object', name, fields };
  }
  if (typeof value === 'number') return { t: Number.isInteger(value) ? 'integer' : 'number' };
  if (typeof value === 'boolean') return { t: 'boolean' };
  if (typeof value === 'string') return { t: 'string' };
  return { t: 'any' };
}

/** Collect object definitions children-first (so forward refs aren't needed). */
function collect(shape: Shape, out: ObjShape[], seen: Set<string>): void {
  if (shape.t === 'array') collect(shape.el, out, seen);
  else if (shape.t === 'object') {
    shape.fields.forEach((f) => collect(f.node, out, seen));
    if (!seen.has(shape.name)) {
      seen.add(shape.name);
      out.push(shape);
    }
  }
}

const validId = (s: string) => /^[A-Za-z_$][\w$]*$/.test(s);

// --- Per-language emitters ---

function tsType(s: Shape): string {
  switch (s.t) {
    case 'string':
      return 'string';
    case 'integer':
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'any':
      return 'unknown';
    case 'array':
      return `${tsType(s.el)}[]`;
    case 'object':
      return s.name;
  }
}
const emitTs = (defs: ObjShape[]) =>
  defs
    .map(
      (d) =>
        `export interface ${d.name} {\n${d.fields.map((f) => `  ${validId(f.key) ? f.key : `"${f.key}"`}: ${tsType(f.node)};`).join('\n')}\n}`,
    )
    .join('\n\n');

function goType(s: Shape): string {
  switch (s.t) {
    case 'string':
      return 'string';
    case 'integer':
      return 'int';
    case 'number':
      return 'float64';
    case 'boolean':
      return 'bool';
    case 'null':
    case 'any':
      return 'interface{}';
    case 'array':
      return `[]${goType(s.el)}`;
    case 'object':
      return s.name;
  }
}
const emitGo = (defs: ObjShape[]) =>
  defs
    .map(
      (d) =>
        `type ${d.name} struct {\n${d.fields.map((f) => `\t${pascal(f.key)} ${goType(f.node)} \`json:"${f.key}"\``).join('\n')}\n}`,
    )
    .join('\n\n');

function pyType(s: Shape): string {
  switch (s.t) {
    case 'string':
      return 'str';
    case 'integer':
      return 'int';
    case 'number':
      return 'float';
    case 'boolean':
      return 'bool';
    case 'null':
    case 'any':
      return 'Any';
    case 'array':
      return `List[${pyType(s.el)}]`;
    case 'object':
      return s.name;
  }
}
const emitPython = (defs: ObjShape[]) => {
  const header = 'from __future__ import annotations\nfrom typing import Any, List\nfrom pydantic import BaseModel\n';
  const body = defs
    .map(
      (d) =>
        `class ${d.name}(BaseModel):\n${d.fields.map((f) => `    ${/^[A-Za-z_]\w*$/.test(f.key) ? f.key : snake(f.key)}: ${pyType(f.node)}`).join('\n')}`,
    )
    .join('\n\n');
  return `${header}\n${body}`;
};

function rustType(s: Shape): string {
  switch (s.t) {
    case 'string':
      return 'String';
    case 'integer':
      return 'i64';
    case 'number':
      return 'f64';
    case 'boolean':
      return 'bool';
    case 'null':
    case 'any':
      return 'serde_json::Value';
    case 'array':
      return `Vec<${rustType(s.el)}>`;
    case 'object':
      return s.name;
  }
}
const emitRust = (defs: ObjShape[]) => {
  const header = 'use serde::{Deserialize, Serialize};\n';
  const body = defs
    .map((d) => {
      const fields = d.fields
        .map((f) => {
          const name = snake(f.key);
          const rename = name !== f.key ? `    #[serde(rename = "${f.key}")]\n` : '';
          return `${rename}    pub ${name}: ${rustType(f.node)},`;
        })
        .join('\n');
      return `#[derive(Debug, Serialize, Deserialize)]\npub struct ${d.name} {\n${fields}\n}`;
    })
    .join('\n\n');
  return `${header}\n${body}`;
};

function kotlinType(s: Shape): string {
  switch (s.t) {
    case 'string':
      return 'String';
    case 'integer':
      return 'Int';
    case 'number':
      return 'Double';
    case 'boolean':
      return 'Boolean';
    case 'null':
    case 'any':
      return 'Any?';
    case 'array':
      return `List<${kotlinType(s.el)}>`;
    case 'object':
      return s.name;
  }
}
const emitKotlin = (defs: ObjShape[]) =>
  defs
    .map((d) => {
      const fields = d.fields
        .map((f) => {
          const name = camel(f.key);
          const ann = name !== f.key ? `    @SerialName("${f.key}")\n` : '';
          return `${ann}    val ${name}: ${kotlinType(f.node)},`;
        })
        .join('\n');
      return `@Serializable\ndata class ${d.name}(\n${fields}\n)`;
    })
    .join('\n\n');

function swiftType(s: Shape): string {
  switch (s.t) {
    case 'string':
      return 'String';
    case 'integer':
      return 'Int';
    case 'number':
      return 'Double';
    case 'boolean':
      return 'Bool';
    case 'null':
    case 'any':
      return 'String?';
    case 'array':
      return `[${swiftType(s.el)}]`;
    case 'object':
      return s.name;
  }
}
const emitSwift = (defs: ObjShape[]) =>
  defs
    .map(
      (d) =>
        `struct ${d.name}: Codable {\n${d.fields.map((f) => `    let ${camel(f.key)}: ${swiftType(f.node)}`).join('\n')}\n}`,
    )
    .join('\n\n');

function javaType(s: Shape): string {
  switch (s.t) {
    case 'string':
      return 'String';
    case 'integer':
      return 'int';
    case 'number':
      return 'double';
    case 'boolean':
      return 'boolean';
    case 'null':
    case 'any':
      return 'Object';
    case 'array':
      return `List<${boxed(javaType(s.el))}>`;
    case 'object':
      return s.name;
  }
}
const boxed = (t: string) => ({ int: 'Integer', double: 'Double', boolean: 'Boolean' })[t] ?? t;
const emitJava = (defs: ObjShape[]) => {
  const header = 'import java.util.List;\n';
  const body = defs
    .map(
      (d) =>
        `public class ${d.name} {\n${d.fields.map((f) => `    public ${javaType(f.node)} ${camel(f.key)};`).join('\n')}\n}`,
    )
    .join('\n\n');
  return `${header}\n${body}`;
};

function csType(s: Shape): string {
  switch (s.t) {
    case 'string':
      return 'string';
    case 'integer':
      return 'int';
    case 'number':
      return 'double';
    case 'boolean':
      return 'bool';
    case 'null':
    case 'any':
      return 'object';
    case 'array':
      return `List<${csType(s.el)}>`;
    case 'object':
      return s.name;
  }
}
const emitCSharp = (defs: ObjShape[]) => {
  const header = 'using System.Collections.Generic;\nusing System.Text.Json.Serialization;\n';
  const body = defs
    .map((d) => {
      const fields = d.fields
        .map((f) => `    [JsonPropertyName("${f.key}")]\n    public ${csType(f.node)} ${pascal(f.key)} { get; set; }`)
        .join('\n\n');
      return `public class ${d.name}\n{\n${fields}\n}`;
    })
    .join('\n\n');
  return `${header}\n${body}`;
};

// Dart / Flutter — full fromJson + toJson
function dartType(s: Shape): string {
  switch (s.t) {
    case 'string':
      return 'String';
    case 'integer':
      return 'int';
    case 'number':
      return 'double';
    case 'boolean':
      return 'bool';
    case 'null':
    case 'any':
      return 'dynamic';
    case 'array':
      return `List<${dartType(s.el)}>`;
    case 'object':
      return s.name;
  }
}
function dartFromJson(s: Shape, accessor: string): string {
  switch (s.t) {
    case 'object':
      return `${s.name}.fromJson(${accessor} as Map<String, dynamic>)`;
    case 'array':
      if (s.el.t === 'object') return `(${accessor} as List).map((e) => ${dartFromJson(s.el, 'e')}).toList()`;
      if (s.el.t === 'any' || s.el.t === 'null') return `(${accessor} as List)`;
      return `(${accessor} as List).cast<${dartType(s.el)}>()`;
    case 'any':
    case 'null':
      return accessor;
    case 'number':
      return `(${accessor} as num).toDouble()`;
    default:
      return `${accessor} as ${dartType(s)}`;
  }
}
function dartToJson(s: Shape, ref: string): string {
  if (s.t === 'object') return `${ref}.toJson()`;
  if (s.t === 'array' && s.el.t === 'object') return `${ref}.map((e) => e.toJson()).toList()`;
  return ref;
}
const emitDart = (defs: ObjShape[]) =>
  defs
    .map((d) => {
      const fieldNames = d.fields.map((f) => ({ ...f, name: camel(f.key) }));
      const fieldDecls = fieldNames.map((f) => `  final ${dartType(f.node)} ${f.name};`).join('\n');
      const ctorArgs = fieldNames.map((f) => `    required this.${f.name},`).join('\n');
      const fromJson = fieldNames
        .map((f) => `        ${f.name}: ${dartFromJson(f.node, `json['${f.key}']`)},`)
        .join('\n');
      const toJson = fieldNames.map((f) => `        '${f.key}': ${dartToJson(f.node, f.name)},`).join('\n');
      return (
        `class ${d.name} {\n${fieldDecls}\n\n` +
        `  ${d.name}({\n${ctorArgs}\n  });\n\n` +
        `  factory ${d.name}.fromJson(Map<String, dynamic> json) => ${d.name}(\n${fromJson}\n      );\n\n` +
        `  Map<String, dynamic> toJson() => {\n${toJson}\n      };\n}`
      );
    })
    .join('\n\n');

/** Generate type definitions for the parsed JSON value in the chosen language. */
export function generateTypes(value: unknown, lang: TypeLang, rootName = 'Root'): string {
  const shape = infer(value, rootName, new Set());
  if (shape.t !== 'object' && !(shape.t === 'array' && shape.el.t === 'object')) {
    return '// Response is not a JSON object — no named types to generate.';
  }
  const defs: ObjShape[] = [];
  collect(shape, defs, new Set());
  if (!defs.length) return '// No object types found.';

  switch (lang) {
    case 'typescript':
      return emitTs(defs);
    case 'dart':
      return emitDart(defs);
    case 'go':
      return emitGo(defs);
    case 'python':
      return emitPython(defs);
    case 'rust':
      return emitRust(defs);
    case 'kotlin':
      return emitKotlin(defs);
    case 'swift':
      return emitSwift(defs);
    case 'java':
      return emitJava(defs);
    case 'csharp':
      return emitCSharp(defs);
  }
}
