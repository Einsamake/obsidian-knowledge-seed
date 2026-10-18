import { mkdir, copyFile, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const version = JSON.parse(await readFile('manifest.json', 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid release version');
const destination = resolve('dist/knowledge-seed');
await mkdir(destination, { recursive: true });
for (const name of ['main.js', 'manifest.json', 'styles.css', 'README.md', 'CHANGELOG.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md'])
  await copyFile(name, resolve(destination, name));
for (const name of ['docs/usage.md', 'docs/validation-0.14.3.md', 'docs/validation-0.14.2.md', 'docs/verification.md', 'docs/parsing-quality.md', 'docs/validation-1.4.1.md', 'docs/validation-1.4.2.md', 'tests/fixtures/NOTICE.md']) {
  const target = resolve(destination, name);
  await mkdir(resolve(target, '..'), { recursive: true });
  await copyFile(name, target);
}
const licenses = [];
for (const dependency of ['defuddle', 'mathml-to-latex']) {
  const directory = resolve('node_modules', dependency);
  for (const name of (await readdir(directory)).filter(name => /^license(?:\..*)?$/i.test(name)))
    licenses.push(`=== ${dependency}/${name} ===\n${await readFile(resolve(directory, name), 'utf8')}`);
}
if (licenses.length < 2) throw new Error('Dependency license files are missing');
await writeFile(resolve(destination, 'DEPENDENCY-LICENSES.txt'), licenses.join('\n\n'));
console.log(`Knowledge Seed ${version}: ${destination}`);
console.log('Install main.js, manifest.json and styles.css into .obsidian/plugins/knowledge-seed/; keep existing data.json.');
