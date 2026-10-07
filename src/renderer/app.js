'use strict';
/* global api, parseTime */

const $ = (id) => document.getElementById(id);
const THEMES = [
  ['blue', '#4a90e2'],
  ['green', '#5aac44'],
  ['pink', '#e66b94'],
  ['yellow', '#f2c230'],
  ['purple', '#7e57c2'],
  ['dark', '#1b1d21']
];
const REPEAT_LABEL = { none: '', daily: '每天', weekdays: '工作日', weekly: '每周', monthly: '每月', yearly: '每年' };
const WEEK = '日一二三四五六';

let state = null;
let tab = 'all'; // 'all' | 分类 id | 'done'
let query = '';
let inlineEditing = false;
let pendingRender = false;
let editingId = null; // 编辑面板中的任务 id，null 表示新建
let dragId = null;

// ---------------- 工具 ----------------
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function pad(n) {
  return String(n).padStart(2, '0');
}
function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function fmtTime(ts) {
  const d = new Date(ts);
  const hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
  const diff = Math.round((startOfDay(ts) - startOfDay(Date.now())) / 86400000);
  if (diff === 0) return '今天 ' + hm;
  if (diff === 1) return '明天 ' + hm;
  if (diff === 2) return '后天 ' + hm;
  if (diff === -1) return '昨天 ' + hm;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return (sameYear ? '' : d.getFullYear() + '年') + (d.getMonth() + 1) + '月' + d.getDate() + '日 周' + WEEK[d.getDay()] + ' ' + hm;
}
function fmtDay(ts) {
  const diff = Math.round((startOfDay(ts) - startOfDay(Date.now())) / 86400000);
  if (diff === 0) return '今天';
  if (diff === -1) return '昨天';
  const d = new Date(ts);
  return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日 周' + WEEK[d.getDay()];
}
function toLocalInput(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
function fromLocalInput(v) {
  if (!v) return null;
  const t = new Date(v).getTime();
  return isNaN(t) ? null : t;
}
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function catById(id) {
  return state.categories.find((c) => c.id === id) || state.categories[0];
}

let toastTimer = null;
function toast(msg, undo) {
  const t = $('toast');
  t.innerHTML = '';
  t.appendChild(el('span', '', msg));
  if (undo) {
    const b = el('button', '', '撤销');
    b.onclick = () => {
      undo();
      t.classList.add('hidden');
    };
    t.appendChild(b);
  }
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 4000);
}

// ---------------- 数据操作 ----------------
function persist() {
  api.setTasks(state.tasks);
}

function addTask(fields) {
  const now = Date.now();
  const minOrder = Math.min(now, ...state.tasks.map((t) => (typeof t.order === 'number' ? t.order : now)));
  const task = Object.assign(
    {
      id: uid(),
      text: '',
      note: '',
      categoryId: tab !== 'all' && tab !== 'done' ? tab : 'default',
      done: false,
      important: false,
      color: '',
      remindAt: null,
      repeat: 'none',
      notified: false,
      snoozeUntil: null,
      createdAt: now,
      updatedAt: now,
      doneAt: null,
      order: minOrder - 1 // 新任务排最前
    },
    fields
  );
  state.tasks.push(task);
  persist();
  render();
  return task;
}

function updateTask(id, patch) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  if ('remindAt' in patch && patch.remindAt !== t.remindAt) {
    patch.notified = false;
    patch.snoozeUntil = null;
  }
  if ('repeat' in patch && patch.repeat !== t.repeat) patch.notified = false;
  Object.assign(t, patch, { updatedAt: Date.now() });
  persist();
  render();
}

function deleteTask(id) {
  const idx = state.tasks.findIndex((x) => x.id === id);
  if (idx < 0) return;
  const [removed] = state.tasks.splice(idx, 1);
  persist();
  render();
  toast('已删除', () => {
    state.tasks.splice(idx, 0, removed);
    persist();
    render();
  });
}

