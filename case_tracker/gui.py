"""Tkinter 桌面界面。"""

import datetime as dt
import os
import subprocess
import sys
import tkinter as tk
import tkinter.font as tkfont
from tkinter import filedialog, messagebox, ttk

from . import __version__
from .db import Database, now_str
from .schema import CLOSED_STATUSES, ENTITIES, FOLLOWUP_FIELDS

APP_TITLE = "警情案件线索跟进系统"
NO_CASE = "（无）"


def data_dir():
    """数据目录：可用环境变量指定，否则放在程序旁边的 data 文件夹。"""
    custom = os.environ.get("CASE_TRACKER_DATA")
    if custom:
        base = custom
    elif getattr(sys, "frozen", False):
        base = os.path.join(os.path.dirname(sys.executable), "data")
    else:
        base = os.path.join(os.path.dirname(os.path.dirname(
            os.path.abspath(__file__))), "data")
    os.makedirs(base, exist_ok=True)
    return base


def open_folder(path):
    if sys.platform.startswith("win"):
        os.startfile(path)  # noqa: S606 仅在 Windows 上存在
    elif sys.platform == "darwin":
        subprocess.Popen(["open", path])
    else:
        subprocess.Popen(["xdg-open", path])


# ---------------------------------------------------------------- 表单控件
class FormField:
    """把一个字段定义渲染为输入控件，并负责取值和赋值。"""

    def __init__(self, parent, db, key, label, kind, extra, row):
        self.db, self.key, self.kind = db, key, kind
        ttk.Label(parent, text=label + "：").grid(
            row=row, column=0, sticky="ne" if kind == "long" else "e",
            padx=(0, 6), pady=3)
        self.case_map = {}
        if kind == "long":
            self.widget = tk.Text(parent, height=5, width=48, wrap="word",
                                  font=tkfont.nametofont("TkDefaultFont"))
            self.widget.grid(row=row, column=1, columnspan=2, sticky="nsew", pady=3)
        elif kind == "choice":
            self.var = tk.StringVar()
            self.widget = ttk.Combobox(parent, textvariable=self.var,
                                       values=extra, width=46)
            self.widget.grid(row=row, column=1, columnspan=2, sticky="ew", pady=3)
        elif kind == "ref":
            self.var = tk.StringVar(value=NO_CASE)
            self.case_map = {label: cid for cid, label in db.case_choices()}
            self.widget = ttk.Combobox(parent, textvariable=self.var,
                                       state="readonly", width=46,
                                       values=[NO_CASE] + list(self.case_map))
            self.widget.grid(row=row, column=1, columnspan=2, sticky="ew", pady=3)
        else:
            self.var = tk.StringVar()
            box = ttk.Frame(parent)
            box.grid(row=row, column=1, columnspan=2, sticky="ew", pady=3)
            self.widget = ttk.Entry(box, textvariable=self.var, width=20)
            self.widget.pack(side="left", fill="x", expand=True)
            if kind in ("datetime", "date"):
                ttk.Button(box, text="现在" if kind == "datetime" else "今天",
                           width=5, command=self.set_now).pack(
                               side="left", padx=(6, 0))

    def set_now(self):
        if self.kind == "datetime":
            self.var.set(now_str())
        else:
            self.var.set(dt.date.today().isoformat())

    def get(self):
        if self.kind == "long":
            return self.widget.get("1.0", "end").strip()
        if self.kind == "ref":
            return self.case_map.get(self.var.get())
        return self.var.get().strip()

    def set(self, value):
        if self.kind == "long":
            self.widget.delete("1.0", "end")
            self.widget.insert("1.0", value or "")
        elif self.kind == "ref":
            label = next((lb for lb, cid in self.case_map.items()
                          if cid == value), NO_CASE)
            self.var.set(label)
        else:
            self.var.set(value or "")


