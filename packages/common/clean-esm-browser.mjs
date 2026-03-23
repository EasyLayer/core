// /**
//  * clean-esm-browser.mjs — place in the root of packages/common/
//  *
//  * Removes dist/esm/browser/ from all subpackages after rollup build.
//  * Run after yarn build:browser.
//  *
//  * Usage: node clean-esm-browser.mjs
//  */

// import { readdirSync, existsSync, statSync, rmSync } from 'fs';

// const subpackages = readdirSync('.').filter((name) => {
//   if (!statSync(name).isDirectory()) return false;
//   if (!existsSync(`./${name}/package.json`)) return false;
//   return true;
// });

// for (const pkg of subpackages) {
//   const dir = `./${pkg}/dist/esm/browser`;
//   if (existsSync(dir)) {
//     rmSync(dir, { recursive: true, force: true });
//     console.log(`cleaned: ${dir}`);
//   }
// }
