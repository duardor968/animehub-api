import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const blockingSeverities = new Set(['high', 'critical']);
const severities = new Set(['info', 'low', 'moderate', 'high', 'critical']);

export function parseAudit(result, scope) {
  if (result.error || ![0, 1].includes(result.status)) {
    throw new Error(
      `${scope} audit could not run (process or registry failure).`,
    );
  }
  let document;
  try {
    document = JSON.parse(result.stdout);
  } catch {
    throw new Error(`${scope} audit returned invalid JSON.`);
  }
  if (
    document?.error ||
    !document?.advisories ||
    Array.isArray(document.advisories) ||
    !document?.metadata?.vulnerabilities ||
    ![...severities].every((severity) => {
      const count = document.metadata.vulnerabilities[severity];
      return Number.isInteger(count) && count >= 0;
    })
  ) {
    throw new Error(`${scope} audit returned an incomplete or failed report.`);
  }
  const advisories = Object.entries(document.advisories).map(([key, value]) => {
    if (
      !value ||
      !severities.has(value.severity) ||
      typeof value.module_name !== 'string' ||
      typeof value.title !== 'string' ||
      typeof value.url !== 'string'
    ) {
      throw new Error(`${scope} audit returned an invalid advisory.`);
    }
    return {
      id: value.url.match(/GHSA-[a-z0-9-]+/i)?.[0] ?? key,
      severity: value.severity,
      module: value.module_name,
      title: value.title,
      url: value.url,
    };
  });
  if (
    result.status === 1 &&
    !advisories.some((advisory) => blockingSeverities.has(advisory.severity))
  ) {
    // Do not turn a registry error or unexpected pnpm failure into a green
    // "development warning" merely because the command exited nonzero.
    throw new Error(
      `${scope} audit failed without a high/critical advisory report.`,
    );
  }
  const reported = Object.values(document.metadata.vulnerabilities).reduce(
    (total, count) => total + count,
    0,
  );
  return {
    scope,
    advisories,
    configuredExclusions: Math.max(0, reported - advisories.length),
  };
}

export function assessAudits(production, all) {
  const productionIds = new Set(production.advisories.map((entry) => entry.id));
  return {
    blocking: production.advisories.filter((entry) =>
      blockingSeverities.has(entry.severity),
    ),
    development: all.advisories.filter((entry) => !productionIds.has(entry.id)),
  };
}

function runAudit(production) {
  const pnpm = process.env.npm_execpath;
  if (!pnpm) throw new Error('Run this check with pnpm audit:ci.');
  return spawnSync(
    process.execPath,
    [
      pnpm,
      'audit',
      ...(production ? ['--prod'] : []),
      '--audit-level',
      'high',
      '--json',
    ],
    { encoding: 'utf8', timeout: 90_000, maxBuffer: 20 * 1024 * 1024 },
  );
}

const safeLine = (value) => String(value).replace(/[\r\n\x00-\x1f]/g, ' ');
const annotation = (level, message) => {
  const safe = safeLine(message);
  console.log(
    process.env.GITHUB_ACTIONS
      ? `::${level}::${safe.replaceAll('%', '%25')}`
      : `${level.toUpperCase()}: ${safe}`,
  );
};

export function main(run = runAudit) {
  const reports = {};
  let operationalFailure = false;
  for (const [scope, production] of [
    ['production', true],
    ['all dependencies', false],
  ]) {
    try {
      const report = parseAudit(run(production), scope);
      reports[production ? 'production' : 'all'] = report;
      console.log(
        `${scope}: ${report.advisories.length} reported advisory/advisories.`,
      );
      if (report.configuredExclusions) {
        annotation(
          'warning',
          `${scope}: ${report.configuredExclusions} pre-existing configured exclusion(s) remain in pnpm-workspace.yaml. They are not a claim of zero vulnerabilities.`,
        );
      }
      for (const entry of report.advisories) {
        const level =
          production && blockingSeverities.has(entry.severity)
            ? 'error'
            : 'warning';
        annotation(
          level,
          `${production ? 'Production' : 'Full audit'}: ${entry.severity} ${entry.module}, ${entry.id}: ${entry.title} (${entry.url})`,
        );
      }
    } catch (error) {
      operationalFailure = true;
      annotation(
        'error',
        error instanceof Error ? error.message : 'Dependency audit failed.',
      );
    }
  }
  if (operationalFailure || !reports.production || !reports.all) return 1;
  const assessment = assessAudits(reports.production, reports.all);
  console.log(
    `Development-only advisories: ${assessment.development.length} (informational).`,
  );
  console.log(
    `Blocking production high/critical advisories: ${assessment.blocking.length}.`,
  );
  return assessment.blocking.length ? 1 : 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = main();
}
