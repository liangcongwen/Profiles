"""三类业务记录的字段定义。界面和数据库都由这里驱动。"""

# 字段类型：text 单行文本，long 多行文本，choice 下拉选择，
# datetime 日期时间，date 日期，ref 关联其他记录（存 id）。

INCIDENT_STATUSES = ["待处置", "处置中", "已处置", "已转案件", "无效警情"]
CASE_STATUSES = ["受理", "立案", "侦查中", "移送起诉", "已结案", "撤案"]
LEAD_STATUSES = ["待核查", "核查中", "已核实", "已排除", "已移交"]

# 视为“已办结”的状态，不再出现在待办提醒里。
CLOSED_STATUSES = {
    "incident": {"已处置", "已转案件", "无效警情"},
    "case": {"已结案", "撤案"},
    "lead": {"已核实", "已排除", "已移交"},
}

ENTITIES = {
    "incident": {
        "label": "警情",
        "table": "incidents",
        "code_prefix": "JQ",
        "fields": [
            ("code", "警情编号", "text", None),
            ("reported_at", "报警时间", "datetime", None),
            ("category", "警情类别", "choice",
             ["刑事", "治安", "交通", "纠纷", "求助", "火灾", "其他"]),
            ("status", "状态", "choice", INCIDENT_STATUSES),
            ("reporter", "报警人", "text", None),
            ("phone", "联系电话", "text", None),
            ("location", "发生地点", "text", None),
            ("officer", "处置民警", "text", None),
            ("case_id", "关联案件", "ref", "case"),
            ("summary", "简要情况", "long", None),
            ("result", "处置结果", "long", None),
        ],
        "list_columns": ["code", "reported_at", "category", "status",
                         "location", "officer"],
    },
    "case": {
        "label": "案件",
        "table": "cases",
        "code_prefix": "AJ",
        "fields": [
            ("code", "案件编号", "text", None),
            ("name", "案件名称", "text", None),
            ("category", "案件类别", "choice",
             ["盗窃", "诈骗", "抢劫", "伤害", "毒品", "经济", "网络", "其他"]),
            ("status", "状态", "choice", CASE_STATUSES),
            ("filed_at", "受案时间", "datetime", None),
            ("location", "案发地点", "text", None),
            ("lead_officer", "主办民警", "text", None),
            ("assist_officers", "协办民警", "text", None),
            ("victim", "当事人/受害人", "text", None),
            ("suspect", "嫌疑人", "text", None),
            ("loss", "涉案金额/损失", "text", None),
            ("summary", "简要案情", "long", None),
        ],
        "list_columns": ["code", "name", "category", "status", "filed_at",
                         "lead_officer"],
    },
    "lead": {
        "label": "线索",
        "table": "leads",
        "code_prefix": "XS",
        "fields": [
            ("code", "线索编号", "text", None),
            ("title", "线索摘要", "text", None),
            ("source", "线索来源", "choice",
             ["群众举报", "网络巡查", "上级交办", "研判发现", "协查通报", "其他"]),
            ("priority", "优先级", "choice", ["高", "中", "低"]),
            ("status", "状态", "choice", LEAD_STATUSES),
            ("received_at", "接收时间", "datetime", None),
            ("due_date", "核查期限", "date", None),
            ("owner", "负责人", "text", None),
            ("case_id", "关联案件", "ref", "case"),
            ("content", "线索内容", "long", None),
            ("result", "核查结果", "long", None),
        ],
        "list_columns": ["code", "title", "priority", "status",
                         "due_date", "owner"],
    },
}

FOLLOWUP_FIELDS = [
    ("followed_at", "跟进时间", "datetime", None),
    ("officer", "跟进人", "text", None),
    ("content", "跟进内容", "long", None),
    ("next_action", "下一步工作", "text", None),
    ("next_date", "下次跟进日期", "date", None),
]


def field_names(entity):
    return [f[0] for f in ENTITIES[entity]["fields"]]


def field_label(entity, key):
    for name, label, _, _ in ENTITIES[entity]["fields"]:
        if name == key:
            return label
    return key
