#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const dotenvExpand = require('dotenv-expand');

dotenvExpand.expand(dotenv.config({ quiet: true }));

function csv(name) {
  return String(process.env[name] || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function isWeakSecret(value) {
  const text = String(value || '').trim();
  if (!text) return true;
  if (text.length < 40) return true;
  if (new Set(text).size < 5) return true;
  return [
    'dev-secret',
    'dev-internal-secret',
    'change-me',
    'password',
  ].includes(text);
}

function isHttpsOrigin(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && Boolean(parsed.host);
  } catch {
    return false;
  }
}

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail });
}

const production =
  String(process.env.NODE_ENV || '').toLowerCase() === 'production';
const origins = csv('ORIGINS');

check(
  'NODE_ENV production',
  production,
  production
    ? 'production mode is active'
    : 'set NODE_ENV=production for production',
);
check(
  'ORIGINS configured',
  origins.length > 0,
  `${origins.length} origin(s) configured`,
);
check(
  'ORIGINS HTTPS only',
  origins.length > 0 &&
    origins.every((origin) => origin !== '*' && isHttpsOrigin(origin)),
  'production origins must be exact HTTPS origins and must not include wildcard',
);

for (const key of ['DJANGO_INTROSPECT_URL', 'MONGODB_URI', 'REDIS_URL']) {
  check(
    `${key} configured`,
    Boolean(String(process.env[key] || '').trim()),
    `${key} presence checked`,
  );
}

for (const key of ['DJANGO_INTERNAL_TOKEN', 'DJANGO_JWT_SECRET']) {
  check(
    `${key} strong`,
    !isWeakSecret(process.env[key]),
    `${key} strength checked without printing value`,
  );
}

check(
  'DJANGO_TLS_INSECURE disabled',
  process.env.DJANGO_TLS_INSECURE !== '1',
  'must not be enabled in production',
);
check(
  'Internal signatures required',
  String(process.env.INTERNAL_SIGNATURE_REQUIRED || '').toLowerCase() ===
    'true' || process.env.INTERNAL_SIGNATURE_REQUIRED === '1',
  'set INTERNAL_SIGNATURE_REQUIRED=1 in production to reject token-only internal calls',
);
const internalSkew = Number(
  process.env.INTERNAL_SIGNATURE_MAX_SKEW_SECONDS || 300,
);
check(
  'Internal signature timestamp window',
  Number.isFinite(internalSkew) && internalSkew >= 30 && internalSkew <= 300,
  `INTERNAL_SIGNATURE_MAX_SKEW_SECONDS=${process.env.INTERNAL_SIGNATURE_MAX_SKEW_SECONDS || '300'}`,
);

const root = process.cwd();
const mainTs = fs.readFileSync(path.join(root, 'src/main.ts'), 'utf8');
const gatewayTs = fs.readFileSync(
  path.join(root, 'src/realtime/chat.gateway.ts'),
  'utf8',
);
const originPolicyTs = fs.readFileSync(
  path.join(root, 'src/security/origin-policy.ts'),
  'utf8',
);
const internalGuardTs = fs.readFileSync(
  path.join(root, 'src/auth/internal-auth.guard.ts'),
  'utf8',
);

check(
  'HTTP CORS origin delegate wired',
  mainTs.includes('fastifyCorsOriginDelegate'),
  'main.ts should use the shared origin delegate',
);
check(
  'Socket.IO CORS origin delegate wired',
  gatewayTs.includes('socketIoCorsOriginDelegate'),
  'chat.gateway.ts should use the shared origin delegate',
);
check(
  'Production origin policy denies unknown origins',
  originPolicyTs.includes('isProductionRuntime()') &&
    originPolicyTs.includes('return false'),
  'production origin policy should deny non-configured origins',
);
check(
  'Internal auth guard verifies signatures',
  internalGuardTs.includes('verifyInternalSignature') &&
    internalGuardTs.includes('internalSignaturesRequired'),
  'internal endpoints should verify HMAC signatures with timestamp and nonce',
);

const width = Math.max(...checks.map((item) => item.name.length));
for (const item of checks) {
  const status = item.ok ? 'PASS' : 'FAIL';
  console.log(`${status.padEnd(4)} ${item.name.padEnd(width)}  ${item.detail}`);
}

const failures = checks.filter((item) => !item.ok);
console.log('');
console.log(
  `Summary: ${checks.length - failures.length}/${checks.length} checks passing.`,
);
if (failures.length > 0) {
  process.exitCode = 1;
}
