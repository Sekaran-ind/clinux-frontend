// Copies LHC-Forms (Angular Elements + Zone.js) out of the `lforms` npm package into
// public/vendor/lforms/, where index.html loads them — this is the equivalent of what a CDN
// <script src> tag gave clinixflow, sourced from the local npm dependency instead. Re-run
// automatically on every `npm install` via the postinstall hook, so bumping the `lforms` version
// keeps these in sync without a manual copy step.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const destDir = join(root, 'public', 'vendor', 'lforms');
mkdirSync(destDir, { recursive: true });

// v43's npm package ships the Angular CLI build unconcatenated (separate runtime/polyfills/main
// chunks) rather than the single self-contained lhc-forms.js the CDN historically served for
// v42 — all of these must load, in this order, before the app boots, or LForms' internal
// classes throw ("Class extends value undefined") because their base classes haven't run yet.
const files = [
  ['node_modules/lforms/dist/lforms/webcomponent/assets/lib/zone.min.js', 'zone.min.js'],
  ['node_modules/lforms/dist/lforms/webcomponent/runtime.js', 'runtime.js'],
  ['node_modules/lforms/dist/lforms/webcomponent/polyfills.js', 'polyfills.js'],
  ['node_modules/lforms/dist/lforms/webcomponent/main.js', 'main.js'],
  ['node_modules/lforms/dist/lforms/webcomponent/lhc-forms.js', 'lhc-forms.js'],
  ['node_modules/lforms/dist/lforms/fhir/R4/lformsFHIR.min.js', 'lformsFHIR.min.js'],
  ['node_modules/lforms/dist/lforms/webcomponent/styles.css', 'styles.css'],
];

for (const [src, destName] of files) {
  copyFileSync(join(root, src), join(destDir, destName));
}

console.log(`Vendored ${files.length} LHC-Forms bundles into public/vendor/lforms/`);
