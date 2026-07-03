const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeSystemHealth } = require('../lib/health');

test('summarizeSystemHealth returns readable status details', () => {
  const snapshot = summarizeSystemHealth({
    uptimeMs: 65000,
    connectedPlayers: 2,
    playlistCount: 5,
    mediaCount: 7,
    playlistVersion: 3,
    paused: true,
    lastReloadReason: 'pause',
  });

  assert.equal(snapshot.status, 'paused');
  assert.equal(snapshot.connectedPlayers, 2);
  assert.equal(snapshot.playlistCount, 5);
  assert.equal(snapshot.mediaCount, 7);
  assert.equal(snapshot.playlistVersion, 3);
  assert.equal(snapshot.lastReloadReason, 'pause');
  assert.equal(snapshot.uptimeText, '1m 5s');
});
