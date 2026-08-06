import { spawnSync } from 'node:child_process';

const result = spawnSync('yarn', ['audit', '--groups', 'dependencies', '--json'], {
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
});

const summaryLine = result.stdout
  .split(/\r?\n/)
  .filter(Boolean)
  .map(line => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  })
  .find(entry => entry?.type === 'auditSummary');

if (!summaryLine) {
  process.stderr.write(result.stderr || 'Dependency audit did not return a summary.\n');
  process.exit(2);
}

const vulnerabilities = summaryLine.data.vulnerabilities;
process.stdout.write(`${JSON.stringify(vulnerabilities)}\n`);

const blockingCount = vulnerabilities.high + vulnerabilities.critical;
if (blockingCount > 0) {
  process.stderr.write(
    `Dependency audit found ${vulnerabilities.high} high and ${vulnerabilities.critical} critical vulnerabilities.\n`
  );
  process.exit(1);
}
