import { describe, expect, it } from 'vitest';
import { generateTypes } from './jsonToTypes';

const sample = { userId: 1, id: 1, title: 'delectus aut autem', completed: false };
const nested = { id: 1, owner: { name: 'a', age: 2 }, tags: ['x'] };

describe('generateTypes', () => {
  it('TypeScript: maps primitives', () => {
    const out = generateTypes(sample, 'typescript');
    expect(out).toContain('export interface Root {');
    expect(out).toContain('userId: number;');
    expect(out).toContain('title: string;');
    expect(out).toContain('completed: boolean;');
  });

  it('Go: struct with json tags + PascalCase', () => {
    const out = generateTypes(sample, 'go');
    expect(out).toContain('type Root struct {');
    expect(out).toContain('UserId int `json:"userId"`');
  });

  it('Python: pydantic BaseModel', () => {
    const out = generateTypes(sample, 'python');
    expect(out).toContain('class Root(BaseModel):');
    expect(out).toContain('userId: int');
  });

  it('Rust: serde struct with rename for camelCase', () => {
    const out = generateTypes(sample, 'rust');
    expect(out).toContain('pub struct Root {');
    expect(out).toContain('#[serde(rename = "userId")]');
    expect(out).toContain('pub user_id: i64,');
  });

  it('nested objects emit child types first', () => {
    const out = generateTypes(nested, 'typescript');
    expect(out.indexOf('interface Owner')).toBeLessThan(out.indexOf('interface Root'));
    expect(out).toContain('owner: Owner;');
    expect(out).toContain('tags: string[];');
  });

  it('non-object returns a comment', () => {
    expect(generateTypes(42, 'typescript')).toContain('not a JSON object');
  });

  it('Dart (Flutter): class with fromJson/toJson', () => {
    const out = generateTypes(sample, 'dart');
    expect(out).toContain('class Root {');
    expect(out).toContain('factory Root.fromJson(Map<String, dynamic> json)');
    expect(out).toContain("userId: json['userId'] as int,");
    expect(out).toContain('Map<String, dynamic> toJson()');
  });

  it('Dart: nested object + list use recursive fromJson', () => {
    const out = generateTypes(nested, 'dart');
    expect(out).toContain("owner: Owner.fromJson(json['owner'] as Map<String, dynamic>)");
    expect(out).toContain("tags: (json['tags'] as List).cast<String>()");
  });

  it('Kotlin: data class', () => {
    expect(generateTypes(sample, 'kotlin')).toContain('data class Root(');
  });

  it('Swift: Codable struct', () => {
    expect(generateTypes(sample, 'swift')).toContain('struct Root: Codable {');
  });

  it('Java: class with List import', () => {
    const out = generateTypes(nested, 'java');
    expect(out).toContain('import java.util.List;');
    expect(out).toContain('public class Root {');
  });

  it('C#: class with JsonPropertyName', () => {
    const out = generateTypes(sample, 'csharp');
    expect(out).toContain('public class Root');
    expect(out).toContain('[JsonPropertyName("userId")]');
    expect(out).toContain('public int UserId { get; set; }');
  });
});
