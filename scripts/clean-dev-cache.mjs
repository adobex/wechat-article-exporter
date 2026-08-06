import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

for (const relativePath of ['.nuxt', 'node_modules/.vite', 'node_modules/.cache']) {
  rmSync(resolve(process.cwd(), relativePath), { recursive: true, force: true });
}
