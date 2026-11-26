/* The routes openapi.yaml says need a session: every operation that keeps the spec's top-level
   `security` (cookie or bearer) instead of setting its own (`security: []` is public,
   `tokenAuth` a scoped token). openapi-routes.test.js keeps the spec and the route table in step,
   so this list follows every route the server registers. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export function sessionRoutes() {
  const yaml = fs.readFileSync(path.join(API, 'openapi.yaml'), 'utf8');
  const ops = [];
  let inPaths = false, current = null, op = null;
  for (const line of yaml.split('\n')) {
    if (/^paths:/.test(line)) { inPaths = true; continue; }
    if (inPaths && /^[a-zA-Z]/.test(line)) inPaths = false;
    if (!inPaths) continue;
    const p = /^ {2}(\/[^:]*):/.exec(line);
    if (p) { current = p[1]; op = null; continue; }
    const m = /^ {4}(get|post|put|patch|delete):/.exec(line);
    if (m && current) { op = { method: m[1].toUpperCase(), path: current, own: false }; ops.push(op); continue; }
    if (op && /^ {6}security:/.test(line)) op.own = true;
  }
  return ops.filter(o => !o.own).map(({ method, path: p }) => ({ method, path: p }));
}

// Public by design although the spec gives them no `security: []`: the MCP connector's OAuth
// discovery documents and the endpoints an assistant's server calls with the code or client
// credentials in the body (oauth.js). The browser steps (request, approve, deny) need a session.
export const OAUTH_PUBLIC = new Set([
  'GET /.well-known/oauth-authorization-server', 'GET /.well-known/openid-configuration',
  'GET /.well-known/oauth-protected-resource', 'GET /.well-known/oauth-protected-resource/mcp',
  'POST /api/oauth/register', 'GET /api/oauth/authorize', 'POST /api/oauth/token', 'POST /api/oauth/revoke',
]);

// A concrete URL for a templated path, in the shape the dispatcher maps back onto its key.
export const concrete = p => p
  .replace('{hash}', 'a'.repeat(64))
  .replace('{id}', 's_' + 'a'.repeat(16))
  .replace('{uid}', 'u1')
  .replace('{token}', 'ogt_' + 'a'.repeat(43));
