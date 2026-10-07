'use strict';
const test = require('node:test');
const assert = require('node:assert');
const core = require('../src/core');

const at = (y, mo, d, h = 9, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

test('nextOccurrence: 每天 / 每周 / 每月月末 / 工作日', () => {
  assert.strictEqual(core.nextOccurrence(at(2026, 10, 7), 'daily', at(2026, 10, 7)), at(2026, 10, 8));
  assert.strictEqual(core.nextOccurrence(at(2026, 10, 7), 'daily', at(2026, 10, 20, 12)), at(2026, 10, 21));
  assert.strictEqual(core.nextOccurrence(at(2026, 10, 7), 'weekly', at(2026, 10, 7)), at(2026, 10, 14));
  // 1 月 31 日每月重复 -> 2 月 28 日 -> 3 月 31 日
  assert.strictEqual(core.nextOccurrence(at(2026, 1, 31), 'monthly', at(2026, 1, 31)), at(2026, 2, 28));
  assert.strictEqual(core.nextOccurrence(at(2026, 1, 31), 'monthly', at(2026, 2, 28)), at(2026, 3, 31));
  // 周五 -> 下周一
  assert.strictEqual(core.nextOccurrence(at(2026, 10, 9), 'weekdays', at(2026, 10, 9)), at(2026, 10, 12));
  assert.strictEqual(core.nextOccurrence(at(2024, 2, 29), 'yearly', at(2024, 2, 29)), at(2025, 2, 28));
  assert.strictEqual(core.nextOccurrence(at(2026, 10, 7), 'none', 0), null);
});

test('普通提醒只触发一次', () => {
  const s = core.defaultState();
  const t = core.newTask({ text: 'a', remindAt: at(2026, 10, 7, 9) });
  s.tasks.push(t);
  assert.deepStrictEqual(core.dueTasks(s, at(2026, 10, 7, 8)), []);
  assert.strictEqual(core.dueTasks(s, at(2026, 10, 7, 9)).length, 1);
  core.markNotified(t, at(2026, 10, 7, 9));
  assert.strictEqual(core.dueTasks(s, at(2026, 10, 9)).length, 0);
});

test('重复提醒每次到点都会触发，基准时间不漂移', () => {
  const s = core.defaultState();
  const t = core.newTask({ text: 'a', remindAt: at(2026, 10, 7, 9), repeat: 'daily' });
  s.tasks.push(t);
  core.markNotified(t, at(2026, 10, 7, 9, 0));
  assert.strictEqual(core.dueTasks(s, at(2026, 10, 7, 23)).length, 0);
  assert.strictEqual(core.dueTasks(s, at(2026, 10, 8, 9)).length, 1);
  // 关机两天后再开：只提醒一次，并推进到最近一次
  core.markNotified(t, at(2026, 10, 10, 15));
  assert.strictEqual(t.remindAt, at(2026, 10, 10, 9));
  assert.strictEqual(core.dueTasks(s, at(2026, 10, 10, 16)).length, 0);
});

test('稍后提醒不改变重复任务的基准时间', () => {
  const s = core.defaultState();
  const t = core.newTask({ text: 'a', remindAt: at(2026, 10, 7, 9), repeat: 'daily' });
  s.tasks.push(t);
  core.markNotified(t, at(2026, 10, 7, 9));
  core.snooze(t, 10, at(2026, 10, 7, 9, 1));
  assert.strictEqual(core.dueTasks(s, at(2026, 10, 7, 9, 5)).length, 0);
  assert.strictEqual(core.dueTasks(s, at(2026, 10, 7, 9, 11)).length, 1);
  core.markNotified(t, at(2026, 10, 7, 9, 11));
  assert.strictEqual(t.remindAt, at(2026, 10, 7, 9));
  assert.strictEqual(t.snoozeUntil, null);
});

test('完成重复任务会生成下一次', () => {
  const s = core.defaultState();
  const t = core.newTask({ text: '周报', remindAt: at(2026, 10, 9, 17), repeat: 'weekly' });
  s.tasks.push(t);
  // 提醒前提前完成：下一次是下周
  const next = core.completeTask(s, t.id, at(2026, 10, 9, 10));
  assert.ok(t.done);
  assert.strictEqual(next.remindAt, at(2026, 10, 16, 17));
  assert.strictEqual(next.repeat, 'weekly');
  assert.strictEqual(next.done, false);
  assert.strictEqual(s.tasks.length, 2);
  // 普通任务完成不生成新任务
  const p = core.newTask({ text: 'x' });
  s.tasks.push(p);
  assert.strictEqual(core.completeTask(s, p.id, Date.now()), null);
});

test('normalizeState 兼容损坏或缺字段的数据', () => {
  const s = core.normalizeState({ tasks: [{ id: '1', text: 'a', categoryId: 'gone', repeat: 'bad' }, null], settings: { opacity: 0.5 } });
  assert.strictEqual(s.tasks.length, 1);
  assert.strictEqual(s.tasks[0].categoryId, 'default');
  assert.strictEqual(s.tasks[0].repeat, 'none');
  assert.strictEqual(s.settings.opacity, 0.5);
  assert.strictEqual(s.settings.alwaysOnTop, true);
  assert.deepStrictEqual(core.normalizeState('garbage'), core.defaultState());
});
