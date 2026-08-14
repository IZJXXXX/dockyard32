const assert = require('node:assert/strict');
const test = require('node:test');

const {
  parseCommandProgress,
  programmerProgressFromOutput,
  scaleProgress,
} = require('../out/ui/progress.js');

test('parses CMake and Make percentage output', () => {
  assert.equal(parseCommandProgress('[ 42%] Building C object main.c.o\n'), 42);
  assert.equal(parseCommandProgress('Download in Progress: 73%\r'), 73);
});

test('parses Ninja completed and total output', () => {
  assert.equal(parseCommandProgress('[15/20] Linking C executable app.elf\n'), 75);
});

test('uses the latest progress value in a chunk and clamps it', () => {
  assert.equal(parseCommandProgress('[ 10%] A\n[ 110%] B\n'), 100);
  assert.equal(parseCommandProgress('ordinary compiler output'), undefined);
});

test('maps programmer download and verify output to stable stages', () => {
  assert.deepEqual(
    programmerProgressFromOutput('Download in Progress: 50%', true),
    { stage: 'flashing', percent: 54 },
  );
  assert.deepEqual(
    programmerProgressFromOutput('File verification: 50%', true),
    { stage: 'verifying', percent: 89 },
  );
  assert.deepEqual(
    programmerProgressFromOutput('Verification successful', true),
    { stage: 'verifying', percent: 88 },
  );
});

test('scales child progress into an operation stage', () => {
  assert.equal(scaleProgress(50, 10, 60), 40);
});