async function toggleDone(id) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  if (!t.done) {
    await api.completeTask(id); // 主进程负责重复任务生成下一次
    state = await api.getState();
    render();
    toast(t.repeat !== 'none' ? '已完成，已生成下一次提醒' : '已完成', t.repeat !== 'none' ? null : () => updateTask(id, { done: false, doneAt: null }));
  } else {
    updateTask(id, { done: false, doneAt: null });
  }
}

// ---------------- 渲染 ----------------
function applySettingsUI() {
  const s = state.settings;
  document.body.dataset.theme = s.theme;
  document.body.classList.toggle('locked', !!s.locked);
  document.documentElement.style.setProperty('--font', (s.fontSize || 14) + 'px');
  $('btnPin').classList.toggle('on', !!s.alwaysOnTop);
  $('btnPin').title = s.alwaysOnTop ? '已置顶（点击取消）' : '窗口置顶';
}

function visibleTasks() {
  let list = state.tasks;
  if (tab === 'done') list = list.filter((t) => t.done);
  else list = list.filter((t) => !t.done && (tab === 'all' || t.categoryId === tab));
  if (query) {
    const q = query.toLowerCase();
    list = list.filter((t) => (t.text + '\n' + t.note).toLowerCase().includes(q));
  }
  if (tab === 'done') return list.slice().sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
  return list.slice().sort((a, b) => (b.important - a.important) || (a.order - b.order));
}

function renderTabs() {
  const box = $('tabs');
  box.innerHTML = '';
  const undone = state.tasks.filter((t) => !t.done);
  const mk = (id, name, count) => {
    const b = el('button', 'tab' + (tab === id ? ' active' : ''), name);
    if (count) b.appendChild(el('span', 'count', String(count)));
    b.onclick = () => {
      tab = id;
      render();
    };
    // 拖动待办到分类标签上可以移动分类
    if (id !== 'all' && id !== 'done') {
      b.ondragover = (e) => {
        if (!dragId) return;
        e.preventDefault();
        b.classList.add('drop-target');
      };
      b.ondragleave = () => b.classList.remove('drop-target');
      b.ondrop = (e) => {
        e.preventDefault();
        b.classList.remove('drop-target');
        if (dragId) {
          updateTask(dragId, { categoryId: id });
          toast('已移动到「' + name + '」');
        }
      };
    }
    box.appendChild(b);
  };
  mk('all', '全部', undone.length);
  for (const c of state.categories) mk(c.id, c.name, undone.filter((t) => t.categoryId === c.id).length);
  mk('done', '已完成', 0);
}

