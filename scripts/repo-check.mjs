import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';

const root = new URL('..', import.meta.url);
const expected = [
  '.github/dependabot.yml',
  '.github/workflows/ci.yml',
  '.gitignore',
  '.node-version',
  'AGENTS.md',
  'LICENSE',
  'README.md',
  'SECURITY.md',
  'compose.yaml',
  'docs/adr/0001-postgres-conserved-inventory.md',
  'docs/api.md',
  'docs/architecture.md',
  'docs/closed-book-contract.md',
  'docs/operations.md',
  'docs/research-log.md',
  'docs/requirements.md',
  'docs/threat-model.md',
  'docs/verification.md',
  'package-lock.json',
  'package.json',
  'scripts/infra-benchmark.mjs',
  'scripts/infra-smoke.mjs',
  'scripts/repo-check.mjs',
  'sql/schema.sql',
  'src/contracts.js',
  'src/crypto.js',
  'src/errors.js',
  'src/http.js',
  'src/index.js',
  'src/main.js',
  'src/model.js',
  'src/repository.js',
  'src/service.js',
  'test/integration/postgresql.test.js',
  'test/unit/contracts.test.js',
  'test/unit/http.test.js',
  'test/unit/model.test.js',
];

async function walk(directory, prefix = '') {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.tmp') continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) paths.push(...await walk(new URL(`${entry.name}/`, directory), relative));
    else paths.push(relative);
  }
  return paths;
}

for (const path of expected) {
  assert.equal((await stat(new URL(path, root))).isFile(), true, `missing required file: ${path}`);
}

const packageJson = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
assert.equal(packageJson.private, true);
assert.equal(packageJson.engines.node, '>=22');
assert.deepEqual(packageJson.dependencies, { pg: '8.23.0' });
assert.equal(packageJson.repository.url, 'git+https://github.com/estelledc/system-design-22-hotel-reservation.git');
for (const script of ['lint', 'test', 'test:infra', 'smoke:infra', 'benchmark:infra', 'audit', 'check', 'check:ci']) {
  assert.equal(typeof packageJson.scripts[script], 'string', `missing package script: ${script}`);
}
const lock = JSON.parse(await readFile(new URL('package-lock.json', root), 'utf8'));
assert.equal(lock.lockfileVersion, 3);
assert.deepEqual(lock.packages[''].dependencies, packageJson.dependencies);

