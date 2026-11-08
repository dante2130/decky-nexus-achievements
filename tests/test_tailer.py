import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import main  # noqa: E402


def ev(name):
    return json.dumps({"type": "achievement", "name": name}) + "\n"


class TailerTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = Path(self.dir.name) / "events.jsonl"

    def tearDown(self):
        self.dir.cleanup()

    def test_starts_at_end_and_reads_new(self):
        self.path.write_text(ev("old"))
        t = main.Tailer(self.path)
        self.assertEqual(t.poll(), [])
        with open(self.path, "a") as f:
            f.write(ev("new"))
        self.assertEqual([e["name"] for e in t.poll()], ["new"])

    def test_malformed_partial_and_other_types(self):
        t = main.Tailer(self.path)
        t.poll()
        with open(self.path, "a") as f:
            f.write("garbage\n{\"type\":\"other\",\"name\":\"x\"}\n[1]\n" + ev("ok") + ev("partial")[:-5])
        self.assertEqual([e["name"] for e in t.poll()], ["ok"])
        with open(self.path, "a") as f:
            f.write(ev("partial")[-5:])
        self.assertEqual([e["name"] for e in t.poll()], ["partial"])

    def test_truncation_and_rotation(self):
        self.path.write_text(ev("a") * 3)
        t = main.Tailer(self.path)
        t.poll()
        self.path.write_text(ev("b"))
        self.assertEqual([e["name"] for e in t.poll()], ["b"])
        os.rename(self.path, str(self.path) + ".1")
        self.path.write_text(ev("c") + ev("d"))
        self.assertEqual([e["name"] for e in t.poll()], ["c", "d"])

    def test_file_created_after_start_read_from_beginning(self):
        t = main.Tailer(self.path)
        self.assertEqual(t.poll(), [])
        self.path.write_text(ev("first"))
        self.assertEqual([e["name"] for e in t.poll()], ["first"])

    def test_path_resolution(self):
        os.environ.pop("NEXUS_ACHIEVEMENT_EVENTS", None)
        os.environ["DECKY_USER_HOME"] = "/home/deck"
        self.assertEqual(str(main.resolve_events_path()), "/home/deck/.local/share/nexus-launcher/achievement-events.jsonl")
        os.environ["NEXUS_ACHIEVEMENT_EVENTS"] = "/tmp/e.jsonl"
        self.assertEqual(str(main.resolve_events_path()), "/tmp/e.jsonl")
        self.assertEqual(str(main.resolve_events_path("~/x.jsonl")), "/home/deck/x.jsonl")
        del os.environ["NEXUS_ACHIEVEMENT_EVENTS"]


if __name__ == "__main__":
    unittest.main()
