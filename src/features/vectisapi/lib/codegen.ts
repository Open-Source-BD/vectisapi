import type { EnvVar, TabState } from '../types';
import { resolveEnv } from './envResolver';

export type CodeLang =
  'curl' | 'fetch' | 'axios' | 'python' | 'go' | 'rust' | 'php' | 'java' | 'kotlin' | 'swift' | 'csharp' | 'ruby';

export const CODE_LANGS: { id: CodeLang; label: string }[] = [
  { id: 'curl', label: 'cURL' },
  { id: 'fetch', label: 'JS — Fetch' },
  { id: 'axios', label: 'JS — Axios' },
  { id: 'python', label: 'Python — requests' },
  { id: 'go', label: 'Go' },
  { id: 'rust', label: 'Rust — reqwest' },
  { id: 'php', label: 'PHP — cURL' },
  { id: 'java', label: 'Java — HttpClient' },
  { id: 'kotlin', label: 'Kotlin — OkHttp' },
  { id: 'swift', label: 'Swift — URLSession' },
  { id: 'csharp', label: 'C# — HttpClient' },
  { id: 'ruby', label: 'Ruby — net/http' },
];

interface ReqModel {
  method: string;
  url: string;
  headers: [string, string][];
  /** Serialized request body, or null when none. */
  body: string | null;
}

const HAS_BODY = ['POST', 'PUT', 'PATCH', 'DELETE'];

/** Resolve env vars + assemble a normalized request (url with query, headers, body). */
function buildModel(tab: TabState, environments: EnvVar[]): ReqModel {
  const r = (s: string) => resolveEnv(s, environments);
  const enc = encodeURIComponent;

  let url = r(tab.url).trim();
  const qs = tab.params
    .filter((p) => p.key)
    .map((p) => `${enc(r(p.key))}=${enc(r(p.value))}`)
    .join('&');
  if (qs) url += (url.includes('?') ? '&' : '?') + qs;

  const headers: [string, string][] = tab.headers.filter((h) => h.key).map((h) => [r(h.key), r(h.value)]);
  const hasHeader = (k: string) => headers.some(([hk]) => hk.toLowerCase() === k.toLowerCase());

  const auth = tab.auth;
  if (auth.type === 'bearer' && auth.bearer) {
    headers.push(['Authorization', `Bearer ${r(auth.bearer)}`]);
  } else if (auth.type === 'basic' && auth.basicUser) {
    const token = typeof btoa !== 'undefined' ? btoa(`${r(auth.basicUser)}:${r(auth.basicPass)}`) : '';
    headers.push(['Authorization', `Basic ${token}`]);
  } else if (auth.type === 'apikey' && auth.apiKeyName) {
    if (auth.apiKeyIn === 'query') {
      url += (url.includes('?') ? '&' : '?') + `${enc(r(auth.apiKeyName))}=${enc(r(auth.apiKeyValue))}`;
    } else {
      headers.push([r(auth.apiKeyName), r(auth.apiKeyValue)]);
    }
  } else if (auth.type === 'oauth2' && auth.oauthToken) {
    headers.push(['Authorization', `Bearer ${r(auth.oauthToken)}`]);
  } else if (auth.type === 'jwt' && auth.jwtToken) {
    const prefix = auth.jwtPrefix?.trim();
    headers.push(['Authorization', prefix ? `${prefix} ${r(auth.jwtToken)}` : r(auth.jwtToken)]);
  }

  let body: string | null = null;
  if (HAS_BODY.includes(tab.method) && tab.body.type !== 'none') {
    if (tab.body.type === 'raw') {
      body = r(tab.body.rawContent);
      if (!hasHeader('content-type')) headers.push(['Content-Type', tab.body.rawType]);
    } else if (tab.body.type === 'urlencoded') {
      body = tab.body.urlencoded
        .filter((u) => u.key)
        .map((u) => `${enc(r(u.key))}=${enc(r(u.value))}`)
        .join('&');
      if (!hasHeader('content-type')) headers.push(['Content-Type', 'application/x-www-form-urlencoded']);
    } else if (tab.body.type === 'formdata') {
      body = tab.body.formdata
        .filter((f) => f.key)
        .map((f) => `${enc(r(f.key))}=${f.type === 'file' ? '<file>' : enc(r(f.value))}`)
        .join('&');
      if (!hasHeader('content-type')) headers.push(['Content-Type', 'application/x-www-form-urlencoded']);
    } else if (tab.body.type === 'graphql') {
      const g = tab.body.graphql ?? { query: '', variables: '' };
      let vars: unknown = {};
      try {
        vars = g.variables.trim() ? JSON.parse(g.variables) : {};
      } catch {
        vars = {};
      }
      body = JSON.stringify({ query: r(g.query), variables: vars });
      if (!hasHeader('content-type')) headers.push(['Content-Type', 'application/json']);
    }
  }

  return { method: tab.method, url, headers, body };
}

