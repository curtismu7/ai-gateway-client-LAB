// The vendored shared/verify-mark files (VerifyMark.jsx, VerifyMark.css) match their pin files byte for byte. They come from
// curtismu7/AI-DEMO-Standalone shared/verify-mark: change them there, re-pin, re-vendor; never edit them here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components');

// The canonical hashes (AI-DEMO-Standalone shared/verify-mark, #238). A re-vendor updates these and the pin files together.
const CANONICAL = {
  'VerifyMark.jsx': '81c2532041c5a65aaf762e55c56e889df09dfde5811fc5cc788897ca8712c130',
  'VerifyMark.css': '4774585cd47c3affc739d3d99fa6843d62f607d8d3e69b4438de756ac3d49dc5',
};

test('the vendored verify-mark matches VerifyMark.sha256 and VerifyMark.css.sha256, and the canonical hashes', () => {
  for (const [file, pinFile] of [['VerifyMark.jsx', 'VerifyMark.sha256'], ['VerifyMark.css', 'VerifyMark.css.sha256']]) {
    const [hash, name] = readFileSync(join(dir, pinFile), 'utf8').trim().split(/\s+/);
    assert.equal(name, file, pinFile);
    const actual = createHash('sha256').update(readFileSync(join(dir, file))).digest('hex');
    assert.equal(actual, hash, `${file} differs from ${pinFile} (edited copy?)`);
    assert.equal(actual, CANONICAL[file], `${file} differs from the canonical shared/verify-mark`);
  }
});