function renderItem(t) {
  const now = Date.now();
  const item = el('div', 'item' + (t.done ? ' done' : ''));
  item.dataset.id = t.id;
  if (t.color) item.style.borderLeftColor = t.color;
  item.draggable = tab !== 'done';

  const cb = el('button', 'check-box');
  cb.title = t.done ? '标记为未完成' : '完成';
  cb.onclick = () => toggleDone(t.id);
  item.appendChild(cb);

  const body = el('div', 'body');
  const text = el('div', 'text', t.text);
  text.title = '双击编辑';
  text.ondblclick = () => startInlineEdit(text, t);
  body.appendChild(text);
  if (t.note) body.appendChild(el('div', 'note', t.note));

  const meta = el('div', 'meta');
  if (t.important) meta.appendChild(el('span', 'star', '★ 重要'));
  if (t.remindAt && !t.done) {
    const when = t.snoozeUntil && t.snoozeUntil > now ? t.snoozeUntil : t.remindAt;
    let cls = '';
    if (when < now && t.repeat === 'none') cls = 'overdue';
    else if (when - now < 3600000 && when > now) cls = 'soon';
    const label = (t.snoozeUntil && t.snoozeUntil > now ? '⏰ 稍后 ' : '⏰ ') + fmtTime(when) + (cls === 'overdue' ? ' 已过期' : '');
    meta.appendChild(el('span', cls, label));
  }
  if (t.repeat !== 'none' && !t.done) meta.appendChild(el('span', '', '🔁 ' + REPEAT_LABEL[t.repeat]));
  if (tab === 'all' || tab === 'done') {
    const c = catById(t.categoryId);
    const s = el('span', 'cat-dot', c.name);
    s.style.setProperty('--c', c.color);
    meta.appendChild(s);
  }
  if (t.done && t.doneAt) meta.appendChild(el('span', '', '完成于 ' + fmtTime(t.doneAt)));
  if (meta.childNodes.length) body.appendChild(meta);
  item.appendChild(body);

  const actions = el('div', 'actions');
  if (!t.done) {
    const star = el('button', 'icon-btn', t.important ? '★' : '☆');
    star.title = t.important ? '取消重要' : '标为重要';
    star.onclick = () => updateTask(t.id, { important: !t.important });
    actions.appendChild(star);
  }
  const edit = el('button', 'icon-btn', '✎');
  edit.title = '编辑 / 设置提醒';
  edit.onclick = () => openEditor(t.id);
  actions.appendChild(edit);
  const del = el('button', 'icon-btn', '✕');
  del.title = '删除';
  del.onclick = () => deleteTask(t.id);
  actions.appendChild(del);
  item.appendChild(actions);

  item.ondragstart = (e) => {
    dragId = t.id;
    item.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', t.id);
  };
  item.ondragend = () => {
    dragId = null;
    item.classList.remove('dragging');
    document.querySelectorAll('.drop-before,.drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
  };
  item.ondragover = (e) => {
    if (!dragId || dragId === t.id) return;
    e.preventDefault();
    const r = item.getBoundingClientRect();
    const before = e.clientY < r.top + r.height / 2;
    item.classList.toggle('drop-before', before);
    item.classList.toggle('drop-after', !before);
  };
  item.ondragleave = () => item.classList.remove('drop-before', 'drop-after');
  item.ondrop = (e) => {
    e.preventDefault();
    const before = item.classList.contains('drop-before');
    item.classList.remove('drop-before', 'drop-after');
    if (dragId && dragId !== t.id) reorder(dragId, t.id, before);
  };
  return item;
}

// 拖动排序：按当前可见顺序重排，再重新编号 order
function reorder(srcId, targetId, before) {
  const list = visibleTasks();
  const src = list.find((t) => t.id === srcId);
  const target = list.find((t) => t.id === targetId);
  if (!src || !target) return;
  if (src.important !== target.important) src.important = target.important; // 拖入重要区/普通区
  const ids = list.map((t) => t.id).filter((id) => id !== srcId);
  let idx = ids.indexOf(targetId);
  if (!before) idx++;
  ids.splice(idx, 0, srcId);
  const orders = list.map((t) => t.order).sort((a, b) => a - b);
  ids.forEach((id, i) => {
    state.tasks.find((t) => t.id === id).order = orders[i] + i * 1e-6;
  });
  persist();
  render();
}

function render() {
  if (!state) return;
  if (inlineEditing) {
    pendingRender = true;
    return;
  }
  pendingRender = false;
  applySettingsUI();
  renderTabs();
  const box = $('list');
  const scroll = box.scrollTop;
  box.innerHTML = '';
  const list = visibleTasks();
  if (!list.length) {
    const msg = query ? '没有找到相关待办' : tab === 'done' ? '还没有已完成的事项' : '暂无待办\n在上方输入框添加，回车保存';
    box.appendChild(el('div', 'empty', msg)).style.whiteSpace = 'pre-line';
  } else if (tab === 'done') {
    let lastDay = null;
    for (const t of list) {
      const day = fmtDay(t.doneAt || t.updatedAt);
      if (day !== lastDay) {
        box.appendChild(el('div', 'group-title', day));
        lastDay = day;
      }
      box.appendChild(renderItem(t));
    }
  } else {
    for (const t of list) box.appendChild(renderItem(t));
  }
  box.scrollTop = scroll;

  const undone = state.tasks.filter((t) => !t.done);
  const nowTs = Date.now();
  const overdue = undone.filter((t) => t.remindAt && t.repeat === 'none' && t.remindAt < nowTs && !(t.snoozeUntil > nowTs)).length;
  const today = state.tasks.filter((t) => t.done && t.doneAt && startOfDay(t.doneAt) === startOfDay(Date.now())).length;
  $('stat').textContent = '待办 ' + undone.length + (overdue ? ' · 过期 ' + overdue : '') + ' · 今日完成 ' + today;
  $('btnClearDone').classList.toggle('hidden', tab !== 'done' || !list.length);
}

// ---------------- 行内编辑 ----------------
function startInlineEdit(node, t) {
  if (t.done) return;
  inlineEditing = true;
  api.setEditing(true);
  node.contentEditable = 'true';
  node.focus();
  const range = document.createRange();
  range.selectNodeContents(node);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  const finish = (save) => {
    node.contentEditable = 'false';
    node.onblur = null;
    node.onkeydown = null;
    inlineEditing = false;
    api.setEditing(false);
    const v = node.innerText.trim();
    if (save && v && v !== t.text) updateTask(t.id, { text: v });
    else render();
  };
  node.onblur = () => finish(true);
  node.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      finish(false);
    }
  };
}