// --- escapes ---
const sq = (s: string) => s.replace(/'/g, "'\\''"); // single-quote for shells
const dq = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"'); // double-quote
const tq = (s: string) => s.replace(/`/g, '\\`').replace(/\$/g, '\\$'); // JS template literal

// --- emitters ---

function curl(m: ReqModel): string {
  let out = `curl -X ${m.method} '${sq(m.url)}'`;
  m.headers.forEach(([k, v]) => (out += ` \\\n  -H '${sq(`${k}: ${v}`)}'`));
  if (m.body) out += ` \\\n  -d '${sq(m.body)}'`;
  return out;
}

function fetchJs(m: ReqModel): string {
  const headers = m.headers.map(([k, v]) => `    "${dq(k)}": "${dq(v)}"`).join(',\n');
  const parts = [`  method: "${m.method}"`];
  if (m.headers.length) parts.push(`  headers: {\n${headers}\n  }`);
  if (m.body !== null) parts.push(`  body: \`${tq(m.body)}\``);
  return `fetch("${dq(m.url)}", {\n${parts.join(',\n')}\n})\n  .then((res) => res.json())\n  .then(console.log);`;
}

function axios(m: ReqModel): string {
  const headers = m.headers.map(([k, v]) => `    "${dq(k)}": "${dq(v)}"`).join(',\n');
  const parts = [`  method: "${m.method.toLowerCase()}"`, `  url: "${dq(m.url)}"`];
  if (m.headers.length) parts.push(`  headers: {\n${headers}\n  }`);
  if (m.body !== null) parts.push(`  data: \`${tq(m.body)}\``);
  return `import axios from "axios";\n\naxios({\n${parts.join(',\n')}\n}).then((res) => console.log(res.data));`;
}

function python(m: ReqModel): string {
  const headers = m.headers.map(([k, v]) => `    "${dq(k)}": "${dq(v)}"`).join(',\n');
  let out = 'import requests\n\n';
  out += `url = "${dq(m.url)}"\n`;
  out += m.headers.length ? `headers = {\n${headers}\n}\n` : 'headers = {}\n';
  if (m.body !== null) out += `payload = """${m.body}"""\n`;
  const bodyArg = m.body !== null ? ', data=payload' : '';
  out += `\nresp = requests.request("${m.method}", url, headers=headers${bodyArg})\nprint(resp.json())`;
  return out;
}

function go(m: ReqModel): string {
  let out = 'package main\n\nimport (\n\t"fmt"\n\t"io"\n\t"net/http"\n\t"strings"\n)\n\nfunc main() {\n';
  out += m.body !== null ? `\tpayload := strings.NewReader(\`${m.body}\`)\n` : '\tvar payload io.Reader = nil\n';
  out += `\treq, _ := http.NewRequest("${m.method}", "${dq(m.url)}", payload)\n`;
  m.headers.forEach(([k, v]) => (out += `\treq.Header.Set("${dq(k)}", "${dq(v)}")\n`));
  out +=
    '\tres, _ := http.DefaultClient.Do(req)\n\tdefer res.Body.Close()\n\tbody, _ := io.ReadAll(res.Body)\n\tfmt.Println(string(body))\n}';
  return out;
}

function rust(m: ReqModel): string {
  const method = m.method.charAt(0) + m.method.slice(1).toLowerCase();
  let out =
    'use reqwest::header::HeaderMap;\n\n#[tokio::main]\nasync fn main() -> Result<(), Box<dyn std::error::Error>> {\n';
  out += '    let client = reqwest::Client::new();\n    let mut headers = HeaderMap::new();\n';
  m.headers.forEach(([k, v]) => (out += `    headers.insert("${dq(k)}", "${dq(v)}".parse()?);\n`));
  out += `    let mut req = client.request(reqwest::Method::${m.method}, "${dq(m.url)}").headers(headers);\n`;
  if (m.body !== null) out += `    req = req.body(r#"${m.body}"#);\n`;
  out += '    let res = req.send().await?;\n    println!("{}", res.text().await?);\n    Ok(())\n}';
  void method;
  return out;
}

function php(m: ReqModel): string {
  let out = '<?php\n$ch = curl_init();\n';
  out += `curl_setopt($ch, CURLOPT_URL, "${dq(m.url)}");\n`;
  out += 'curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);\n';
  out += `curl_setopt($ch, CURLOPT_CUSTOMREQUEST, "${m.method}");\n`;
  if (m.headers.length) {
    const hs = m.headers.map(([k, v]) => `    "${dq(`${k}: ${v}`)}"`).join(',\n');
    out += `curl_setopt($ch, CURLOPT_HTTPHEADER, [\n${hs}\n]);\n`;
  }
  if (m.body !== null) out += `curl_setopt($ch, CURLOPT_POSTFIELDS, "${dq(m.body)}");\n`;
  out += '$response = curl_exec($ch);\ncurl_close($ch);\necho $response;';
  return out;
}

function java(m: ReqModel): string {
  const bodyPub =
    m.body !== null ? `HttpRequest.BodyPublishers.ofString("${dq(m.body)}")` : 'HttpRequest.BodyPublishers.noBody()';
  let out = 'import java.net.URI;\nimport java.net.http.*;\n\n';
  out += 'HttpClient client = HttpClient.newHttpClient();\n';
  out += 'HttpRequest request = HttpRequest.newBuilder()\n';
  out += `    .uri(URI.create("${dq(m.url)}"))\n`;
  m.headers.forEach(([k, v]) => (out += `    .header("${dq(k)}", "${dq(v)}")\n`));
  out += `    .method("${m.method}", ${bodyPub})\n    .build();\n\n`;
  out +=
    'HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());\nSystem.out.println(response.body());';
  return out;
}

function kotlin(m: ReqModel): string {
  let out = 'import okhttp3.*\n\nval client = OkHttpClient()\n';
  if (m.body !== null) out += `val body = "${dq(m.body)}".toRequestBody()\n`;
  const bodyArg = m.body !== null ? 'body' : 'null';
  out += 'val request = Request.Builder()\n';
  out += `    .url("${dq(m.url)}")\n`;
  m.headers.forEach(([k, v]) => (out += `    .addHeader("${dq(k)}", "${dq(v)}")\n`));
  out += `    .method("${m.method}", ${bodyArg})\n    .build()\n\n`;
  out += 'client.newCall(request).execute().use { println(it.body?.string()) }';
  return out;
}

function swift(m: ReqModel): string {
  let out = 'import Foundation\n\n';
  out += `var request = URLRequest(url: URL(string: "${dq(m.url)}")!)\n`;
  out += `request.httpMethod = "${m.method}"\n`;
  m.headers.forEach(([k, v]) => (out += `request.addValue("${dq(v)}", forHTTPHeaderField: "${dq(k)}")\n`));
  if (m.body !== null) out += `request.httpBody = "${dq(m.body)}".data(using: .utf8)\n`;
  out +=
    '\nURLSession.shared.dataTask(with: request) { data, _, _ in\n    if let data = data { print(String(data: data, encoding: .utf8) ?? "") }\n}.resume()';
  return out;
}

function csharp(m: ReqModel): string {
  let out = 'using System.Net.Http;\n\nvar client = new HttpClient();\n';
  out += `var request = new HttpRequestMessage(new HttpMethod("${m.method}"), "${dq(m.url)}");\n`;
  if (m.body !== null) out += `request.Content = new StringContent("${dq(m.body)}");\n`;
  m.headers.forEach(([k, v]) => (out += `request.Headers.TryAddWithoutValidation("${dq(k)}", "${dq(v)}");\n`));
  out +=
    '\nvar response = await client.SendAsync(request);\nConsole.WriteLine(await response.Content.ReadAsStringAsync());';
  return out;
}

function ruby(m: ReqModel): string {
  const cls = m.method.charAt(0) + m.method.slice(1).toLowerCase();
  let out = "require 'net/http'\nrequire 'uri'\n\n";
  out += `uri = URI("${dq(m.url)}")\n`;
  out += 'http = Net::HTTP.new(uri.host, uri.port)\nhttp.use_ssl = uri.scheme == "https"\n\n';
  out += `request = Net::HTTP::${cls}.new(uri)\n`;
  m.headers.forEach(([k, v]) => (out += `request["${dq(k)}"] = "${dq(v)}"\n`));
  if (m.body !== null) out += `request.body = "${dq(m.body)}"\n`;
  out += '\nresponse = http.request(request)\nputs response.body';
  return out;
}

const EMITTERS: Record<CodeLang, (m: ReqModel) => string> = {
  curl,
  fetch: fetchJs,
  axios,
  python,
  go,
  rust,
  php,
  java,
  kotlin,
  swift,
  csharp,
  ruby,
};

/** Generate an API-call snippet for the request in the chosen language. */
export function generateCode(tab: TabState, environments: EnvVar[], lang: CodeLang = 'curl'): string {
  return EMITTERS[lang](buildModel(tab, environments));
}
