// Copies non-TypeScript build assets (e.g. versioned prompt files) next to the compiled output.
//   node ../../scripts/copy-assets.mjs <srcDir> <outDir>   (paths relative to the calling package)
import { cpSync } from 'node:fs';
import { resolve } from 'node:path';

const [from, to] = process.argv.slice(2);
if (!from || !to) {
  console.error('usage: node scripts/copy-assets.mjs <srcDir> <outDir>');
  process.exit(2);
}
cpSync(resolve(from), resolve(to), {
  recursive: true,
  filter: (path) => !/\.ts$/.test(path),
});
console.log(`copy-assets: ${from} -> ${to}`);