// ---------------- 输入框 ----------------
function updateHint() {
  const v = $('newInput').value.trim();
  const p = v ? parseTime(v) : null;
  const h = $('hint');
  if (p && p.text) {
    h.textContent = '⏰ 将在 ' + fmtTime(p.time) + ' 提醒：' + p.text;
    h.classList.remove('hidden');
  } else {
    h.classList.add('hidden');
  }
}

function submitNew() {
  const input = $('newInput');
  const v = input.value.trim();
  if (!v) return;
  const p = parseTime(v);
  if (p && p.text) addTask({ text: p.text, remindAt: p.time });
  else addTask({ text: v });
  input.value = '';
  updateHint();
  if (tab === 'done') {
    tab = 'all';
    render();
  }
}

// ---------------- 编辑面板 ----------------
function fillCatSelect(sel, value) {
  sel.innerHTML = '';
  for (const c of state.categories) {
    const o = el('option', '', c.name);
    o.value = c.id;
    sel.appendChild(o);
  }
  sel.value = value;
}

function openEditor(id, draft) {
  editingId = id || null;
  const t = id ? state.tasks.find((x) => x.id === id) : Object.assign({ text: '', note: '', categoryId: tab !== 'all' && tab !== 'done' ? tab : 'default', color: '', remindAt: null, repeat: 'none', important: false }, draft);
  if (!t) return;
  $('editor').querySelector('h3').textContent = id ? '编辑待办' : '新建待办';
  $('edText').value = t.text;
  $('edNote').value = t.note || '';
  fillCatSelect($('edCat'), t.categoryId);
  $('edColor').value = t.color || '';
  $('edTime').value = toLocalInput(t.remindAt);
  $('edRepeat').value = t.repeat;
  $('edImportant').checked = !!t.important;
  $('edDelete').classList.toggle('hidden', !id);
  $('editor').classList.remove('hidden');
  api.setEditing(true);
  $('edText').focus();
}

function closeEditor() {
  $('editor').classList.add('hidden');
  api.setEditing(false);
  editingId = null;
}

function saveEditor() {
  const text = $('edText').value.trim();
  if (!text) {
    $('edText').focus();
    return;
  }
  const remindAt = fromLocalInput($('edTime').value);
  const repeat = $('edRepeat').value;
  if (repeat !== 'none' && !remindAt) {
    toast('重复提醒需要先设置提醒时间');
    return;
  }
  const patch = {
    text,
    note: $('edNote').value.trim(),
    categoryId: $('edCat').value,
    color: $('edColor').value,
    remindAt,
    repeat,
    important: $('edImportant').checked
  };
  if (editingId) updateTask(editingId, patch);
  else {
    addTask(patch);
    $('newInput').value = '';
    updateHint();
  }
  closeEditor();
}

function quickTime(q) {
  const d = new Date();
  if (q === '30m') d.setMinutes(d.getMinutes() + 30);
  if (q === '1h') d.setHours(d.getHours() + 1);
  if (q === 'tonight') {
    d.setHours(20, 0, 0, 0);
    if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1);
  }
  if (q === 'tomorrow') {
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
  }
  $('edTime').value = toLocalInput(d.getTime());
}

