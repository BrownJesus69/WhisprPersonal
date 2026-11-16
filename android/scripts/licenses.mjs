import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const licenses = await Promise.all(Object.keys(app.dependencies).sort().map(async name => {
  const pkg = JSON.parse(await readFile(path.join(root, 'node_modules', name, 'package.json'), 'utf8'));
  const value = pkg.license;
  const license = typeof value === 'string' ? value : value?.type;
  if (!license) throw new Error(`No license field for ${name}; inspect its licence before generating.`);
  return { name, license };
}));
await mkdir(path.join(root, 'src', 'generated'), { recursive: true });
await writeFile(path.join(root, 'src', 'generated', 'licenses.json'), JSON.stringify(licenses, null, 2) + '\n');