# ---------------------------------------------------------------- 记录编辑窗口
class RecordDialog(tk.Toplevel):
    """新增或编辑一条记录。已有记录右侧显示跟进记录。"""

    def __init__(self, app, entity, record_id=None):
        super().__init__(app.root)
        self.app, self.db, self.entity = app, app.db, entity
        self.record_id = record_id
        spec = ENTITIES[entity]
        self.title(("编辑" if record_id else "新增") + spec["label"])
        self.transient(app.root)
        self.minsize(720, 520)

        body = ttk.Frame(self, padding=10)
        body.pack(fill="both", expand=True)
        body.columnconfigure(0, weight=3)
        body.columnconfigure(1, weight=2)
        body.rowconfigure(0, weight=1)

        form = ttk.LabelFrame(body, text=spec["label"] + "信息", padding=8)
        form.grid(row=0, column=0, sticky="nsew")
        form.columnconfigure(1, weight=1)
        self.fields = {}
        for i, (key, label, kind, extra) in enumerate(spec["fields"]):
            self.fields[key] = FormField(form, self.db, key, label, kind, extra, i)
            if kind == "long":
                form.rowconfigure(i, weight=1)

        btns = ttk.Frame(body)
        btns.grid(row=1, column=0, sticky="ew", pady=(8, 0))
        ttk.Button(btns, text="保存", command=self.save).pack(side="right")
        ttk.Button(btns, text="关闭", command=self.destroy).pack(
            side="right", padx=6)
        if entity == "incident" and record_id:
            ttk.Button(btns, text="转为案件", command=self.to_case).pack(side="left")

        self.side = ttk.Frame(body)
        self.side.grid(row=0, column=1, rowspan=2, sticky="nsew", padx=(10, 0))
        self.load()
        self.bind("<Control-s>", lambda e: self.save())
        self.geometry("1100x700")
        self.grab_set()

    # 读取 / 保存
    def load(self):
        if self.record_id:
            rec = self.db.get(self.entity, self.record_id)
            for key, field in self.fields.items():
                field.set(rec.get(key))
            self.build_side()
        else:
            self.fields["code"].set(self.db.next_code(self.entity))
            first_status = ENTITIES[self.entity]["fields"]
            for key, _, kind, extra in first_status:
                if kind == "datetime":
                    self.fields[key].set(now_str())
                if key == "status":
                    self.fields[key].set(extra[0])
                if key == "priority":
                    self.fields[key].set("中")
            ttk.Label(self.side, text="保存后可在此添加跟进记录。",
                      foreground="#888").pack(anchor="nw", pady=20)

    def save(self):
        data = {k: f.get() for k, f in self.fields.items()}
        try:
            if self.record_id:
                self.db.update(self.entity, self.record_id, data)
            else:
                self.record_id = self.db.create(self.entity, data)
                self.title("编辑" + ENTITIES[self.entity]["label"])
                for w in self.side.winfo_children():
                    w.destroy()
                self.build_side()
        except ValueError as e:
            messagebox.showerror("无法保存", str(e), parent=self)
            return
        self.app.refresh_all()
        self.app.status(f"已保存 {data.get('code') or ''}")

    def to_case(self):
        if not messagebox.askyesno("转为案件", "根据该警情新建一个案件并关联？",
                                   parent=self):
            return
        self.save()
        try:
            case_id = self.db.incident_to_case(self.record_id)
        except ValueError as e:
            messagebox.showerror("无法转案件", str(e), parent=self)
            return
        self.app.refresh_all()
        self.destroy()
        RecordDialog(self.app, "case", case_id)

    # 右侧：跟进记录与关联
    def build_side(self):
        nb = ttk.Notebook(self.side)
        nb.pack(fill="both", expand=True)

        page = ttk.Frame(nb, padding=8)
        nb.add(page, text="跟进记录")
        page.columnconfigure(0, weight=1)
        page.rowconfigure(0, weight=1)
        self.fu_tree = ttk.Treeview(page, columns=("t", "who", "content", "next"),
                                    show="headings", height=6)
        for col, text, w in (("t", "时间", 120), ("who", "跟进人", 60),
                             ("content", "内容", 160), ("next", "下次", 90)):
            self.fu_tree.heading(col, text=text)
            self.fu_tree.column(col, width=w, stretch=col == "content")
        self.fu_tree.grid(row=0, column=0, sticky="nsew")
        sb = ttk.Scrollbar(page, orient="vertical", command=self.fu_tree.yview)
        sb.grid(row=0, column=1, sticky="ns")
        self.fu_tree.configure(yscrollcommand=sb.set)
        self.fu_tree.bind("<<TreeviewSelect>>", self.show_followup)
        self.fu_detail = tk.Text(page, height=3, wrap="word", state="disabled",
                                 background="#f6f6f6", relief="flat",
                                 font=tkfont.nametofont("TkDefaultFont"))
        self.fu_detail.grid(row=1, column=0, columnspan=2, sticky="ew", pady=(6, 0))
        ttk.Button(page, text="删除选中跟进", command=self.delete_followup).grid(
            row=2, column=0, columnspan=2, sticky="e", pady=(4, 0))

        add = ttk.LabelFrame(page, text="新增跟进", padding=6)
        add.grid(row=3, column=0, columnspan=2, sticky="ew", pady=(6, 0))
        add.columnconfigure(1, weight=1)
        self.fu_fields = {}
        for i, (key, label, kind, extra) in enumerate(FOLLOWUP_FIELDS):
            f = FormField(add, self.db, key, label, kind, extra, i)
            if kind == "long":
                f.widget.configure(height=3, width=30)
            self.fu_fields[key] = f
        self.fu_fields["followed_at"].set(now_str())
        ttk.Button(add, text="添加跟进", command=self.add_followup).grid(
            row=len(FOLLOWUP_FIELDS), column=1, columnspan=2, sticky="e", pady=(4, 0))

        if self.entity == "case":
            link = ttk.Frame(nb, padding=8)
            nb.add(link, text="关联警情 / 线索")
            ttk.Label(link, text="警情或线索里选择“关联案件”后会显示在这里，双击打开。",
                      foreground="#666").pack(anchor="w", pady=(0, 6))
            self.link_tree = ttk.Treeview(link, columns=("type", "code", "title", "st"),
                                          show="headings")
            for col, text, w in (("type", "类型", 50), ("code", "编号", 140),
                                 ("title", "摘要", 160), ("st", "状态", 70)):
                self.link_tree.heading(col, text=text)
                self.link_tree.column(col, width=w, stretch=col == "title")
            self.link_tree.pack(fill="both", expand=True)
            self.link_tree.bind("<Double-1>", self.open_linked)
            self.link_tab, self.side_nb = link, nb

        self.refresh_side()

    def refresh_side(self):
        self.fu_tree.delete(*self.fu_tree.get_children())
        self.fu_rows = {}
        for r in self.db.followups(self.entity, self.record_id):
            nxt = r["next_date"]
            iid = self.fu_tree.insert("", "end", values=(
                r["followed_at"], r["officer"],
                r["content"].replace("\n", " "), nxt))
            self.fu_rows[iid] = r
        if self.entity == "case":
            self.link_tree.delete(*self.link_tree.get_children())
            for ent, col in (("incident", "location"), ("lead", "title")):
                for r in self.db.linked(ent, self.record_id):
                    self.link_tree.insert("", "end", iid=f"{ent}:{r['id']}", values=(
                        ENTITIES[ent]["label"], r["code"], r[col], r["status"]))
            n = len(self.link_tree.get_children())
            self.side_nb.tab(self.link_tab, text=f"关联警情 / 线索（{n}）")

    def show_followup(self, _event=None):
        sel = self.fu_tree.selection()
        if not sel:
            return
        r = self.fu_rows[sel[0]]
        text = f"{r['followed_at']}  {r['officer']}\n{r['content']}"
        if r["next_action"] or r["next_date"]:
            text += f"\n下一步：{r['next_action']}  {r['next_date']}"
        self.fu_detail.configure(state="normal")
        self.fu_detail.delete("1.0", "end")
        self.fu_detail.insert("1.0", text)
        self.fu_detail.configure(state="disabled")

    def add_followup(self):
        data = {k: f.get() for k, f in self.fu_fields.items()}
        try:
            self.db.add_followup(self.entity, self.record_id, data)
        except ValueError as e:
            messagebox.showerror("无法添加", str(e), parent=self)
            return
        for key, f in self.fu_fields.items():
            f.set("")
        self.fu_fields["followed_at"].set(now_str())
        self.fu_fields["officer"].set(data["officer"])
        self.refresh_side()
        self.app.refresh_all()

    def delete_followup(self):
        sel = self.fu_tree.selection()
        if not sel:
            return
        if messagebox.askyesno("删除", "确定删除选中的跟进记录？", parent=self):
            self.db.delete_followup(self.fu_rows[sel[0]]["id"])
            self.refresh_side()
            self.app.refresh_all()

    def open_linked(self, _event=None):
        sel = self.link_tree.selection()
        if sel:
            ent, rid = sel[0].split(":")
            RecordDialog(self.app, ent, int(rid))


