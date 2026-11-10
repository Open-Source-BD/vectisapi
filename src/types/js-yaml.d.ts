// Minimal ambient types for js-yaml (no @types/js-yaml installed). Only the
// surface we use — safe YAML parsing for OpenAPI import.
declare module 'js-yaml' {
  export function load(input: string): unknown;
}
