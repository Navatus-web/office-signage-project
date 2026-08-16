const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeTransitionEnabled,
  getPlayerSettingsPayload,
} = require('../lib/transition');

test('normalizeTransitionEnabled handles admin checkbox-style values', () => {
  assert.equal(normalizeTransitionEnabled(true), true);
  assert.equal(normalizeTransitionEnabled(false), false);
  assert.equal(normalizeTransitionEnabled('on'), true);
  assert.equal(normalizeTransitionEnabled('off'), false);
  assert.equal(normalizeTransitionEnabled(''), false);
  assert.equal(normalizeTransitionEnabled(undefined, true), true);
  assert.equal(normalizeTransitionEnabled(undefined, false), false);
});

test('getPlayerSettingsPayload returns the public transition flag', () => {
  assert.deepEqual(getPlayerSettingsPayload({ imageTransitionEnabled: true }), {
    transitionMode: 'fade',
    fadeEnabled: true,
    imageTransitionEnabled: true,
  });

  assert.deepEqual(getPlayerSettingsPayload({}, false), {
    transitionMode: 'none',
    fadeEnabled: false,
    imageTransitionEnabled: false,
  });
});