# ---------------------------------------------------------------- 列表页
class EntityTab(ttk.Frame):
    def __init__(self, app, parent, entity):
        super().__init__(parent, padding=8)
        self.app, self.db, self.entity = app, app.db, entity
        spec = ENTITIES[entity]
        self.columns = spec["list_columns"]
        labels = {f[0]: f[1] for f in spec["fields"]}
        statuses = next(f[3] for f in spec["fields"] if f[0] == "status")

        bar = ttk.Frame(self)
        bar.pack(fill="x")
        ttk.Button(bar, text="新增" + spec["label"], command=self.new).pack(side="left")
        ttk.Button(bar, text="编辑 / 跟进", command=self.edit).pack(side="left", padx=4)
        ttk.Button(bar, text="删除", command=self.delete).pack(side="left")
        if entity == "incident":
            ttk.Button(bar, text="转为案件", command=self.to_case).pack(
                side="left", padx=4)
        ttk.Button(bar, text="导出 Excel(CSV)", command=self.export).pack(side="right")

        flt = ttk.Frame(self)
        flt.pack(fill="x", pady=8)
        ttk.Label(flt, text="关键字").pack(side="left")
        self.kw = tk.StringVar()
        kw_entry = ttk.Entry(flt, textvariable=self.kw, width=20)
        kw_entry.pack(side="left", padx=(4, 10))
        kw_entry.bind("<Return>", lambda e: self.refresh())
        ttk.Label(flt, text="状态").pack(side="left")
        self.st = tk.StringVar(value="全部")
        st_box = ttk.Combobox(flt, textvariable=self.st, state="readonly", width=10,
                              values=["全部", "未办结"] + statuses)
        st_box.pack(side="left", padx=(4, 10))
        st_box.bind("<<ComboboxSelected>>", lambda e: self.refresh())
        ttk.Label(flt, text="日期从").pack(side="left")
        self.d1 = tk.StringVar()
        ttk.Entry(flt, textvariable=self.d1, width=11).pack(side="left", padx=4)
        ttk.Label(flt, text="至").pack(side="left")
        self.d2 = tk.StringVar()
        ttk.Entry(flt, textvariable=self.d2, width=11).pack(side="left", padx=(4, 10))
        ttk.Button(flt, text="查询", command=self.refresh).pack(side="left")
        ttk.Button(flt, text="重置", command=self.reset).pack(side="left", padx=4)
        self.count = ttk.Label(flt, foreground="#555")
        self.count.pack(side="right")

        box = ttk.Frame(self)
        box.pack(fill="both", expand=True)
        cols = self.columns + ["followups", "updated_at"]
        self.tree = ttk.Treeview(box, columns=cols, show="headings",
                                 selectmode="browse")
        widths = {"code": 150, "reported_at": 130, "filed_at": 130,
                  "received_at": 130, "due_date": 100, "status": 80,
                  "category": 70, "priority": 60, "followups": 60,
                  "updated_at": 130}
        heads = dict(labels, followups="跟进数", updated_at="最近更新")
        for c in cols:
            self.tree.heading(c, text=heads[c], command=lambda c=c: self.sort_by(c))
            self.tree.column(c, width=widths.get(c, 180),
                             stretch=c not in widths, anchor="w")
        self.tree.tag_configure("closed", foreground="#999")
        self.tree.tag_configure("overdue", foreground="#c0392b")
        self.tree.pack(side="left", fill="both", expand=True)
        sb = ttk.Scrollbar(box, orient="vertical", command=self.tree.yview)
        sb.pack(side="right", fill="y")
        self.tree.configure(yscrollcommand=sb.set)
        self.tree.bind("<Double-1>", lambda e: self.edit())
        self.tree.bind("<Delete>", lambda e: self.delete())
        self.rows = []
        self.sort_col, self.sort_desc = None, False
        self.refresh()

    def selected_id(self):
        sel = self.tree.selection()
        if not sel:
            messagebox.showinfo("提示", "请先在列表中选中一条记录。")
            return None
        return int(sel[0])

    def query(self):
        status = self.st.get()
        try:
            rows = self.db.search(self.entity, self.kw.get().strip(),
                                  "" if status in ("全部", "未办结") else status,
                                  self.d1.get().strip(), self.d2.get().strip())
        except ValueError as e:
            messagebox.showerror("筛选条件有误", str(e))
            return None
        if status == "未办结":
            closed = CLOSED_STATUSES[self.entity]
            rows = [r for r in rows if r["status"] not in closed]
        return rows

    def refresh(self):
        rows = self.query()
        if rows is None:
            return
        self.rows = rows
        if self.sort_col:
            self.rows.sort(key=lambda r: str(r.get(self.sort_col) or ""),
                           reverse=self.sort_desc)
        self.tree.delete(*self.tree.get_children())
        today = dt.date.today().isoformat()
        closed = CLOSED_STATUSES[self.entity]
        counts = dict(self.db.conn.execute(
            "SELECT entity_id, COUNT(*) FROM followups WHERE entity = ? "
            "GROUP BY entity_id", (self.entity,)).fetchall())
        for r in self.rows:
            tag = ()
            if r["status"] in closed:
                tag = ("closed",)
            elif r.get("due_date") and r["due_date"] < today:
                tag = ("overdue",)
            values = [r.get(c) or "" for c in self.columns]
            values += [counts.get(r["id"], 0), r["updated_at"]]
            self.tree.insert("", "end", iid=str(r["id"]), values=values, tags=tag)
        self.count.configure(text=f"共 {len(self.rows)} 条")

    def sort_by(self, col):
        if col in ("followups",):
            return
        self.sort_desc = not self.sort_desc if self.sort_col == col else False
        self.sort_col = col
        self.refresh()

    def reset(self):
        self.kw.set("")
        self.st.set("全部")
        self.d1.set("")
        self.d2.set("")
        self.sort_col = None
        self.refresh()

    def new(self):
        RecordDialog(self.app, self.entity)

    def edit(self):
        rid = self.selected_id()
        if rid:
            RecordDialog(self.app, self.entity, rid)

    def delete(self):
        rid = self.selected_id()
        if not rid:
            return
        rec = self.db.get(self.entity, rid)
        msg = f"确定删除 {rec['code']}？其跟进记录也会一并删除，且无法恢复。"
        if self.entity == "case":
            msg += "\n关联的警情和线索会保留，但会解除关联。"
        if messagebox.askyesno("删除确认", msg, icon="warning"):
            self.db.delete(self.entity, rid)
            self.app.refresh_all()

    def to_case(self):
        rid = self.selected_id()
        if not rid:
            return
        if not messagebox.askyesno("转为案件", "根据该警情新建一个案件并关联？"):
            return
        try:
            case_id = self.db.incident_to_case(rid)
        except ValueError as e:
            messagebox.showerror("无法转案件", str(e))
            return
        self.app.refresh_all()
        RecordDialog(self.app, "case", case_id)

    def export(self):
        label = ENTITIES[self.entity]["label"]
        path = filedialog.asksaveasfilename(
            title="导出" + label, defaultextension=".csv",
            initialfile=f"{label}_{dt.date.today():%Y%m%d}.csv",
            filetypes=[("CSV（Excel 可打开）", "*.csv")])
        if not path:
            return
        try:
            self.db.export_csv(self.entity, self.rows, path)
        except OSError as e:
            messagebox.showerror("导出失败", f"{e}\n文件可能正在被 Excel 打开。")
            return
        self.app.status(f"已导出 {len(self.rows)} 条{label}到 {path}")


