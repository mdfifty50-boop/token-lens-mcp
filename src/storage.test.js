/**
 * Tests for storage.js — in-memory session tracking.
 * Uses node:test and node:assert/strict (no npm deps).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerTool,
  logCall,
  getReport,
  listSessions,
} from './storage.js';

let _uid = 0;
function uid(prefix = 'sess') {
  return `${prefix}_${++_uid}_${Date.now()}`;
}

// ─────────────────────────────────────────────
// registerTool
// ─────────────────────────────────────────────

describe('registerTool', () => {
  test('registers a tool and returns confirmation', () => {
    const sid = uid();
    const result = registerTool(sid, 'read_file', 120);
    assert.equal(result.registered, true);
    assert.equal(result.tool_name, 'read_file');
    assert.equal(result.token_cost, 120);
  });

  test('overwrites token cost if registered twice', () => {
    const sid = uid();
    registerTool(sid, 'search', 100);
    registerTool(sid, 'search', 200);
    const report = getReport(sid);
    assert.equal(report.tools_loaded, 1);
    assert.equal(report.total_loaded_tokens, 200);
  });
});

// ─────────────────────────────────────────────
// logCall
// ─────────────────────────────────────────────

describe('logCall', () => {
  test('logs a call and increments total', () => {
    const sid = uid();
    const r1 = logCall(sid, 'search');
    assert.equal(r1.logged, true);
    assert.equal(r1.total_calls, 1);

    const r2 = logCall(sid, 'search');
    assert.equal(r2.total_calls, 2);
  });
});

// ─────────────────────────────────────────────
// getReport
// ─────────────────────────────────────────────

describe('getReport', () => {
  test('returns correct waste analysis', () => {
    const sid = uid();
    registerTool(sid, 'read_file', 100);
    registerTool(sid, 'write_file', 80);
    registerTool(sid, 'send_email', 150);

    logCall(sid, 'read_file');
    logCall(sid, 'read_file');
    logCall(sid, 'write_file');

    const report = getReport(sid);

    assert.equal(report.tools_loaded, 3);
    assert.equal(report.tools_used, 2);
    assert.equal(report.tools_unused, 1);
    assert.equal(report.total_loaded_tokens, 330);
    assert.equal(report.used_tokens, 180);
    assert.equal(report.wasted_tokens, 150);
    assert.ok(report.waste_percentage > 0);
    assert.equal(report.total_calls, 3);
  });

  test('unused tools are sorted by token cost descending', () => {
    const sid = uid();
    registerTool(sid, 'cheap_tool', 20);
    registerTool(sid, 'expensive_tool', 500);
    registerTool(sid, 'mid_tool', 100);

    const report = getReport(sid);
    assert.equal(report.unused_tools_ranked[0].name, 'expensive_tool');
    assert.equal(report.unused_tools_ranked[1].name, 'mid_tool');
    assert.equal(report.unused_tools_ranked[2].name, 'cheap_tool');
  });

  test('empty session returns zeros', () => {
    const sid = uid();
    const report = getReport(sid);
    assert.equal(report.tools_loaded, 0);
    assert.equal(report.tools_used, 0);
    assert.equal(report.waste_percentage, 0);
    assert.equal(report.total_calls, 0);
  });

  test('call frequency tracks per-tool counts', () => {
    const sid = uid();
    logCall(sid, 'search');
    logCall(sid, 'search');
    logCall(sid, 'search');
    logCall(sid, 'read');

    const report = getReport(sid);
    assert.equal(report.call_frequency.search, 3);
    assert.equal(report.call_frequency.read, 1);
  });

  test('100% waste when no tools are called', () => {
    const sid = uid();
    registerTool(sid, 'tool_a', 100);
    registerTool(sid, 'tool_b', 200);

    const report = getReport(sid);
    assert.equal(report.waste_percentage, 100);
    assert.equal(report.tools_unused, 2);
  });

  test('0% waste when all tools are called', () => {
    const sid = uid();
    registerTool(sid, 'tool_a', 100);
    registerTool(sid, 'tool_b', 200);
    logCall(sid, 'tool_a');
    logCall(sid, 'tool_b');

    const report = getReport(sid);
    assert.equal(report.waste_percentage, 0);
    assert.equal(report.tools_unused, 0);
  });
});

// ─────────────────────────────────────────────
// listSessions
// ─────────────────────────────────────────────

describe('listSessions', () => {
  test('returns sessions that have been created', () => {
    const sid1 = uid('list');
    const sid2 = uid('list');
    registerTool(sid1, 'x', 10);
    logCall(sid2, 'y');

    const sessions = listSessions();
    assert.ok(sessions.includes(sid1));
    assert.ok(sessions.includes(sid2));
  });
});
