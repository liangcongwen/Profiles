'use strict';
// 从中文输入中识别提醒时间，例如：
//   “明天下午3点开会” “10分钟后喝水” “周五 9:30 交周报” “3月8日 买花” “今晚8点半 跑步”
// 返回 { text: 去掉时间描述后的内容, time: 时间戳 } ；识别不到返回 null
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.parseTime = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const CN = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

  function cnNum(s) {
    if (s == null || s === '') return NaN;
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    if (s === '十') return 10;
    let m = s.match(/^([一二两三四五六七八九])?十([一二三四五六七八九])?$/);
    if (m) return (m[1] ? CN[m[1]] : 1) * 10 + (m[2] ? CN[m[2]] : 0);
    if (s.length === 1 && s in CN) return CN[s];
    return NaN;
  }

  const NUM = '[0-9零〇一二两三四五六七八九十]+';
  const WEEK = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 0 };

  function parse(input, nowTs) {
    if (!input) return null;
    const now = new Date(nowTs || Date.now());
    let text = input;
    let matched = false;

    // 1) 相对时间：N分钟后 / N小时后 / N天后 / 半小时后
    let m = text.match(new RegExp('(' + NUM + '|半)\\s*(个)?\\s*(分钟|小时|钟头|天)(之)?后'));
    if (m) {
      const n = m[1] === '半' ? 0.5 : cnNum(m[1]);
      if (!isNaN(n)) {
        const unit = m[3] === '分钟' ? 60000 : m[3] === '天' ? 86400000 : 3600000;
        return { text: clean(text.replace(m[0], '')), time: now.getTime() + Math.round(n * unit) };
      }
    }

    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    let dateSet = false;

    // 2) 日期：今天/明天/后天/大后天/今晚
    m = text.match(/(大后天|后天|明天|明早|明晚|今天|今早|今晚)/);
    if (m) {
      const off = { 今天: 0, 今早: 0, 今晚: 0, 明天: 1, 明早: 1, 明晚: 1, 后天: 2, 大后天: 3 }[m[1]];
      d.setDate(d.getDate() + off);
      text = text.replace(m[0], m[1].endsWith('晚') ? '晚上' : m[1].endsWith('早') ? '早上' : '');
      dateSet = true;
      matched = true;
    }

    // 3) 周几 / 下周几
    if (!dateSet) {
      m = text.match(/(下下|下)?(?:周|星期|礼拜)([一二三四五六日天1-7])/);
      if (m) {
        const target = WEEK[m[2]];
        let diff = (target - d.getDay() + 7) % 7;
        if (m[1] === '下') diff = ((target + 6) % 7) - ((d.getDay() + 6) % 7) + 7;
        else if (m[1] === '下下') diff = ((target + 6) % 7) - ((d.getDay() + 6) % 7) + 14;
        d.setDate(d.getDate() + diff);
        text = text.replace(m[0], '');
        dateSet = true;
        matched = true;
        m.weekNoPrefix = !m[1] && diff === 0;
      }
      var weekToday = m && m.weekNoPrefix;
    }

    // 4) M月D日 / M/D / M-D
    if (!dateSet) {
      m = text.match(new RegExp('(' + NUM + ')\\s*月\\s*(' + NUM + ')\\s*[日号]?'));
      if (!m) m = text.match(/(?:^|[^\d:])(\d{1,2})[\/-](\d{1,2})(?![\d:])/);
      if (m) {
        const mon = cnNum(m[1]);
        const day = cnNum(m[2]);
        if (mon >= 1 && mon <= 12 && day >= 1 && day <= 31) {
          d.setMonth(mon - 1, day);
          if (d.getTime() < new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) {
            d.setFullYear(d.getFullYear() + 1);
          }
          text = text.replace(m[0].replace(/^[^\d零〇一二两三四五六七八九十]/, ''), '');
          dateSet = true;
          matched = true;
        }
      }
    }
    if (!dateSet) {
      m = text.match(new RegExp('(' + NUM + ')\\s*[日号]'));
      if (m && !/点|时/.test(text.slice(text.indexOf(m[0]) + m[0].length, text.indexOf(m[0]) + m[0].length + 1))) {
        const day = cnNum(m[1]);
        if (day >= 1 && day <= 31) {
          d.setDate(day);
          if (d.getTime() < new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) d.setMonth(d.getMonth() + 1, day);
          text = text.replace(m[0], '');
          dateSet = true;
          matched = true;
        }
      }
    }

    // 5) 时刻：(上午|下午|晚上|中午|早上|凌晨)? H点(半|M分)? 或 H:MM
    let hour = null;
    let minute = 0;
    const period = '(早上|早晨|上午|中午|下午|傍晚|晚上|夜里|凌晨)?\\s*';
    m = text.match(new RegExp(period + '(\\d{1,2})[:：](\\d{2})'));
    if (m) {
      hour = parseInt(m[2], 10);
      minute = parseInt(m[3], 10);
    } else {
      m = text.match(new RegExp(period + '(' + NUM + ')\\s*[点时](?:\\s*(半|一刻|三刻|(' + NUM + ')\\s*分?))?'));
      if (m) {
        hour = cnNum(m[2]);
        if (m[3] === '半') minute = 30;
        else if (m[3] === '一刻') minute = 15;
        else if (m[3] === '三刻') minute = 45;
        else if (m[4]) minute = cnNum(m[4]);
      }
    }
    let periodWord = m && m[1];
    if (!periodWord) {
      const pm = text.match(/(早上|早晨|上午|中午|下午|傍晚|晚上|夜里|凌晨)/);
      if (pm && hour === null) periodWord = pm[1];
    }
    if (hour !== null && !isNaN(hour) && hour <= 24 && minute < 60) {
      if (/下午|傍晚|晚上|夜里/.test(periodWord || '') && hour < 12) hour += 12;
      if (periodWord === '中午' && hour < 6) hour += 12;
      text = text.replace(m[0], '');
      matched = true;
    } else {
      hour = null;
      minute = 0;
    }
    if (hour === null && periodWord) {
      // 只有“晚上/下午”等，没有具体时刻：给一个默认时间
      hour = { 早上: 8, 早晨: 8, 上午: 9, 中午: 12, 下午: 14, 傍晚: 18, 晚上: 20, 夜里: 22, 凌晨: 6 }[periodWord];
      text = text.replace(periodWord, '');
      matched = true;
    }
    text = text.replace(/(早上|早晨|上午|中午|下午|傍晚|晚上|夜里|凌晨)/, (w) => (w === periodWord ? '' : w));

    if (!matched) return null;
    if (hour === null) hour = 9; // 只有日期，默认上午 9 点
    d.setHours(hour, minute, 0, 0);
    if (!dateSet && d.getTime() <= now.getTime()) {
      // 只说了时刻且已过：如果是“3点”且现在是下午，优先理解为今天 15 点
      if (!periodWord && hour < 12 && d.getTime() + 12 * 3600000 > now.getTime()) d.setHours(hour + 12);
      else d.setDate(d.getDate() + 1);
    }
    if (weekToday && d.getTime() <= now.getTime()) d.setDate(d.getDate() + 7);
    return { text: clean(text), time: d.getTime() };
  }

  function clean(s) {
    return s.replace(/^[\s,，、:：在于的]+|[\s,，、:：在于]+$/g, '').replace(/\s{2,}/g, ' ');
  }

  return parse;
});
