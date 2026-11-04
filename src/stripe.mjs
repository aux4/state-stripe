import { spawn } from 'node:child_process';

export async function callStripe(request) {
  return new Promise((resolve, reject) => {
    const child = spawn('aux4', ['stripe', 'api', 'request'], { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    const out = [], err = []; let size = 0, settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('community/stripe API request timed out')); }, 90000);
    child.on('error', e => finish(new Error(`Cannot invoke community/stripe: ${e.message}`)));
    child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > 16 * 1024 * 1024) { child.kill('SIGKILL'); finish(new Error('Stripe API response too large')); }
      else out.push(chunk);
    });
    child.stderr.on('data', chunk => { if (Buffer.concat(err).length < 65536) err.push(chunk); });
    child.on('close', code => {
      if (code !== 0) return finish(new Error(`community/stripe failed: ${Buffer.concat(err).toString().trim() || `exit ${code}`}`));
      try {
        const result = JSON.parse(Buffer.concat(out).toString());
        if (!result || !Number.isInteger(result.status) || !Object.hasOwn(result, 'body')) throw new Error('expected status and body');
        finish(null, result);
      } catch (e) { finish(new Error(`Invalid community/stripe response: ${e.message}`)); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}
