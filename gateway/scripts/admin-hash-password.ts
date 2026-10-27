// Usage (from repo root): npm run admin:hash-password -w gateway
// Prints only the encoded hash on stdout; put it in ADMIN_PASSWORD_HASH. Prompts go to stderr.
import { hashPassword } from '../src/admin/password.ts';

const MIN_CHARS = 12;

async function readPiped(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

/** Raw-mode read so the password is never echoed. */
function readHidden(prompt: string): Promise<string> {
  const stdin = process.stdin;
  // Raw mode first: typing must never echo, even if input arrives right after the prompt.
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  process.stderr.write(prompt);
  return new Promise((resolve, reject) => {
    let value = '';
    const done = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write('\n');
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') { done(); resolve(value); return; }
        if (ch === '\u0003') { done(); reject(new Error('cancelled')); return; }
        if (ch === '\u007f' || ch === '\b') { value = value.slice(0, -1); continue; }
        value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function main(): Promise<void> {
  let password: string;
  if (process.stdin.isTTY) {
    password = await readHidden('后台密码（至少 12 个字符）：');
    const again = await readHidden('再输入一次：');
    if (password !== again) {
      process.stderr.write('两次输入不一致。\n');
      process.exit(1);
    }
  } else {
    password = await readPiped();
  }
  if ([...password].length < MIN_CHARS) {
    process.stderr.write(`密码至少需要 ${MIN_CHARS} 个字符。\n`);
    process.exit(1);
  }
  process.stdout.write(`${await hashPassword(password)}\n`);
}

main().catch(() => {
  process.stderr.write('没有生成哈希。\n');
  process.exit(1);
});