// ---------------- 设置面板 ----------------
function openSettings() {
  const s = state.settings;
  const themes = $('themes');
  themes.innerHTML = '';
  for (const [name, color] of THEMES) {
    const b = el('button', 'theme-swatch' + (s.theme === name ? ' active' : ''));
    b.style.background = color;
    b.title = name;
    b.type = 'button';
    b.onclick = () => setSetting({ theme: name }).then(openSettings);
    themes.appendChild(b);
  }
  $('setOpacity').value = Math.round(s.opacity * 100);
  $('opacityVal').textContent = Math.round(s.opacity * 100) + '%';
  $('setFont').value = s.fontSize;
  $('fontVal').textContent = s.fontSize + 'px';
  $('setTop').checked = !!s.alwaysOnTop;
  $('setEdge').checked = !!s.edgeHide;
  $('setLock').checked = !!s.locked;
  $('setAuto').checked = !!s.autoStart;
  $('setSound').checked = !!s.sound;
  $('setHotkey').value = s.hotkey ? s.hotkey.replace('CommandOrControl', 'Ctrl') : '无';
  renderCatList();
  $('settings').classList.remove('hidden');
  api.setEditing(true);
}

function closeSettings() {
  $('settings').classList.add('hidden');
  api.setEditing(false);
}

async function setSetting(patch) {
  const r = await api.setSettings(patch);
  state.settings = r.settings;
  applySettingsUI();
  return r;
}

function renderCatList() {
  const box = $('catList');
  box.innerHTML = '';
  for (const c of state.categories) {
    const row = el('div', 'cat-row');
    const color = el('input');
    color.type = 'color';
    color.value = c.color;
    color.onchange = () => {
      c.color = color.value;
      api.setCategories(state.categories);
    };
    const name = el('input');
    name.type = 'text';
    name.value = c.name;
    name.maxLength = 12;
    name.onchange = () => {
      const v = name.value.trim();
      if (v) c.name = v;
      else name.value = c.name;
      api.setCategories(state.categories);
      render();
    };
    row.appendChild(color);
    row.appendChild(name);
    if (c.id !== 'default') {
      const del = el('button', 'btn small danger', '删除');
      del.type = 'button';
      del.onclick = () => {
        const n = state.tasks.filter((t) => t.categoryId === c.id).length;
        if (n && !confirm('该分类下有 ' + n + ' 条事项，删除后将移到「' + state.categories[0].name + '」。确定删除？')) return;
        state.categories = state.categories.filter((x) => x.id !== c.id);
        for (const t of state.tasks) if (t.categoryId === c.id) t.categoryId = 'default';
        if (tab === c.id) tab = 'all';
        api.setCategories(state.categories);
        renderCatList();
        render();
      };
      row.appendChild(del);
    }
    box.appendChild(row);
  }
}

// 快捷键录制
function recordHotkey(e) {
  e.preventDefault();
  if (e.key === 'Escape' || e.key === 'Backspace') {
    setSetting({ hotkey: '' }).then(() => ($('setHotkey').value = '无'));
    return;
  }
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
  const mods = [];
  if (e.ctrlKey) mods.push('CommandOrControl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (!mods.length) {
    toast('快捷键至少要包含 Ctrl / Alt / Shift 之一');
    return;
  }
  let key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  if (/^F\d+$/.test(e.key)) key = e.key;
  const accel = mods.concat(key).join('+');
  setSetting({ hotkey: accel }).then((r) => {
    $('setHotkey').value = r.settings.hotkey ? r.settings.hotkey.replace('CommandOrControl', 'Ctrl') : '无';
    if (!r.ok) toast('快捷键被其他程序占用，请换一个');
    else toast('快捷键已设置');
  });
}

