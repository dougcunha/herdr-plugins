'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseWorkflowInputs,
  WorkflowInputError,
} = require('../src/workflow-inputs');

test('parses every supported input type with defaults and metadata', () => {
  const source = `
name: Release
on:
  workflow_dispatch:
    inputs:
      version:
        description: Version to release
        type: string
        required: true
      channel:
        description: Release channel
        type: choice
        options:
          - stable
          - beta
        default: beta
      dry_run:
        description: Do not publish
        type: boolean
        default: true
      retries:
        description: Retry count
        type: number
        default: 3
      environment:
        description: Target environment
        type: environment
        default: staging
`;

  const parsed = parseWorkflowInputs(source);

  assert.equal(parsed.dispatchable, true);
  assert.equal(parsed.name, 'Release');
  assert.deepEqual(parsed.warnings, []);
  assert.equal(parsed.inputs.length, 5);

  const byName = Object.fromEntries(parsed.inputs.map((input) => [input.name, input]));
  assert.deepEqual(byName.version, {
    name: 'version',
    type: 'string',
    description: 'Version to release',
    required: true,
    default: '',
    options: [],
  });
  assert.equal(byName.channel.type, 'choice');
  assert.deepEqual(byName.channel.options, ['stable', 'beta']);
  assert.equal(byName.channel.default, 'beta');
  assert.equal(byName.dry_run.default, 'true');
  assert.equal(byName.retries.default, '3');
  assert.equal(byName.environment.type, 'environment');
  assert.equal(byName.environment.default, 'staging');
});

test('accepts workflow_dispatch as a string trigger without inputs', () => {
  const parsed = parseWorkflowInputs('name: Smoke\non: workflow_dispatch\n');

  assert.equal(parsed.dispatchable, true);
  assert.deepEqual(parsed.inputs, []);
  assert.equal(parsed.name, 'Smoke');
});

test('accepts workflow_dispatch inside a trigger array', () => {
  const parsed = parseWorkflowInputs('on: [push, workflow_dispatch]\n');

  assert.equal(parsed.dispatchable, true);
  assert.deepEqual(parsed.inputs, []);
});

test('reports workflows without a workflow_dispatch trigger', () => {
  const parsed = parseWorkflowInputs('on:\n  push:\n    branches: [main]\n');

  assert.equal(parsed.dispatchable, false);
  assert.deepEqual(parsed.inputs, []);
});

test('uses false, 0 and empty string as implicit defaults', () => {
  const parsed = parseWorkflowInputs(`
on:
  workflow_dispatch:
    inputs:
      flag:
        type: boolean
      count:
        type: number
      label:
        type: string
`);

  const values = Object.fromEntries(
    parsed.inputs.map((input) => [input.name, input.default]),
  );
  assert.deepEqual(values, { flag: 'false', count: '0', label: '' });
});

test('treats a boolean default written as a YAML boolean', () => {
  const parsed = parseWorkflowInputs(`
on:
  workflow_dispatch:
    inputs:
      flag:
        type: boolean
        default: false
`);

  assert.equal(parsed.inputs[0].default, 'false');
});

test('warns about unknown input types and falls back to string', () => {
  const parsed = parseWorkflowInputs(`
on:
  workflow_dispatch:
    inputs:
      color:
        type: color
`);

  assert.equal(parsed.inputs[0].type, 'string');
  assert.match(parsed.warnings[0], /unknown type "color"/);
});

test('warns about a choice without options', () => {
  const parsed = parseWorkflowInputs(`
on:
  workflow_dispatch:
    inputs:
      channel:
        type: choice
`);

  assert.deepEqual(parsed.inputs[0].options, []);
  assert.match(parsed.warnings[0], /choice without options/);
});

test('falls back to the first option when the default is invalid', () => {
  const parsed = parseWorkflowInputs(`
on:
  workflow_dispatch:
    inputs:
      channel:
        type: choice
        options: [stable, beta]
        default: nightly
`);

  assert.equal(parsed.inputs[0].default, 'stable');
  assert.match(parsed.warnings[0], /not one of its options/);
});

test('warns and coerces inputs that are not mappings', () => {
  const parsed = parseWorkflowInputs(`
on:
  workflow_dispatch:
    inputs:
      loose: enabled
`);

  assert.equal(parsed.inputs[0].type, 'string');
  assert.equal(parsed.inputs[0].default, '');
  assert.match(parsed.warnings[0], /not a mapping/);
});

test('warns when more than 25 inputs are declared', () => {
  const fields = Array.from({ length: 26 }, (_, index) => `      input_${index}:\n        type: string`);
  const parsed = parseWorkflowInputs(`
on:
  workflow_dispatch:
    inputs:
${fields.join('\n')}
`);

  assert.equal(parsed.inputs.length, 26);
  assert.match(parsed.warnings[0], /at most 25/);
});

test('rejects invalid YAML', () => {
  assert.throws(
    () => parseWorkflowInputs('on: [\n'),
    (error) => error instanceof WorkflowInputError && /Could not parse/.test(error.message),
  );
});

test('rejects YAML that is not a mapping', () => {
  assert.throws(
    () => parseWorkflowInputs('- one\n- two\n'),
    (error) =>
      error instanceof WorkflowInputError && /not a YAML mapping/.test(error.message),
  );
});
