import uuid

import pytest
from sqlalchemy import select

from backend.database import Event, Notification, Rotation
from backend.domain import duty_assignments, duty_order, duty_preview
from tests.test_api import clients, seed_db
from tests.test_domain import example_roster


def body(state, pairs=None, reason="活动冲突，已协商替班"):
    return {"key": str(uuid.uuid4()), "expected_version": state["plan_version"],
            "replacements": pairs if pairs is not None else [
                {"original_id": state["base_next"][0]["student_id"], "substitute_id": "900000000201"}],
            "reason": reason}


def test_assignment_does_not_move_or_reorder_rotation():
    order = duty_order(example_roster())
    before = list(order)
    replacements = {"900000000202": "900000000201", "900000000203": "900000000213"}
    actual = duty_assignments(order, 1, replacements)
    assert order == before
    assert [p.student_id for p in actual[:2]] == ["900000000201", "900000000213"]
    assert actual[2:] == duty_preview(order, 1)[2:]
    swapped = duty_assignments(order, 1, {"900000000202": "900000000203", "900000000203": "900000000202"})
    assert len(set(swapped)) == 5
    for invalid in [{"900000000201": "900000000207"}, {"900000000202": "000000000000"},
                    {"900000000202": "900000000203"}, {"900000000202": "900000000202"}]:
        with pytest.raises(ValueError):
            duty_assignments(order, 1, invalid)


def test_plan_persists_through_reschedule_and_completion_uses_actual_five(clients):
    app, admin, student, _ = clients
    initial = student.get('/api/duty').json()
    pairs = [{"original_id": "900000000202", "substitute_id": "900000000201"},
             {"original_id": "900000000203", "substitute_id": "900000000213"}]
    request = body(initial, pairs)
    response = admin.post('/api/duty/plan', json=request)
    assert response.status_code == 200, response.text
    assert admin.post('/api/duty/plan', json=request).json() == response.json()
    state = student.get('/api/duty').json()
    assert state['date'] == initial['date'] and state['next_index'] == 1
    assert state['base_next'] == initial['next'] and state['plan_version'] != initial['plan_version']
    assert state['next'][:2] == [initial['order'][0], initial['order'][12]]
    with app.state.factory() as db:
        assert len(list(db.scalars(select(Event).where(Event.kind == 'duty_plan')))) == 1
        notices = list(db.scalars(select(Notification).where(Notification.title == '物理值日人员调整')))
        assert len(notices) == 7 and len({n.student_id for n in notices}) == 7
    # A browser showing the original people cannot confirm or change the date.
    stale = {'key': str(uuid.uuid4()), 'expected_index': 1, 'date': initial['date'], 'expected_version': initial['plan_version']}
    assert admin.post('/api/duty/confirm', json=stale).status_code == 409
    assert admin.post('/api/duty/confirm', json={k: v for k, v in stale.items() if k != 'expected_version'}).status_code == 409
    assert admin.post('/api/duty/schedule', json={'date': '2026-11-16', 'reason': '实验调课调整', 'expected_version': initial['plan_version']}).status_code == 409
    schedule = {'date': '2026-11-16', 'reason': '实验调课调整', 'expected_version': state['plan_version'], 'key': str(uuid.uuid4())}
    assert admin.post('/api/duty/schedule', json=schedule).status_code == 200
    assert admin.post('/api/duty/schedule', json=schedule).status_code == 200
    moved = student.get('/api/duty').json()
    assert moved['next'] == state['next'] and moved['next_index'] == 1
    assert moved['plan_version'] != state['plan_version']
    confirm = {'key': str(uuid.uuid4()), 'date': moved['date'], 'expected_index': moved['next_index'], 'expected_version': moved['plan_version']}
    completed = admin.post('/api/duty/confirm', json=confirm)
    assert completed.status_code == 200 and completed.json()['payload']['members'] == moved['next']
    assert admin.post('/api/duty/confirm', json=confirm).json() == completed.json()
    assert admin.post('/api/duty/confirm', json={**confirm, 'expected_index': 2}).status_code == 409
    later = student.get('/api/duty').json()
    assert later['next_index'] == 6 and later['date'] == '2026-11-23'
    assert later['next'] == later['base_next'] and later['replacements'] == []
    assert admin.post('/api/duty/plan', json=request).json() == response.json()
    assert student.get('/api/duty').json() == later  # Late retry never recreates an old plan.


def test_restore_original_and_optimistic_revision_prevent_stale_changes(clients):
    _, admin, student, _ = clients
    initial = student.get('/api/duty').json()
    request = body(initial)
    assert admin.post('/api/duty/plan', json=request).status_code == 200
    changed = student.get('/api/duty').json()
    assert admin.post('/api/duty/plan', json=body(initial, [], '恢复原来轮值')).status_code == 409
    assert admin.post('/api/duty/plan', json={**request, 'reason': '同一请求改说明'}).status_code == 409
    assert admin.post('/api/duty/plan', json=body(changed, [], '恢复原来轮值')).status_code == 200
    restored = student.get('/api/duty').json()
    assert restored['next'] == initial['next'] and restored['date'] == initial['date']
    assert len(restored['plan_events']) == 2 and restored['plan_events'][0]['payload']['revision'] == 2
    assert restored['plan_version'] != initial['plan_version']
    assert admin.post('/api/duty/plan', json=body(restored, [], '原排无变化重复')).status_code == 400


