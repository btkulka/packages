// Marks a package's dist/cjs as CommonJS. Packages here are "type": "module",
// so without this marker Node would read dist/cjs/*.js as ESM.
import { mkdirSync, writeFileSync } from "node:fs";

mkdirSync("dist/cjs", { recursive: true });
writeFileSync("dist/cjs/package.json", '{ "type": "commonjs" }\n');