# ---------------------------------------------------------------- 工作台
class DashboardTab(ttk.Frame):
    def __init__(self, app, parent):
        super().__init__(parent, padding=10)
        self.app, self.db = app, app.db

        self.cards = ttk.Frame(self)
        self.cards.pack(fill="x")

        head = ttk.Frame(self)
        head.pack(fill="x", pady=(14, 4))
        ttk.Label(head, text="待办提醒（逾期及 3 天内到期，双击打开）",
                  font=app.bold_font).pack(side="left")
        ttk.Button(head, text="刷新", command=self.refresh).pack(side="right")

        box = ttk.Frame(self)
        box.pack(fill="both", expand=True)
        cols = ("state", "type", "code", "title", "what", "date", "status")
        self.tree = ttk.Treeview(box, columns=cols, show="headings")
        for c, text, w in (("state", "到期情况", 100), ("type", "类型", 50),
                           ("code", "编号", 150), ("title", "摘要", 200),
                           ("what", "事项", 260), ("date", "日期", 100),
                           ("status", "当前状态", 80)):
            self.tree.heading(c, text=text)
            self.tree.column(c, width=w, stretch=c in ("title", "what"))
        self.tree.tag_configure("overdue", foreground="#c0392b")
        self.tree.pack(side="left", fill="both", expand=True)
        sb = ttk.Scrollbar(box, orient="vertical", command=self.tree.yview)
        sb.pack(side="right", fill="y")
        self.tree.configure(yscrollcommand=sb.set)
        self.tree.bind("<Double-1>", self.open_item)
        self.refresh()

    def refresh(self):
        for w in self.cards.winfo_children():
            w.destroy()
        for i, (entity, spec) in enumerate(ENTITIES.items()):
            counts = self.db.status_counts(entity)
            total = sum(counts.values())
            open_n = sum(n for s, n in counts.items()
                         if s not in CLOSED_STATUSES[entity])
            card = ttk.LabelFrame(self.cards, text=spec["label"], padding=10)
            card.grid(row=0, column=i, sticky="nsew", padx=(0 if i == 0 else 8, 0))
            self.cards.columnconfigure(i, weight=1)
            ttk.Label(card, text=f"未办结 {open_n}", font=self.app.big_font).pack(
                anchor="w")
            ttk.Label(card, text=f"总计 {total}", foreground="#666").pack(anchor="w")
            statuses = next(f[3] for f in spec["fields"] if f[0] == "status")
            detail = "  ".join(f"{s} {counts.get(s, 0)}" for s in statuses)
            ttk.Label(card, text=detail, foreground="#444", wraplength=300).pack(
                anchor="w", pady=(6, 0))

        self.tree.delete(*self.tree.get_children())
        for n, r in enumerate(self.db.reminders()):
            self.tree.insert("", "end", iid=f"{r['entity']}:{r['id']}:{n}", values=(
                r["state"], ENTITIES[r["entity"]]["label"], r["code"], r["title"],
                r["what"], r["date"], r["status"]),
                tags=("overdue",) if r["overdue"] else ())

    def open_item(self, _event=None):
        sel = self.tree.selection()
        if sel:
            ent, rid, _ = sel[0].split(":")
            RecordDialog(self.app, ent, int(rid))


