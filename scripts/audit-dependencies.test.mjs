import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessAudits, parseAudit } from './audit-dependencies.mjs';

const advisory = (severity = 'high', id = 'GHSA-dev-only-test') => ({
  severity,
  module_name: 'test-package',
  title: 'Test advisory',
  url: `https://github.com/advisories/${id}`,
});
function result(
  advisories = {},
  status = 0,
  counts = { high: Object.keys(advisories).length },
) {
  return {
    status,
    stdout: JSON.stringify({
      advisories,
      metadata: {
        vulnerabilities: {
          info: 0,
          low: 0,
          moderate: 0,
          critical: 0,
          ...counts,
        },
      },
    }),
  };
}

test('development-only high findings remain visible but do not block', () => {
  const prod = parseAudit(result(), 'production');
  const full = parseAudit(result({ one: advisory() }, 1), 'all');
  const assessed = assessAudits(prod, full);
  assert.equal(assessed.development.length, 1);
  assert.equal(assessed.blocking.length, 0);
});

test('production high and critical findings block even if a tool incorrectly exits zero', () => {
  for (const severity of ['high', 'critical']) {
    const report = parseAudit(
      result({ one: advisory(severity) }),
      'production',
    );
    assert.equal(assessAudits(report, report).blocking.length, 1);
  }
});

test('production lower-severity findings are visible and non-blocking', () => {
  const report = parseAudit(
    result({ one: advisory('moderate') }),
    'production',
  );
  assert.equal(assessAudits(report, report).blocking.length, 0);
});

test('an advisory present in production and dev is classified as production', () => {
  const report = parseAudit(result({ one: advisory() }, 1), 'production');
  assert.equal(assessAudits(report, report).development.length, 0);
});

test('registry, process and malformed-result failures cannot become informational warnings', () => {
  for (const invalid of [
    { status: null, stdout: '', error: new Error('timeout') },
    { status: 2, stdout: '{}' },
    { status: 1, stdout: 'not JSON' },
    {
      status: 1,
      stdout: JSON.stringify({
        error: { code: 'ERR_PNPM_AUDIT_BAD_RESPONSE' },
      }),
    },
    result({}, 1),
    {
      status: 0,
      stdout: JSON.stringify({
        advisories: {},
        metadata: { vulnerabilities: {} },
      }),
    },
    result({ one: { severity: 'high' } }, 1),
    {
      status: 0,
      stdout: JSON.stringify({
        advisories: {},
        metadata: { vulnerabilities: { high: -1 } },
      }),
    },
  ]) {
    assert.throws(() => parseAudit(invalid, 'audit'));
  }
});

test('pre-existing configured exclusions are disclosed instead of called zero findings', () => {
  const report = parseAudit(result({}, 0, { high: 1 }), 'production');
  assert.equal(report.configuredExclusions, 1);
});