@pytest.mark.parametrize('pairs', [
    [{'original_id': '900000000207', 'substitute_id': '900000000201'}],
    [{'original_id': '900000000202', 'substitute_id': '000000000000'}],
    [{'original_id': '900000000202', 'substitute_id': '900000000202'}],
    [{'original_id': '900000000202', 'substitute_id': '900000000203'}],
    [{'original_id': '900000000202', 'substitute_id': '900000000201'}, {'original_id': '900000000202', 'substitute_id': '900000000213'}],
])
def test_invalid_plan_leaves_rotation_and_notifications_untouched(clients, pairs):
    app, admin, student, _ = clients
    state = admin.get('/api/duty').json()
    request = body(state, pairs)
    assert admin.post('/api/duty/plan', json=request).status_code == 400
    assert student.post('/api/duty/plan', json=request).status_code == 403
    assert admin.post('/api/duty/plan', json=body(state, reason='   ')).status_code == 400
    assert admin.get('/api/duty').json() == state
    with app.state.factory() as db:
        assert not list(db.scalars(select(Notification).where(Notification.title == '物理值日人员调整')))


def test_date_back_to_original_still_invalidates_old_version(clients):
    _, admin, student, _ = clients
    original = student.get('/api/duty').json()
    for day in ['2026-11-16', original['date']]:
        state = admin.get('/api/duty').json()
        assert admin.post('/api/duty/schedule', json={'date': day, 'reason': '课表变更调整', 'expected_version': state['plan_version']}).status_code == 200
    latest = student.get('/api/duty').json()
    assert latest['date'] == original['date'] and latest['next'] == original['next']
    assert latest['plan_version'] != original['plan_version']


def test_cached_old_ui_without_version_cannot_confirm_or_reschedule_even_original_group(clients):
    _, admin, _, _ = clients
    initial = admin.get('/api/duty').json()
    assert admin.post('/api/duty/confirm', json={'key': str(uuid.uuid4()), 'date': initial['date'],
        'expected_index': initial['next_index']}).status_code == 409
    assert admin.post('/api/duty/schedule', json={'date': '2026-11-16', 'reason': '旧页面调课请求'}).status_code == 409
    assert admin.get('/api/duty').json() == initial


def test_plan_invalidates_unaffected_student_realtime_snapshot(clients):
    from backend.realtime import snapshot
    from backend.security import digest
    app, admin, student, _ = clients
    token = digest(student.cookies['class_session'])
    before = snapshot(app.state.factory, token)
    state = admin.get('/api/duty').json()
    request = body(state, [{'original_id': '900000000202', 'substitute_id': '900000000208'}])
    assert admin.post('/api/duty/plan', json=request).status_code == 200
    assert snapshot(app.state.factory, token) != before


@pytest.mark.parametrize('sid', ['900000000904', '900000000903'])
def test_physics_exempt_members_keep_class_access_but_cannot_substitute(clients, sid):
    _, admin, student, _ = clients
    state = student.get('/api/duty').json()
    assert len(state['order']) == 35
    assert {p['name'] for p in state['exempt']} == {'示例同学36', '示例同学35'}
    assert sid not in {p['student_id'] for p in state['order']}
    assert sid in {p['student_id'] for p in admin.get('/api/members').json()}
    assert len(admin.get('/api/members').json()) == 37
    assert len(student.get('/api/draw').json()['eligible']) == 24
    request = body(state, [{'original_id': state['base_next'][0]['student_id'], 'substitute_id': sid}])
    assert admin.post('/api/duty/plan', json=request).status_code == 400
    assert admin.get('/api/duty').json() == state
    assert student.post('/api/auth/login', json={'student_id': sid, 'password': 'local-test-fixture-password'}).status_code == 200
    assert student.get('/api/tasks').status_code == 200


def test_35_person_wrap_and_old_37_person_version_cannot_confirm(clients):
    import hashlib
    import json
    app, admin, _, _ = clients
    baseline = admin.get('/api/duty').json()
    old_version = hashlib.sha256(json.dumps([0, 0, 1, baseline['date'], None], separators=(',', ':')).encode()).hexdigest()
    assert old_version != baseline['plan_version']
    assert admin.post('/api/duty/confirm', json={'key': str(uuid.uuid4()), 'date': baseline['date'],
        'expected_index': 1, 'expected_version': old_version}).status_code == 409
    with app.state.factory() as db:
        db.get(Rotation, 1).duty_index = 34
        db.commit()
    tail = admin.get('/api/duty').json()
    assert [m['name'] for m in tail['next']] == ['示例同学37', '示例同学03', '示例同学04', '示例同学05', '示例同学06']
    assert admin.post('/api/duty/confirm', json={'key': str(uuid.uuid4()), 'date': tail['date'],
        'expected_index': tail['next_index'], 'expected_version': tail['plan_version']}).status_code == 200
    later = admin.get('/api/duty').json()
    assert later['next_index'] == 4 and later['date'] == '2026-11-16'
    assert len(later['order']) == 35
