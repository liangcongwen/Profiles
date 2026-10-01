import csv
import datetime as dt
import os
import tempfile
import unittest

from case_tracker.db import Database, validate_value


class DatabaseTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = Database(os.path.join(self.tmp.name, "t.db"))

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    def test_auto_code_increments(self):
        a = self.db.create("incident", {"location": "A"})
        b = self.db.create("incident", {"location": "B"})
        ca, cb = self.db.get("incident", a)["code"], self.db.get("incident", b)["code"]
        self.assertTrue(ca.startswith("JQ" + dt.date.today().strftime("%Y%m%d")))
        self.assertTrue(ca.endswith("-001"))
        self.assertTrue(cb.endswith("-002"))

    def test_duplicate_code_rejected(self):
        self.db.create("case", {"code": "AJ-1", "name": "x"})
        with self.assertRaises(ValueError):
            self.db.create("case", {"code": "AJ-1", "name": "y"})

    def test_date_validation(self):
        self.assertEqual(validate_value("datetime", "2026-01-02"), "2026-01-02 00:00")
        self.assertEqual(validate_value("date", " 2026-01-02 "), "2026-01-02")
        with self.assertRaises(ValueError):
            validate_value("date", "2026/01/02")
        with self.assertRaises(ValueError):
            self.db.create("lead", {"due_date": "明天"})

    def test_search_filters(self):
        self.db.create("incident", {"location": "人民路", "status": "待处置",
                                    "reported_at": "2026-03-01 10:00"})
        self.db.create("incident", {"location": "解放路", "status": "已处置",
                                    "reported_at": "2026-03-05 10:00"})
        self.assertEqual(len(self.db.search("incident", "人民")), 1)
        self.assertEqual(len(self.db.search("incident", status="已处置")), 1)
        self.assertEqual(len(self.db.search("incident", date_from="2026-03-02")), 1)
        self.assertEqual(len(self.db.search("incident", date_to="2026-03-05")), 2)

    def test_incident_to_case_links_both(self):
        iid = self.db.create("incident", {"location": "人民路", "category": "治安",
                                          "officer": "张三", "summary": "打架"})
        cid = self.db.incident_to_case(iid)
        inc = self.db.get("incident", iid)
        self.assertEqual(inc["case_id"], cid)
        self.assertEqual(inc["status"], "已转案件")
        case = self.db.get("case", cid)
        self.assertEqual(case["lead_officer"], "张三")
        self.assertIn("打架", case["summary"])
        self.assertEqual(len(self.db.linked("incident", cid)), 1)
        with self.assertRaises(ValueError):
            self.db.incident_to_case(iid)

    def test_deleting_case_unlinks_leads(self):
        cid = self.db.create("case", {"name": "x"})
        lid = self.db.create("lead", {"title": "t", "case_id": cid})
        self.db.delete("case", cid)
        self.assertIsNone(self.db.get("lead", lid)["case_id"])

    def test_followups_and_reminders(self):
        today = dt.date.today()
        past = (today - dt.timedelta(days=2)).isoformat()
        far = (today + dt.timedelta(days=30)).isoformat()
        overdue = self.db.create("lead", {"title": "逾期", "status": "核查中",
                                          "due_date": past})
        self.db.create("lead", {"title": "远期", "status": "核查中", "due_date": far})
        self.db.create("lead", {"title": "已办结", "status": "已排除",
                                "due_date": past})
        cid = self.db.create("case", {"name": "案", "status": "侦查中"})
        self.db.add_followup("case", cid, {"content": "走访", "next_date":
                                           today.isoformat(), "next_action": "调监控"})
        with self.assertRaises(ValueError):
            self.db.add_followup("case", cid, {"content": ""})
        self.assertEqual(len(self.db.followups("case", cid)), 1)

        rem = self.db.reminders()
        self.assertEqual([(r["entity"], r["title"]) for r in rem],
                         [("lead", "逾期"), ("case", "案")])
        self.assertTrue(rem[0]["overdue"])
        self.assertEqual(rem[0]["state"], "已逾期 2 天")
        self.assertIn("调监控", rem[1]["what"])
        self.assertEqual(rem[1]["state"], "今天到期")

        self.db.delete("lead", overdue)
        self.assertEqual(len(self.db.reminders()), 1)

    def test_export_and_backup(self):
        cid = self.db.create("case", {"name": "盗窃案"})
        self.db.create("lead", {"title": "线索", "case_id": cid})
        path = os.path.join(self.tmp.name, "out.csv")
        self.db.export_csv("lead", self.db.search("lead"), path)
        with open(path, encoding="utf-8-sig") as f:
            rows = list(csv.reader(f))
        self.assertEqual(rows[0][0], "线索编号")
        self.assertIn("盗窃案", " ".join(rows[1]))

        bak = os.path.join(self.tmp.name, "bak.db")
        self.db.backup(bak)
        other = Database(bak)
        self.assertEqual(len(other.search("case")), 1)
        other.close()


if __name__ == "__main__":
    unittest.main()
