"""SQLite 数据访问层。不依赖界面，可单独测试。"""

import csv
import datetime as dt
import sqlite3

from .schema import CLOSED_STATUSES, ENTITIES, FOLLOWUP_FIELDS

DATETIME_FMT = "%Y-%m-%d %H:%M"
DATE_FMT = "%Y-%m-%d"


def now_str():
    return dt.datetime.now().strftime(DATETIME_FMT)


def today_str():
    return dt.date.today().strftime(DATE_FMT)


def validate_value(kind, value):
    """校验日期类字段，返回规范化后的值；格式错误时抛出 ValueError。"""
    value = (value or "").strip()
    if not value:
        return ""
    if kind == "datetime":
        for fmt in (DATETIME_FMT, "%Y-%m-%d %H:%M:%S", DATE_FMT):
            try:
                return dt.datetime.strptime(value, fmt).strftime(DATETIME_FMT)
            except ValueError:
                pass
        raise ValueError(f"时间格式应为 YYYY-MM-DD HH:MM：{value}")
    if kind == "date":
        try:
            return dt.datetime.strptime(value, DATE_FMT).strftime(DATE_FMT)
        except ValueError:
            raise ValueError(f"日期格式应为 YYYY-MM-DD：{value}") from None
    return value


class Database:
    def __init__(self, path):
        self.path = str(path)
        self.conn = sqlite3.connect(self.path)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys = ON")
        self._create_tables()

    def close(self):
        self.conn.close()

    # ---------- 建表 ----------
    def _create_tables(self):
        cur = self.conn.cursor()
        for spec in ENTITIES.values():
            cols = []
            for name, _, kind, _ in spec["fields"]:
                if name == "code":
                    cols.append("code TEXT NOT NULL UNIQUE")
                elif kind == "ref":
                    cols.append(f"{name} INTEGER REFERENCES cases(id) "
                                "ON DELETE SET NULL")
                else:
                    cols.append(f"{name} TEXT NOT NULL DEFAULT ''")
            cols += ["created_at TEXT NOT NULL", "updated_at TEXT NOT NULL"]
            cur.execute(
                f"CREATE TABLE IF NOT EXISTS {spec['table']} ("
                "id INTEGER PRIMARY KEY AUTOINCREMENT, " + ", ".join(cols) + ")"
            )
            self._add_missing_columns(spec)
        cur.execute(
            "CREATE TABLE IF NOT EXISTS followups ("
            "id INTEGER PRIMARY KEY AUTOINCREMENT, "
            "entity TEXT NOT NULL, entity_id INTEGER NOT NULL, "
            + ", ".join(f"{f[0]} TEXT NOT NULL DEFAULT ''" for f in FOLLOWUP_FIELDS)
            + ", created_at TEXT NOT NULL)"
        )
        cur.execute("CREATE INDEX IF NOT EXISTS idx_followups_entity "
                    "ON followups(entity, entity_id)")
        self.conn.commit()

    def _add_missing_columns(self, spec):
        """老版本数据库升级：补上新增字段。"""
        existing = {r["name"] for r in
                    self.conn.execute(f"PRAGMA table_info({spec['table']})")}
        for name, _, kind, _ in spec["fields"]:
            if name not in existing:
                coltype = "INTEGER" if kind == "ref" else "TEXT NOT NULL DEFAULT ''"
                self.conn.execute(
                    f"ALTER TABLE {spec['table']} ADD COLUMN {name} {coltype}")

    # ---------- 通用增删改查 ----------
    def _table(self, entity):
        return ENTITIES[entity]["table"]

    def next_code(self, entity):
        prefix = ENTITIES[entity]["code_prefix"] + dt.date.today().strftime("%Y%m%d")
        rows = self.conn.execute(
            f"SELECT code FROM {self._table(entity)} WHERE code LIKE ?",
            (prefix + "-%",)).fetchall()
        seq = 0
        for r in rows:
            tail = r["code"][len(prefix) + 1:]
            if tail.isdigit():
                seq = max(seq, int(tail))
        return f"{prefix}-{seq + 1:03d}"

    def _clean(self, entity, data):
        clean = {}
        for name, label, kind, _ in ENTITIES[entity]["fields"]:
            if name not in data:
                continue
            value = data[name]
            if kind == "ref":
                clean[name] = int(value) if value not in (None, "", 0) else None
            else:
                try:
                    clean[name] = validate_value(kind, value)
                except ValueError as e:
                    raise ValueError(f"{label}：{e}") from None
        return clean

    def create(self, entity, data):
        clean = self._clean(entity, data)
        if not clean.get("code"):
            clean["code"] = self.next_code(entity)
        stamp = now_str()
        clean["created_at"] = clean["updated_at"] = stamp
        keys = list(clean)
        try:
            cur = self.conn.execute(
                f"INSERT INTO {self._table(entity)} ({', '.join(keys)}) "
                f"VALUES ({', '.join('?' for _ in keys)})",
                [clean[k] for k in keys])
        except sqlite3.IntegrityError:
            raise ValueError(f"编号已存在：{clean['code']}") from None
        self.conn.commit()
        return cur.lastrowid

    def update(self, entity, record_id, data):
        clean = self._clean(entity, data)
        if "code" in clean and not clean["code"]:
            raise ValueError("编号不能为空")
        clean["updated_at"] = now_str()
        keys = list(clean)
        try:
            self.conn.execute(
                f"UPDATE {self._table(entity)} SET "
                + ", ".join(f"{k} = ?" for k in keys) + " WHERE id = ?",
                [clean[k] for k in keys] + [record_id])
        except sqlite3.IntegrityError:
            raise ValueError(f"编号已存在：{clean.get('code')}") from None
        self.conn.commit()

    def delete(self, entity, record_id):
        self.conn.execute("DELETE FROM followups WHERE entity = ? AND entity_id = ?",
                          (entity, record_id))
        self.conn.execute(f"DELETE FROM {self._table(entity)} WHERE id = ?",
                          (record_id,))
        self.conn.commit()

    def get(self, entity, record_id):
        row = self.conn.execute(
            f"SELECT * FROM {self._table(entity)} WHERE id = ?",
            (record_id,)).fetchone()
        return dict(row) if row else None

    def search(self, entity, keyword="", status="", date_from="", date_to=""):
        """按关键字（匹配所有文本字段）、状态和登记日期筛选。"""
        spec = ENTITIES[entity]
        where, params = [], []
        if keyword:
            text_cols = [f[0] for f in spec["fields"] if f[2] != "ref"]
            where.append("(" + " OR ".join(f"{c} LIKE ?" for c in text_cols) + ")")
            params += [f"%{keyword}%"] * len(text_cols)
        if status:
            where.append("status = ?")
            params.append(status)
        date_col = next(f[0] for f in spec["fields"] if f[2] == "datetime")
        if date_from:
            where.append(f"substr({date_col}, 1, 10) >= ?")
            params.append(validate_value("date", date_from))
        if date_to:
            where.append(f"substr({date_col}, 1, 10) <= ?")
            params.append(validate_value("date", date_to))
        sql = f"SELECT * FROM {spec['table']}"
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += f" ORDER BY {date_col} DESC, id DESC"
        return [dict(r) for r in self.conn.execute(sql, params)]

    def case_choices(self):
        """供下拉框使用的案件列表：[(id, '编号 名称'), ...]。"""
        rows = self.conn.execute(
            "SELECT id, code, name FROM cases ORDER BY id DESC").fetchall()
        return [(r["id"], f"{r['code']} {r['name']}".strip()) for r in rows]

    def linked(self, entity, case_id):
        """查询关联到某案件的警情或线索。"""
        return [dict(r) for r in self.conn.execute(
            f"SELECT * FROM {self._table(entity)} WHERE case_id = ? ORDER BY id DESC",
            (case_id,))]

    # ---------- 警情转案件 ----------
    def incident_to_case(self, incident_id):
        inc = self.get("incident", incident_id)
        if inc is None:
            raise ValueError("警情不存在")
        if inc.get("case_id"):
            raise ValueError("该警情已关联案件")
        case_id = self.create("case", {
            "name": f"{inc['location']}{inc['category']}案".strip() or "新案件",
            "category": "其他",
            "status": "受理",
            "filed_at": now_str(),
            "location": inc["location"],
            "lead_officer": inc["officer"],
            "victim": inc["reporter"],
            "summary": f"由警情 {inc['code']} 转入。\n{inc['summary']}".strip(),
        })
        self.update("incident", incident_id,
                    {"case_id": case_id, "status": "已转案件"})
        return case_id

    # ---------- 跟进记录 ----------
    def add_followup(self, entity, entity_id, data):
        clean = {}
        for name, label, kind, _ in FOLLOWUP_FIELDS:
            try:
                clean[name] = validate_value(kind, data.get(name, ""))
            except ValueError as e:
                raise ValueError(f"{label}：{e}") from None
        if not clean["content"]:
            raise ValueError("跟进内容不能为空")
        if not clean["followed_at"]:
            clean["followed_at"] = now_str()
        keys = list(clean)
        cur = self.conn.execute(
            f"INSERT INTO followups (entity, entity_id, {', '.join(keys)}, created_at) "
            f"VALUES (?, ?, {', '.join('?' for _ in keys)}, ?)",
            [entity, entity_id] + [clean[k] for k in keys] + [now_str()])
        self.conn.execute(
            f"UPDATE {self._table(entity)} SET updated_at = ? WHERE id = ?",
            (now_str(), entity_id))
        self.conn.commit()
        return cur.lastrowid

    def followups(self, entity, entity_id):
        return [dict(r) for r in self.conn.execute(
            "SELECT * FROM followups WHERE entity = ? AND entity_id = ? "
            "ORDER BY followed_at DESC, id DESC", (entity, entity_id))]

    def delete_followup(self, followup_id):
        self.conn.execute("DELETE FROM followups WHERE id = ?", (followup_id,))
        self.conn.commit()

    # ---------- 统计与提醒 ----------
    def status_counts(self, entity):
        rows = self.conn.execute(
            f"SELECT status, COUNT(*) AS n FROM {self._table(entity)} GROUP BY status")
        return {r["status"]: r["n"] for r in rows}

    def reminders(self, within_days=3):
        """返回需要关注的未办结事项，按到期日期升序。

        包括：线索核查期限已到或临近；最近一次跟进约定的下次跟进日期已到或临近。
        """
        today = dt.date.today()
        horizon = (today + dt.timedelta(days=within_days)).strftime(DATE_FMT)
        items = []
        for entity, spec in ENTITIES.items():
            closed = CLOSED_STATUSES[entity]
            title_col = {"incident": "location", "case": "name",
                         "lead": "title"}[entity]
            for rec in self.conn.execute(f"SELECT * FROM {spec['table']}"):
                if rec["status"] in closed:
                    continue
                if entity == "lead" and rec["due_date"] and rec["due_date"] <= horizon:
                    items.append(self._reminder(entity, rec, title_col,
                                                rec["due_date"], "核查期限", today))
                last = self.conn.execute(
                    "SELECT next_date, next_action FROM followups "
                    "WHERE entity = ? AND entity_id = ? "
                    "ORDER BY followed_at DESC, id DESC LIMIT 1",
                    (entity, rec["id"])).fetchone()
                if last and last["next_date"] and last["next_date"] <= horizon:
                    what = "下次跟进"
                    if last["next_action"]:
                        what += "：" + last["next_action"]
                    items.append(self._reminder(entity, rec, title_col,
                                                last["next_date"], what, today))
        items.sort(key=lambda x: x["date"])
        return items

    @staticmethod
    def _reminder(entity, rec, title_col, date, what, today):
        days = (dt.datetime.strptime(date, DATE_FMT).date() - today).days
        if days < 0:
            state = f"已逾期 {-days} 天"
        elif days == 0:
            state = "今天到期"
        else:
            state = f"{days} 天后到期"
        return {"entity": entity, "id": rec["id"], "code": rec["code"],
                "title": rec[title_col], "status": rec["status"],
                "date": date, "what": what, "state": state, "overdue": days < 0}

    # ---------- 导出与备份 ----------
    def export_csv(self, entity, rows, path):
        """导出为 CSV，带 BOM，Excel 打开不乱码。"""
        spec = ENTITIES[entity]
        case_names = dict(self.case_choices())
        with open(path, "w", newline="", encoding="utf-8-sig") as f:
            w = csv.writer(f)
            w.writerow([f[1] for f in spec["fields"]] + ["创建时间", "更新时间"])
            for r in rows:
                line = []
                for name, _, kind, _ in spec["fields"]:
                    v = r.get(name)
                    if kind == "ref":
                        v = case_names.get(v, "") if v else ""
                    line.append(v if v is not None else "")
                w.writerow(line + [r["created_at"], r["updated_at"]])

    def backup(self, dest_path):
        self.conn.commit()
        dest = sqlite3.connect(str(dest_path))
        with dest:
            self.conn.backup(dest)
        dest.close()