# ---------------------------------------------------------------- 主程序
class App:
    def __init__(self, root, db_path=None):
        self.root = root
        self.data_dir = data_dir()
        self.db = Database(db_path or os.path.join(self.data_dir, "case_tracker.db"))
        root.title(APP_TITLE)
        root.geometry("1200x720")
        root.minsize(900, 560)
        self.setup_style()
        self.build_menu()

        self.nb = ttk.Notebook(root)
        self.nb.pack(fill="both", expand=True, padx=6, pady=(6, 0))
        self.dashboard = DashboardTab(self, self.nb)
        self.nb.add(self.dashboard, text="  工作台  ")
        self.tabs = {}
        for entity, spec in ENTITIES.items():
            tab = EntityTab(self, self.nb, entity)
            self.tabs[entity] = tab
            self.nb.add(tab, text=f"  {spec['label']}  ")

        self.status_var = tk.StringVar(value=f"数据文件：{self.db.path}")
        ttk.Label(root, textvariable=self.status_var, anchor="w",
                  padding=(8, 3), foreground="#555").pack(fill="x")
        root.protocol("WM_DELETE_WINDOW", self.quit)

    def setup_style(self):
        family = None
        available = set(tkfont.families(self.root))
        for name in ("Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC",
                     "Noto Sans CJK SC", "WenQuanYi Micro Hei", "WenQuanYi Zen Hei"):
            if name in available:
                family = name
                break
        for fname in ("TkDefaultFont", "TkTextFont", "TkHeadingFont", "TkMenuFont"):
            f = tkfont.nametofont(fname)
            if family:
                f.configure(family=family)
            f.configure(size=10)
        base = tkfont.nametofont("TkDefaultFont")
        self.bold_font = base.copy()
        self.bold_font.configure(weight="bold", size=11)
        self.big_font = base.copy()
        self.big_font.configure(weight="bold", size=16)
        style = ttk.Style(self.root)
        if "vista" in style.theme_names():
            style.theme_use("vista")
        elif "clam" in style.theme_names():
            style.theme_use("clam")
        style.configure("Treeview", rowheight=26)

    def build_menu(self):
        menubar = tk.Menu(self.root)
        file_menu = tk.Menu(menubar, tearoff=False)
        file_menu.add_command(label="备份数据库…", command=self.backup)
        file_menu.add_command(label="打开数据目录",
                              command=lambda: open_folder(self.data_dir))
        file_menu.add_separator()
        file_menu.add_command(label="退出", command=self.quit)
        menubar.add_cascade(label="文件", menu=file_menu)
        help_menu = tk.Menu(menubar, tearoff=False)
        help_menu.add_command(label="关于", command=self.about)
        menubar.add_cascade(label="帮助", menu=help_menu)
        self.root.config(menu=menubar)

    def refresh_all(self):
        self.dashboard.refresh()
        for tab in self.tabs.values():
            tab.refresh()

    def status(self, text):
        self.status_var.set(text)

    def backup(self):
        path = filedialog.asksaveasfilename(
            title="备份数据库", defaultextension=".db",
            initialfile=f"case_tracker_备份_{dt.datetime.now():%Y%m%d_%H%M}.db",
            filetypes=[("数据库文件", "*.db")])
        if path:
            self.db.backup(path)
            self.status(f"已备份到 {path}")
            messagebox.showinfo("备份完成", f"数据已备份到：\n{path}")

    def about(self):
        messagebox.showinfo("关于", f"{APP_TITLE}\n版本 {__version__}\n\n"
                            f"数据文件：\n{self.db.path}\n\n"
                            "数据仅保存在本机，请定期使用“文件 → 备份数据库”。")

    def quit(self):
        self.db.close()
        self.root.destroy()


def main():
    if sys.platform.startswith("win"):
        try:  # 高分屏下字体清晰
            import ctypes
            ctypes.windll.shcore.SetProcessDpiAwareness(1)
        except Exception:  # noqa: BLE001
            pass
    root = tk.Tk()
    App(root)
    root.mainloop()
