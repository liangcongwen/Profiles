'use strict';
/* global api */
const id = new URLSearchParams(location.search).get('id');
const $ = (x) => document.getElementById(x);

api.getTask(id).then((t) => {
  if (!t) return api.win('close');
  $('text').textContent = t.text;
  $('note').textContent = t.note || '';
  const d = new Date();
  $('time').textContent = '提醒时间 ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  // 简单提示音（不依赖音频文件）
  api.getState().then((s) => {
    if (!s.settings.sound) return;
    try {
      const ctx = new AudioContext();
      [0, 0.18].forEach((delay) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.value = 880;
        g.gain.setValueAtTime(0.15, ctx.currentTime + delay);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + 0.15);
        o.connect(g).connect(ctx.destination);
        o.start(ctx.currentTime + delay);
        o.stop(ctx.currentTime + delay + 0.16);
      });
    } catch (_) {}
  });
});

$('done').onclick = () => api.reminderAction(id, 'done');
$('snooze').onclick = () => api.reminderAction(id, 'snooze', Number($('mins').value));
$('open').onclick = () => api.reminderAction(id, 'open');
$('close').onclick = () => api.reminderAction(id, 'close');
