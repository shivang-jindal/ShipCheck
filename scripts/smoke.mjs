#!/usr/bin/env node
/**
 * Post-migration smoke test (Part A / A8 "include a smoke test after deployment").
 *
 * Signs in with the seeded demo account and walks the primary journey:
 * login -> dashboard -> shipments -> exceptions -> carriers -> analytics.
 * Exits non-zero on the first failure.
 *
 * The checks here deliberately assert that ShipCheck tells the truth: no
 * carrier reports a connection, notifications never claim delivery, and every
 * metric agrees with the records behind it.
 *
 * Usage: node scripts/smoke.mjs [baseUrl]
 */

const baseUrl = process.argv[2] ?? process.env.SMOKE_API_URL ?? 'http://localhost:4000';
const email = process.env.SEED_EMAIL ?? 'demo@shipcheck.test';
const password = process.env.SEED_PASSWORD ?? 'shipcheck-demo-1234';

let cookie = '';

function recordCookie(response) {
  const setCookie = response.headers.getSetCookie?.() ?? [];
  for (const entry of setCookie) {
    const [pair] = entry.split(';');
    if (pair?.startsWith('shipcheck_session=')) cookie = pair;
  }
}

async function call(method, path, body) {
  const response = await fetch(`${baseUrl}/api/v1${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  recordCookie(response);
  const text = await response.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: response.status, json };
}

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${label}${detail ? ` - ${detail}` : ''}`);
  } else {
    console.error(`  FAIL ${label}${detail ? ` - ${detail}` : ''}`);
    process.exitCode = 1;
  }
}

const ready = await fetch(`${baseUrl}/api/v1/health/ready`).then((r) => r.json());
check('health/ready', ready.status === 'ready', JSON.stringify(ready.checks));

const login = await call('POST', '/auth/login', { email, password });
check('auth/login', login.status === 200 && Boolean(login.json?.user?.id), login.json?.error?.message ?? '');

const orgId = login.json?.memberships?.[0]?.organizationId;
check('session has an organization', Boolean(orgId));
if (!orgId) process.exit(1);

// --- Dashboard -------------------------------------------------------------
const dashboard = await call('GET', `/${orgId}/dashboard`);
check('dashboard', dashboard.status === 200, dashboard.json?.error?.message ?? '');

const statusTotal = Object.values(dashboard.json?.counts ?? {}).reduce((sum, n) => sum + n, 0);
check(
  'dashboard status counts agree with the total',
  dashboard.status === 200 && statusTotal === dashboard.json?.totals,
  `sum=${statusTotal} total=${dashboard.json?.totals}`,
);

const carrierTotal = (dashboard.json?.carrierBreakdown ?? []).reduce((sum, row) => sum + row.count, 0);
check(
  'dashboard carrier breakdown agrees with the total',
  carrierTotal === dashboard.json?.totals,
  `carriers=${carrierTotal} total=${dashboard.json?.totals}`,
);

// --- Shipments -------------------------------------------------------------
const shipments = await call('GET', `/${orgId}/shipments?pageSize=50`);
check('shipment list', shipments.status === 200 && Array.isArray(shipments.json?.items));
const first = shipments.json?.items?.[0];
check('shipment row has a derived status', Boolean(first?.derivedStatus), first?.derivedStatus);

const detail = await call('GET', `/${orgId}/shipments/${first.id}`);
check('shipment detail', detail.status === 200);
check(
  'every event declares its source',
  (detail.json?.events ?? []).every((event) =>
    ['carrier', 'manual', 'import'].includes(event.source),
  ),
  JSON.stringify((detail.json?.events ?? []).map((event) => event.source)),
);

// --- Exceptions ------------------------------------------------------------
const exceptions = await call('GET', `/${orgId}/exceptions?status=all`);
check(
  'exception list',
  exceptions.status === 200 && Array.isArray(exceptions.json?.items),
  `count=${exceptions.json?.items?.length ?? 0}`,
);

// --- Honesty ---------------------------------------------------------------
const carriers = await call('GET', `/${orgId}/integrations/carriers`);
const integrations = carriers.json?.integrations ?? [];
check(
  'no carrier claims a connection',
  carriers.status === 200 &&
    integrations.length > 0 &&
    integrations.every((item) => item.implemented === false && item.status !== 'configured'),
  JSON.stringify(integrations.slice(0, 2).map((item) => `${item.carrierCode}:${item.status}`)),
);

const notifications = await call('GET', `/${orgId}/settings/notifications`);
check(
  'notifications never claim delivery',
  /never claims/i.test(notifications.json?.note ?? ''),
  `provider=${notifications.json?.email?.provider}`,
);

const report = await call('GET', `/${orgId}/reports/delivery`);
check('delivery report', report.status === 200);
check(
  'analytics states its own limitations',
  (report.json?.warnings ?? []).length > 0,
  `warnings=${report.json?.warnings?.length ?? 0}`,
);

// --- Input handling --------------------------------------------------------
const badId = await call('GET', `/${orgId}/shipments/not-a-uuid`);
check('malformed id is rejected with 400', badId.status === 400, `status=${badId.status}`);

const badOrg = await call('GET', '/not-a-uuid/shipments');
check('malformed workspace id is rejected with 400', badOrg.status === 400, `status=${badOrg.status}`);

const badToken = await (await fetch(`${baseUrl}/api/v1/public/tracking/${'A'.repeat(40)}`)).json();
check('unknown public token is a 404', badToken?.error?.code === 'NOT_FOUND');

console.log(process.exitCode ? '\nSmoke test FAILED' : '\nSmoke test passed');