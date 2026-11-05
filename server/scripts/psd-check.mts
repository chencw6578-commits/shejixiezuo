import { createRequire } from 'node:module';
const r = createRequire(import.meta.url);
const PSD = r('psd');
console.log('psd.js loaded, fromBuffer:', typeof PSD.fromBuffer);
