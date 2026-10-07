'use strict';
const test = require('node:test');
const assert = require('node:assert');
const parse = require('../src/renderer/parse-time');

// 2026-10-07 周三 14:00
const NOW = new Date(2026, 9, 7, 14, 0).getTime();
const at = (mo, d, h, mi = 0, y = 2026) => new Date(y, mo - 1, d, h, mi).getTime();

const cases = [
  ['明天下午3点开会', '开会', at(10, 8, 15)],
  ['10分钟后喝水', '喝水', NOW + 10 * 60000],
  ['半小时后出门', '出门', NOW + 30 * 60000],
  ['两小时后关火', '关火', NOW + 2 * 3600000],
  ['周五 9:30 交周报', '交周报', at(10, 9, 9, 30)],
  ['下周一上午十点例会', '例会', at(10, 12, 10)],
  ['今晚8点半 跑步', '跑步', at(10, 7, 20, 30)],
  ['明晚 聚餐', '聚餐', at(10, 8, 20)],
  ['3点 打电话', '打电话', at(10, 7, 15)],
  ['15号 还信用卡', '还信用卡', at(10, 15, 9)],
  ['3月8日 买花', '买花', at(3, 8, 9, 0, 2027)],
  ['12/25 圣诞', '圣诞', at(12, 25, 9)],
  ['周三 看电影', '看电影', at(10, 14, 9)],
  ['后天十二点半 午饭', '午饭', at(10, 9, 12, 30)]
];

for (const [input, text, time] of cases) {
  test(input, () => {
    const r = parse(input, NOW);
    assert.ok(r, 'should parse');
    assert.strictEqual(r.text, text);
    assert.strictEqual(new Date(r.time).toString(), new Date(time).toString());
  });
}

test('没有时间描述返回 null', () => {
  assert.strictEqual(parse('买牛奶', NOW), null);
  assert.strictEqual(parse('看第3章', NOW), null);
  assert.strictEqual(parse('', NOW), null);
});
