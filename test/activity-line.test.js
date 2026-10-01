'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const herdr = require('../lib/herdr');
const state = require('../lib/state');
const managed = require('../lib/managed-config');
const palette = require('../lib/palette');
const { Frame } = require('../lib/frame');

const entry = { pane: 'w:p1', workspace: 'w', tab: 't', name: 'codex', title: 'Task' };

function captureReports(t) {
  const reports = [];
  t.mock.method(herdr, 'reportMetadataAsync', async (pane, source, tokens) => {
    reports.push({ pane, source, tokens });
    assert.equal('activity' in tokens, false, 'Radar must not write the producer-owned token');
    assert.ok(Object.keys(tokens).length <= 16, 'metadata reports must respect Herdr’s token limit');
    return true;
  });
  return reports;
}

async function publish(frame, activity, indent = state.INDENT, display = 'idle') {
  const jobs = [];
  frame.paneJobs(
    { ...entry, activity },
    display,
    {
      tabs: new Map(),
      keys: { minuteKey: () => '000000000001', wsKeys: new Map(), tabKeys: new Map() },
      indent,
      spinStep: 0,
    },
    0,
    [],
    jobs,
  );
  await Promise.all(jobs);
}

test('snapshot reads string activity from pane tokens and preserves held state', async (t) => {
  t.mock.method(herdr, 'agentsAsync', async () => [
    { pane_id: entry.pane, agent_status: 'idle', tokens: { activity: 'Running tests', state_done: '✓' } },
  ]);
  const [snapshot] = await state.snapshot();
  assert.equal(snapshot.activity, 'Running tests');
  assert.equal(snapshot.showing, 'done');
});

test('snapshot treats absent or non-string activity as empty', async (t) => {
  for (const tokens of [undefined, null, 'invalid', {}, { activity: null }, { activity: 42 }, { activity: {} }]) {
    t.mock.method(herdr, 'agentsAsync', async () => [{ pane_id: entry.pane, agent_status: 'idle', tokens }]);
    assert.equal((await state.snapshot())[0].activity, '');
  }
});

test('activity uses Radar’s calculated indent at every depth, with or without a split corner', () => {
  for (const indent of state.INDENTS) {
    for (const corner of ['', '└']) {
      const line = state.composeLine(entry, 'idle', '', indent, 0, corner);
      assert.equal(line.activityPrefix, indent);
      const tokens = state.stateTokens('idle', line, entry.title, 'Running integration tests');
      assert.equal(tokens.activity_line, indent + 'Running integration tests');
      assert.equal('activity' in tokens, false);
      assert.equal(state.stateTokens('idle', line, entry.title, '').activity_line, null);
      assert.equal(state.stateTokens('idle', line, entry.title).activity_line, null);
    }
  }
});

test('an activity-only change is published, unchanged activity is skipped, and removal clears it', async (t) => {
  const reports = captureReports(t);
  const frame = new Frame('test');
  await publish(frame, 'Running tests');
  assert.equal(frame.lastTokens.get(entry.pane).activity_line, state.INDENT + 'Running tests');

  reports.length = 0;
  await publish(frame, 'Checking results');
  assert.deepEqual(
    reports.map((report) => report.tokens),
    [{ activity_line: state.INDENT + 'Checking results' }],
  );

  reports.length = 0;
  await publish(frame, 'Checking results');
  assert.deepEqual(reports, []);

  await publish(frame, '');
  assert.deepEqual(
    reports.map((report) => report.tokens),
    [{ activity_line: null }],
  );
});

test('activity follows indentation changes even when its text stays the same', async (t) => {
  const reports = captureReports(t);
  const frame = new Frame('test');
  await publish(frame, 'Running tests', state.INDENT);
  reports.length = 0;
  await publish(frame, 'Running tests', state.CHILD_INDENT);
  assert.equal(
    reports.find((report) => 'activity_line' in report.tokens).tokens.activity_line,
    state.CHILD_INDENT + 'Running tests',
  );
});

test('the first frame clears activity left by an earlier daemon when no activity is reported', async (t) => {
  const reports = captureReports(t);
  await publish(new Frame('test'), undefined);
  assert.equal(reports.find((report) => 'activity_line' in report.tokens).tokens.activity_line, null);
});

test('a state with no renderable line clears the activity row', async (t) => {
  const reports = captureReports(t);
  const frame = new Frame('test');
  await publish(frame, 'Running tests');
  reports.length = 0;
  await publish(frame, 'Running tests', state.INDENT, 'not-a-state');
  assert.equal(reports.find((report) => 'activity_line' in report.tokens).tokens.activity_line, null);
});

test('clearState clears activity_line without touching activity', async (t) => {
  const reports = captureReports(t);
  assert.equal(await state.clearState('test', entry.pane), true);
  assert.equal(reports.find((report) => 'activity_line' in report.tokens).tokens.activity_line, null);
});

test('orphan sweeping owns activity_line but leaves producer activity alone', async (t) => {
  const reports = captureReports(t);
  assert.ok(state.OWNED_TOKENS.includes('activity_line'));
  assert.equal(state.OWNED_TOKENS.includes('activity'), false);
  t.mock.method(herdr, 'panesAsync', async () => [
    { pane_id: 'orphan', tokens: { activity_line: 'Old activity', activity: 'Producer activity' } },
    { pane_id: 'producer-only', tokens: { activity: 'Producer activity' } },
    { pane_id: entry.pane, tokens: { activity_line: 'Live activity' } },
  ]);
  assert.equal(await state.sweepOrphans('test', new Set([entry.pane])), true);
  assert.ok(reports.length > 0);
  assert.ok(reports.every((report) => report.pane === 'orphan' && report.source === 'test'));
  assert.equal(reports.find((report) => 'activity_line' in report.tokens).tokens.activity_line, null);
});

test('only the dedicated pi layout renders activity_line between the main row and gap', (t) => {
  const readdir = fs.readdirSync;
  const vendors = Object.keys(palette.brand).filter((vendor) => vendor !== 'other');
  t.mock.method(fs, 'readdirSync', (directory, ...args) =>
    String(directory).endsWith(path.join('agent-detection', 'remote'))
      ? vendors.map((vendor) => `${vendor}.toml`)
      : readdir(directory, ...args),
  );
  for (const variant of ['light', 'dark']) {
    const block = managed.sidebarBlock(variant);
    const rows = block.split('\n').filter((line) => /^(rows|[a-z_]+) = \[.*\$title_working/.test(line));
    assert.equal(rows.length, vendors.length + 1);
    for (const row of rows) {
      assert.equal(row.includes('"$activity"'), false);
      if (row.startsWith('pi = ')) {
        assert.equal((row.match(/\$activity_line/g) ?? []).length, 1);
        assert.ok(row.includes(`[{ token = "$activity_line", fg = "${palette.stateFor(variant).idleStale}"`));
        assert.ok(row.indexOf('$title_unknown') < row.indexOf('$activity_line'));
        assert.ok(row.indexOf('$activity_line') < row.indexOf('$gap'));
        const withoutActivity = row.replace(/, \[\{ token = "\$activity_line"[^}]*\}\]/, '');
        const generic = rows.find((line) => line.startsWith('rows = '));
        assert.equal(withoutActivity.slice('pi = '.length), generic.slice('rows = '.length));
      } else {
        assert.equal(row.includes('$activity_line'), false, 'generic and other vendor layouts stay unchanged');
      }
    }
  }
});