const workflow = await readFile(new URL('.github/workflows/ci.yml', root), 'utf8');
assert.match(workflow, /node: \[22, 24, 26\]/);
assert.match(workflow, /postgres:17\.11-alpine@sha256:[0-9a-f]{64}/);
assert.match(workflow, /permissions:\n  contents: read/);
const actionUses = [...workflow.matchAll(/uses: [^@\n]+@([^\s#]+)/g)].map((match) => match[1]);
assert.ok(actionUses.length >= 2);
assert.ok(actionUses.every((reference) => /^[0-9a-f]{40}$/.test(reference)), 'actions must use full commit pins');

const compose = await readFile(new URL('compose.yaml', root), 'utf8');
assert.match(compose, /postgres:17\.11-alpine@sha256:[0-9a-f]{64}/);
assert.match(compose, /pg_isready -U postgres -d hotel_reservation/);

const schema = await readFile(new URL('sql/schema.sql', root), 'utf8');
for (const contract of [
  'PRIMARY KEY (property_id, room_type_id, stay_date)',
  'held_units + booked_units + blocked_units <= capacity + oversell_units',
  "state IN ('active', 'converted', 'expired')",
  "state IN ('confirmed', 'cancelled')",
  'PRIMARY KEY (hold_id, stay_date)',
  'PRIMARY KEY (booking_id, stay_date)',
  'PRIMARY KEY (principal, request_key, operation)',
]) assert.ok(schema.includes(contract), `missing schema contract: ${contract}`);

const repository = await readFile(new URL('src/repository.js', root), 'utf8');
for (const contract of [
  'pg_advisory_xact_lock',
  'ORDER BY property_id, room_type_id, stay_date',
  'FOR UPDATE',
  "UPDATE holds SET state = 'expired'",
  'held_units = i.held_units - n.units',
  'booked_units = i.booked_units + n.units',
  'statement_timestamp() AS decision_time',
  'inventoryGap()',
]) assert.ok(repository.includes(contract), `missing repository contract: ${contract}`);

const service = await readFile(new URL('src/service.js', root), 'utf8');
for (const contract of [
  'HOTEL_CRASH_AFTER_HOLD_COMMIT',
  'HOTEL_CRASH_AFTER_BOOKING_COMMIT',
  'HOTEL_CRASH_AFTER_REAP_COMMIT',
  'HOTEL_CRASH_AFTER_CANCEL_COMMIT',
]) assert.ok(service.includes(contract), `missing service crash boundary: ${contract}`);

const logSources = [service, await readFile(new URL('src/http.js', root), 'utf8')];
const logBodies = logSources.flatMap((source) => (
  [...source.matchAll(/(?:this\.)?logger\(\{([\s\S]*?)\}\)/g)].map((match) => match[1])
));
assert.ok(logBodies.length >= 10, 'expected explicit low-cardinality log sites');
for (const body of logBodies) {
  for (const forbiddenField of [
    'propertyId', 'roomTypeId', 'stayDate', 'holdId', 'bookingId', 'queryId', 'workerId',
    'requestKey', 'intentDigest', 'apiToken', 'body', 'authorization', 'path',
  ]) assert.equal(new RegExp(`\\b${forbiddenField}\\s*:`).test(body), false, `ordinary log includes ${forbiddenField}`);
}

const research = await readFile(new URL('docs/research-log.md', root), 'utf8');
for (const pinned of [
  '9d8388721e7231442763ad37398b8d82224aa68f',
  'ab74cdf87d9c0a48d1c18784e45898e890ff5c0e',
  'f1f5a316e0733cff0e60492de6dbbcb12e55151770ce212de02de24d1e4dda52',
  '70cf332f46ff2d0537fe7706a7922fee9f1d8092fe98a8ea05947fe7cc1c769d',
  'dc13a9df72216e8bde3a9b6a4640493a6af8436c2ce7f06023bbce41e06cac44',
  'f5bad0ce59a21e53cf608cf0ff330f3e413d41685bd65a4b470dd54194a8cac3',
  'c7445c4d6768658ad2c7361e50fbee4e8fb4c62ce7d6960e2b8899b816885afa',
  '8839accf8006305a4a5eef28e9580270707ddadc0da254a0ea5715de1f044f6a',
  'd431760660ea44e130f6e919dab216df2d0b3a490567a98089267523368fe1e5',
]) assert.ok(research.includes(pinned), `research log is missing fixed evidence identity: ${pinned}`);

const integration = await readFile(new URL('test/integration/postgresql.test.js', root), 'utf8');
assert.match(integration, /Infrastructure tests never skip/);
assert.doesNotMatch(integration, /\.skip\s*\(/);
const modelTest = await readFile(new URL('test/unit/model.test.js', root), 'utf8');
assert.match(modelTest, /index < 2_000/);
const smoke = await readFile(new URL('scripts/infra-smoke.mjs', root), 'utf8');
assert.match(smoke, /killedProcesses/);
for (const boundary of ['HOLD', 'BOOKING', 'REAP', 'CANCEL']) {
  assert.ok(smoke.includes(`HOTEL_CRASH_AFTER_${boundary}_COMMIT`));
}
assert.match(smoke, /externalAcceptanceProved: state\.externalAcceptanceProved/);
const benchmark = await readFile(new URL('scripts/infra-benchmark.mjs', root), 'utf8');
for (const fixture of ['inventoryDays: 256', 'availabilityQueries: 64', 'finalUnitAttempts: 8']) {
  assert.ok(benchmark.includes(fixture), `benchmark fixture is not fixed: ${fixture}`);
}

const files = await walk(root);
const portable = files.filter((path) => /\.(?:md|js|mjs|json|sql|ya?ml)$/.test(path));
const forbidden = [
  /\/Users\//,
  /\/private\/tmp\//,
  /file:\/\//,
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  new RegExp(['Co', 'Authored-By:'].join('-')),
];
for (const path of portable) {
  const contents = await readFile(new URL(path, root), 'utf8');
  for (const pattern of forbidden) assert.equal(pattern.test(contents), false, `${path} contains forbidden portable data`);
}

for (const path of files.filter((value) => value.endsWith('.md'))) {
  const contents = await readFile(new URL(path, root), 'utf8');
  for (const match of contents.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1].split('#', 1)[0];
    if (!target || /^(?:https?:|mailto:)/.test(target)) continue;
    const resolved = normalize(join(dirname(path), decodeURIComponent(target)));
    assert.equal((await stat(new URL(resolved, root))).isFile(), true, `${path} has broken link: ${target}`);
  }
}

for (const path of files.filter((value) => /\.(?:js|mjs)$/.test(value))) {
  execFileSync(process.execPath, ['--check', path], { cwd: root, stdio: 'inherit' });
}
execFileSync('git', ['diff', '--check'], { cwd: root, stdio: 'inherit' });
process.stdout.write(`${JSON.stringify({
  evidence: 'repository_policy_check',
  files: files.length,
  serviceLogSitesChecked: logBodies.length,
  markdownLinksChecked: true,
  syntaxChecked: true,
})}\n`);
