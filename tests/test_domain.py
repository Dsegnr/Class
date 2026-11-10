import itertools
import json
import unittest
from collections import Counter
from pathlib import Path

from backend.domain import (
    ADMIN_ID, HISTORICAL_SELECTED_NAMES, INITIAL_EXCLUDED_NAMES,
    Member, draw, duty_order, duty_preview, eligible_pool, student_accounts,
)


def example_roster():
    # Independent synthetic roster covers the domain; tests never require private data.
    special = {201: "示例同学03", 202: "示例同学04", 203: "示例同学05", 204: "示例同学06",
               205: "示例同学07", 206: "示例同学08", 208: "示例同学10", 210: "示例同学12",
               213: "示例同学15", 215: "示例同学17", 216: "示例同学18", 221: "示例同学23",
               226: "示例同学28", 232: "示例同学34", 212: "示例同学14"}
    rows = [Member(f"900000000{i:03d}", special.get(i, f"测试{i}")) for i in range(201, 233)]
    rows += [Member(sid, name) for sid, name in [
        ("900000000901", "示例同学01"), ("900000000902", "示例同学02"),
        ("900000000903", "示例同学35"), ("900000000904", "示例同学36"), ("900000000905", "示例同学37")]]
    return rows


class DomainTests(unittest.TestCase):
    def setUp(self):
        self.roster = example_roster()

    def test_account_count_and_admin_membership(self):
        self.assertEqual(36, len(student_accounts(self.roster)))
        self.assertEqual(37, len(self.roster))
        self.assertNotIn(ADMIN_ID, {m.student_id for m in student_accounts(self.roster)})

    def test_next_pool_matches_actual_history(self):
        ids = lambda names: {m.student_id for m in self.roster if m.name in names}
        pool = eligible_pool(self.roster, ids(INITIAL_EXCLUDED_NAMES), ids(HISTORICAL_SELECTED_NAMES))
        self.assertEqual(24, len(pool))
        self.assertIn(ADMIN_ID, {m.student_id for m in pool})
        picked = draw(pool, 3)
        later = eligible_pool(self.roster, ids(INITIAL_EXCLUDED_NAMES),
                              ids(HISTORICAL_SELECTED_NAMES) | {m.student_id for m in picked})
        self.assertEqual(21, len(later))
        self.assertFalse(set(picked) & set(later))

    def test_exhaustive_uniformity_small_population(self):
        pool = self.roster[:4]
        ordered, subsets = Counter(), Counter()
        for choices in itertools.product(range(4), range(3)):
            iterator = iter(choices)
            selected = draw(pool, 2, lambda _: next(iterator))
            ordered[tuple(m.student_id for m in selected)] += 1
            subsets[frozenset(m.student_id for m in selected)] += 1
        self.assertEqual(12, len(ordered))
        self.assertEqual({1}, set(ordered.values()))
        self.assertEqual(6, len(subsets))
        self.assertEqual({2}, set(subsets.values()))

    def test_no_pool_mutation_or_duplicate(self):
        original = list(self.roster)
        self.assertEqual(37, len(set(draw(self.roster, 37))))
        self.assertEqual(original, self.roster)

    def test_invalid_draws_fail_without_reset(self):
        for count in [0, -1, 38, True, 1.5]:
            with self.assertRaises(ValueError):
                draw(self.roster, count)
        with self.assertRaises(ValueError):
            draw([], 1)
        with self.assertRaises(ValueError):
            draw(self.roster, 1, lambda n: n)
        with self.assertRaises(ValueError):
            eligible_pool(self.roster, {"unknown"}, set())
        with self.assertRaises(ValueError):
            draw([self.roster[0]] * 2, 1)

    def test_duty_next_five_and_wrap(self):
        order = duty_order(self.roster)
        self.assertEqual("示例同学03", order[0].name)
        self.assertEqual(["示例同学04", "示例同学05", "示例同学06", "示例同学07", "示例同学08"],
                         [m.name for m in duty_preview(order, 1)])
        self.assertEqual(["示例同学37", "示例同学03", "示例同学04", "示例同学05", "示例同学06"],
                         [m.name for m in duty_preview(order, 34)])
        self.assertEqual(order, duty_order(list(reversed(self.roster))))
        self.assertEqual(35, len(order))
        self.assertEqual(["示例同学01", "示例同学02", "示例同学37"], [m.name for m in order[32:]])
        self.assertFalse({"示例同学36", "示例同学35"} & {m.name for m in order})
        seven_groups = [p for group in range(7) for p in duty_preview(order, (1 + 5 * group) % len(order))]
        self.assertEqual(Counter(m.student_id for m in order), Counter(m.student_id for m in seven_groups))
        self.assertTrue({"示例同学36", "示例同学35"}.issubset({m.name for m in student_accounts(self.roster)}))

    def test_actual_roster_if_available(self):
        path = Path(__file__).resolve().parents[1] / "private/roster.json"
        if not path.exists():
            self.skipTest("真实名册不随源码分发")
        actual = [Member(**m) for m in json.loads(path.read_text(encoding="utf-8"))]
        self.assertEqual(37, len(actual))
        self.assertEqual(36, len(student_accounts(actual)))
        self.assertEqual(35, len(duty_order(actual)))


if __name__ == "__main__":
    unittest.main()
