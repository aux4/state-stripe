import { handle } from './provider.mjs';
try {
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 16 * 1024 * 1024) throw new Error('Provider request too large');
    chunks.push(chunk);
  }
  console.log(JSON.stringify(await handle(JSON.parse(Buffer.concat(chunks).toString())), null, 2));
} catch (error) { console.error(`Error: ${error.message}`); process.exitCode = 1; }
