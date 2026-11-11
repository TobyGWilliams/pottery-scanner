// Writes js/version.js with a build number and time. Run `npm run stamp` before
// committing so the homepage shows which version is deployed.
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const n = Number(execSync('git rev-list --count HEAD').toString().trim()) + 1;
const when = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
const version = `build ${n} · ${when}`;
writeFileSync(new URL('../js/version.js', import.meta.url), `// Written by scripts/stamp-version.mjs. Do not edit by hand.\nexport const VERSION = '${version}';\n`);
console.log(version);
