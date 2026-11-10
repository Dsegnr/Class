"""Pure business rules, with no database or UI dependencies.

The persistence layer must freeze the pool and commit draw, notifications and
cycle membership in one transaction. These helpers do not claim to do so.
"""
from dataclasses import dataclass
from secrets import randbelow
from typing import Callable, Sequence


@dataclass(frozen=True)
class Member:
    student_id: str
    name: str


ADMIN_ID = "900000000213"
INITIAL_EXCLUDED_NAMES = frozenset({
    "示例同学17", "示例同学28", "示例同学02", "示例同学18", "示例同学07", "示例同学12",
    "示例同学08", "示例同学37", "示例同学34", "示例同学14",
})
HISTORICAL_SELECTED_NAMES = frozenset({"示例同学10", "示例同学35", "示例同学23"})
EXTRA_DUTY_NAMES = ("示例同学01", "示例同学02", "示例同学35", "示例同学36", "示例同学37")
PHYSICS_EXEMPT_NAMES = frozenset({"示例同学36", "示例同学35"})
ALGORITHM_VERSION = "fisher-yates-partial-v1"


def validate_roster(members: Sequence[Member]) -> None:
    ids = [m.student_id for m in members]
    if not ids or len(ids) != len(set(ids)):
        raise ValueError("名册不能为空或有重复学号")
    if any(not m.student_id.isascii() or not m.student_id.isdigit()
           or len(m.student_id) != 12 or not m.name.strip() for m in members):
        raise ValueError("名册姓名或学号无效")


def student_accounts(members: Sequence[Member]) -> list[Member]:
    validate_roster(members)
    if sum(m.student_id == ADMIN_ID for m in members) != 1:
        raise ValueError("管理员必须对应唯一名册成员")
    return [m for m in members if m.student_id != ADMIN_ID]


def eligible_pool(members: Sequence[Member], excluded_ids: set[str],
                  selected_ids: set[str]) -> list[Member]:
    validate_roster(members)
    ids = {m.student_id for m in members}
    if (excluded_ids | selected_ids) - ids:
        raise ValueError("排除/已选记录含未知学号")
    return sorted((m for m in members
                   if m.student_id not in excluded_ids | selected_ids),
                  key=lambda m: m.student_id)


def draw(pool: Sequence[Member], count: int,
         random_below: Callable[[int], int] = randbelow) -> list[Member]:
    """Uniform ordered k-sample if random_below(n) is uniform on [0,n).

    At step i each of n-i remaining people has probability 1/(n-i).
    Each unordered subset therefore has probability 1 / C(n,k).
    Injection is only for exhaustive tests; production uses secrets.randbelow.
    """
    validate_roster(pool)
    if isinstance(count, bool) or not isinstance(count, int) or not 1 <= count <= len(pool):
        raise ValueError("抽取人数必须在1与候选人数之间，不自动重置轮次")
    result = list(pool)
    for i in range(count):
        offset = random_below(len(result) - i)
        if isinstance(offset, bool) or not isinstance(offset, int) or not 0 <= offset < len(result) - i:
            raise ValueError("随机源返回值超出范围")
        j = i + offset
        result[i], result[j] = result[j], result[i]
    return result[:count]


def duty_order(members: Sequence[Member]) -> list[Member]:
    validate_roster(members)
    by_id = {m.student_id: m for m in members}
    by_name = {m.name: m for m in members}
    if len(by_name) != len(members):
        raise ValueError("历史值日初始化存在同名，需人工确认")
    try:
        result = [by_id[f"900000000{i:03d}"] for i in range(201, 233)]
        result += [by_name[name] for name in EXTRA_DUTY_NAMES]
    except KeyError as error:
        raise ValueError("值日名册缺失预期成员") from error
    if len(result) != len(members) or {m.student_id for m in result} != set(by_id):
        raise ValueError("值日顺序必须恰好覆盖名册一次")
    # Filter physics duty only; accounts, tasks and activity draws stay intact.
    return [m for m in result if m.name not in PHYSICS_EXEMPT_NAMES]


def duty_preview(order: Sequence[Member], next_index: int, count: int = 5) -> list[Member]:
    validate_roster(order)
    if isinstance(next_index, bool) or not isinstance(next_index, int) or not 0 <= next_index < len(order):
        raise ValueError("值日游标无效")
    if isinstance(count, bool) or not isinstance(count, int) or not 1 <= count <= len(order):
        raise ValueError("值日人数无效")
    return [order[(next_index + i) % len(order)] for i in range(count)]


def duty_assignments(order: Sequence[Member], next_index: int,
                     replacements: dict[str, str]) -> list[Member]:
    """A date-specific assignment; the original rotation never moves here."""
    original = duty_preview(order, next_index)
    members = {m.student_id: m for m in order}
    if len(replacements) > 5 or set(replacements) - {m.student_id for m in original}:
        raise ValueError("只能调整这组原排的5位同学")
    if set(replacements.values()) - set(members):
        raise ValueError("替班同学必须在物理实验值日名单中")
    if any(before == after for before, after in replacements.items()):
        raise ValueError("恢复原排请移除该项替班，不需填写相同学号")
    result = [members[replacements.get(m.student_id, m.student_id)] for m in original]
    if len({m.student_id for m in result}) != 5:
        raise ValueError("调整后须为5位不同的同学，不能重复安排")
    return result
