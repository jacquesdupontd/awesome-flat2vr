import { test } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadPorts, ROOT } from '../scripts/lib.mjs';

const fx = (name: string) => join(ROOT, 'test/fixtures', name);

test('real ports/ directory is valid', () => {
  const { ports, errors } = loadPorts();
  assert.deepEqual(errors, []);
  assert.ok(ports.length > 0);
});

test('valid fixture passes', () => {
  const { ports, errors } = loadPorts(fx('valid'));
  assert.deepEqual(errors, []);
  assert.equal(ports.length, 1);
});

test('malformed fixture fails with field-level errors', () => {
  const { errors } = loadPorts(fx('malformed'));
  const text = errors.join('\n');
  assert.match(text, /must have required property 'download_url'/);
  assert.match(text, /\/status must be equal to one of the allowed values/);
  assert.match(text, /\/version must be string/);
  assert.match(text, /must NOT have additional properties 'rating'/);
  assert.match(text, /bad_Name\.yml: filename must be/);
});

test('an entry without an image for each game fails', () => {
  const { errors } = loadPorts(fx('noimage'));
  assert.match(errors.join('\n'), /no image for game 'Outer Wilds'/);
});
