import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('.', import.meta.url));
await build({ absWorkingDir: root, entryPoints: [fileURLToPath(new URL('./src/main.ts', import.meta.url))], outfile: 'main.js', bundle: true,
  tsconfigRaw: { compilerOptions: { target: 'ES2022' } },
  platform: 'browser', format: 'cjs', target: 'es2022', external: ['obsidian'],
  sourcemap: false, minify: false, legalComments: 'eof' });
