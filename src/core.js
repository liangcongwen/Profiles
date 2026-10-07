'use strict';
// 纯逻辑模块：数据结构、提醒计算、重复规则。不依赖 Electron，便于单元测试。

const REPEATS = ['none', 'daily', 'weekdays', 'weekly', 'monthly', 'yearly'];

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function defaultState() {
  return {
    version: 1,
    categories: [
      { id: 'default', name: '待办', color: '#4a90e2' },
      { id: 'work', name: '工作', color: '#f5a623' },
      { id: 'life', name: '生活', color: '#7ed321' }
    ],
    tasks: [],
    settings: {
      alwaysOnTop: true,
      opacity: 0.95,
      theme: 'blue',
      edgeHide: true,
      autoStart: false,
      sound: true,
      locked: false,
      fontSize: 14,
      hotkey: 'CommandOrControl+Alt+D'
    },
    bounds: null
  };
}

function newTask(fields) {
  const now = Date.now();
  return Object.assign(
    {
      id: uid(),
      text: '',
      note: '',
      categoryId: 'default',
      done: false,
      important: false,
      color: '',
      remindAt: null, // 毫秒时间戳
      repeat: 'none',
      notified: false,
      snoozeUntil: null, // 稍后提醒时间，不改变重复任务的基准时间
      createdAt: now,
      updatedAt: now,
      doneAt: null,
      order: now
    },
    fields || {}
  );
}

// 合并磁盘数据与默认值，保证旧版本/损坏数据也能运行
function normalizeState(raw) {
  const def = defaultState();
  if (!raw || typeof raw !== 'object') return def;
  const state = {
    version: 1,
    categories: Array.isArray(raw.categories) && raw.categories.length ? raw.categories : def.categories,
    tasks: Array.isArray(raw.tasks) ? raw.tasks.filter((t) => t && t.id).map((t) => newTask(t)) : [],
    settings: Object.assign({}, def.settings, raw.settings || {}),
    bounds: raw.bounds || null
  };
  if (!state.categories.some((c) => c.id === 'default')) {
    state.categories.unshift(def.categories[0]);
  }
  const catIds = new Set(state.categories.map((c) => c.id));
  for (const t of state.tasks) {
    if (!catIds.has(t.categoryId)) t.categoryId = 'default';
    if (!REPEATS.includes(t.repeat)) t.repeat = 'none';
  }
  return state;
}

function daysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

// 计算重复提醒的下一次时间（严格晚于 after）
function nextOccurrence(ts, repeat, after) {
  if (!ts || repeat === 'none' || !REPEATS.includes(repeat)) return null;
  const base = new Date(ts);
  const day = base.getDate();
  let d = new Date(ts);
  let n = 0;
  const step = () => {
    n++;
    switch (repeat) {
      case 'daily':
        d = new Date(base);
        d.setDate(base.getDate() + n);
        break;
      case 'weekdays':
        d = new Date(d);
        do {
          d.setDate(d.getDate() + 1);
        } while (d.getDay() === 0 || d.getDay() === 6);
        break;
      case 'weekly':
        d = new Date(base);
        d.setDate(base.getDate() + 7 * n);
        break;
      case 'monthly': {
        const y = base.getFullYear();
        const m = base.getMonth() + n;
        const target = new Date(y, m, 1, base.getHours(), base.getMinutes(), base.getSeconds());
        target.setDate(Math.min(day, daysInMonth(target.getFullYear(), target.getMonth())));
        d = target;
        break;
      }
      case 'yearly': {
        const target = new Date(base.getFullYear() + n, base.getMonth(), 1, base.getHours(), base.getMinutes(), base.getSeconds());
        target.setDate(Math.min(day, daysInMonth(target.getFullYear(), target.getMonth())));
        d = target;
        break;
      }
    }
  };
  step();
  let guard = 0;
  while (d.getTime() <= after && guard++ < 100000) step();
  return d.getTime();
}

// 找出到期需要提醒的任务
function isDue(t, now) {
  if (t.done || !t.remindAt) return false;
  if (t.snoozeUntil && t.snoozeUntil <= now) return true;
  if (!t.notified) return t.remindAt <= now;
  if (t.repeat === 'none') return false;
  const next = nextOccurrence(t.remindAt, t.repeat, t.remindAt);
  return next !== null && next <= now;
}

function dueTasks(state, now) {
  return state.tasks.filter((t) => isDue(t, now));
}

// 标记已提醒：重复任务把 remindAt 推进到 <= now 的最近一次，下一次到点会再次提醒
function markNotified(task, now) {
  if (task.repeat !== 'none' && task.remindAt) {
    let next = nextOccurrence(task.remindAt, task.repeat, task.remindAt);
    while (next !== null && next <= now) {
      task.remindAt = next;
      next = nextOccurrence(task.remindAt, task.repeat, task.remindAt);
    }
  }
  task.notified = true;
  task.snoozeUntil = null;
  task.updatedAt = now;
  return task;
}

// 稍后提醒
function snooze(task, minutes, now) {
  task.snoozeUntil = now + minutes * 60000;
  task.updatedAt = now;
  return task;
}

// 完成任务：重复任务完成后生成下一次（保留历史记录）
function completeTask(state, id, now) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return null;
  t.done = true;
  t.doneAt = now;
  t.updatedAt = now;
  let next = null;
  if (t.repeat !== 'none' && t.remindAt) {
    next = newTask({
      text: t.text,
      note: t.note,
      categoryId: t.categoryId,
      important: t.important,
      color: t.color,
      repeat: t.repeat,
      remindAt: nextOccurrence(t.remindAt, t.repeat, Math.max(now, t.remindAt)),
      order: t.order
    });
    t.repeat = 'none';
    state.tasks.push(next);
  }
  return next;
}

module.exports = {
  REPEATS,
  uid,
  defaultState,
  newTask,
  normalizeState,
  nextOccurrence,
  isDue,
  dueTasks,
  markNotified,
  snooze,
  completeTask
};