// ---------------- 事件绑定 ----------------
function bind() {
  $('btnHide').onclick = () => api.win('hide');
  $('btnPin').onclick = () => setSetting({ alwaysOnTop: !state.settings.alwaysOnTop });
  $('btnSettings').onclick = openSettings;
  $('btnSearch').onclick = toggleSearch;
  $('btnNewTime').onclick = () => {
    const v = $('newInput').value.trim();
    const p = v ? parseTime(v) : null;
    openEditor(null, p && p.text ? { text: p.text, remindAt: p.time } : { text: v });
  };

  const input = $('newInput');
  input.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.isComposing) submitNew();
    if (e.key === 'Escape') {
      input.value = '';
      updateHint();
      input.blur();
    }
  };
  input.oninput = updateHint;
  input.onfocus = () => api.setEditing(true);
  input.onblur = () => api.setEditing(false);

  $('searchInput').oninput = (e) => {
    query = e.target.value.trim();
    render();
  };
  $('searchInput').onkeydown = (e) => {
    if (e.key === 'Escape') toggleSearch();
  };

  $('edSave').onclick = saveEditor;
  $('edCancel').onclick = closeEditor;
  $('edDelete').onclick = () => {
    const id = editingId;
    closeEditor();
    deleteTask(id);
  };
  $('edClearTime').onclick = () => {
    $('edTime').value = '';
    $('edRepeat').value = 'none';
  };
  $('quickTimes').onclick = (e) => {
    if (e.target.dataset.q) quickTime(e.target.dataset.q);
  };
  $('edText').onkeydown = (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveEditor();
  };

  $('setClose').onclick = closeSettings;
  $('setOpacity').oninput = (e) => {
    $('opacityVal').textContent = e.target.value + '%';
    setSetting({ opacity: e.target.value / 100 });
  };
  $('setFont').oninput = (e) => {
    $('fontVal').textContent = e.target.value + 'px';
    setSetting({ fontSize: Number(e.target.value) });
  };
  $('setTop').onchange = (e) => setSetting({ alwaysOnTop: e.target.checked });
  $('setEdge').onchange = (e) => setSetting({ edgeHide: e.target.checked });
  $('setLock').onchange = (e) => setSetting({ locked: e.target.checked });
  $('setAuto').onchange = (e) => setSetting({ autoStart: e.target.checked });
  $('setSound').onchange = (e) => setSetting({ sound: e.target.checked });
  $('setHotkey').onkeydown = recordHotkey;
  $('btnAddCat').onclick = () => {
    const v = $('newCat').value.trim();
    if (!v) return;
    const palette = ['#e74c3c', '#9b59b6', '#1abc9c', '#e67e22', '#34495e', '#16a085'];
    state.categories.push({ id: uid(), name: v, color: palette[state.categories.length % palette.length] });
    $('newCat').value = '';
    api.setCategories(state.categories);
    renderCatList();
    render();
  };
  $('newCat').onkeydown = (e) => {
    if (e.key === 'Enter') $('btnAddCat').click();
  };
  $('btnExport').onclick = async () => {
    if (await api.exportData()) toast('导出成功');
  };
  $('btnImport').onclick = async () => {
    if (await api.importData()) {
      state = await api.getState();
      tab = 'all';
      closeSettings();
      render();
      toast('导入成功');
    }
  };

  $('btnClearDone').onclick = () => {
    const done = state.tasks.filter((t) => t.done);
    if (!done.length || !confirm('确定清空 ' + done.length + ' 条已完成事项？')) return;
    state.tasks = state.tasks.filter((t) => !t.done);
    persist();
    render();
  };

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('editor').classList.contains('hidden')) closeEditor();
      else if (!$('settings').classList.contains('hidden')) closeSettings();
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      toggleSearch(true);
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      $('newInput').focus();
    }
  });
  // 点击遮罩空白处关闭面板
  for (const id of ['editor', 'settings']) {
    $(id).addEventListener('mousedown', (e) => {
      if (e.target.id === id) id === 'editor' ? closeEditor() : closeSettings();
    });
  }
}

function toggleSearch(forceOpen) {
  const bar = $('searchBar');
  const open = forceOpen === true || bar.classList.contains('hidden');
  bar.classList.toggle('hidden', !open);
  if (open) $('searchInput').focus();
  else {
    $('searchInput').value = '';
    query = '';
    render();
  }
}

async function init() {
  state = await api.getState();
  bind();
  render();
  api.onState((s) => {
    state = s;
    render();
  });
  api.onFocusInput(() => $('newInput').focus());
  // 每 30 秒刷新一次，让“今天/已过期”等时间标签保持准确
  setInterval(() => {
    if (!inlineEditing) render();
  }, 30000);
}

init();
