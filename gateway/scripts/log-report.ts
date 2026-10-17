// Usage (from gateway/): node --import tsx scripts/log-report.ts metrics|silence < /tmp/gateway.log
import { readFileSync } from 'node:fs';
import { analyzeSilence, parseLogLines, summarizeReplyMetrics } from '../src/eval/logReport.ts';

const mode = process.argv[2] ?? 'metrics';
const lines = parseLogLines(readFileSync(0, 'utf8'));
if (mode === 'metrics') process.stdout.write(`${JSON.stringify(summarizeReplyMetrics(lines), null, 2)}\n`);
else if (mode === 'silence') process.stdout.write(`${JSON.stringify(analyzeSilence(lines), null, 2)}\n`);
else {
  process.stderr.write('usage: log-report.ts metrics|silence < gateway.log\n');
  process.exit(2);
}
