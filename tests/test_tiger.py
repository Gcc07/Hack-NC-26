from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from backend import create_app
from backend.tiger_repository import TigerUnavailable, busy_slots, split_sql
from backend.tiger_search import memory_documents


def test_schema_script_is_one_statement_per_call():
    script = split_sql(Path("backend/sql/001_tiger.sql").read_text(encoding="utf-8"))
    assert script[0].startswith("CREATE EXTENSION")
    joined = "\n".join(script)
    assert "create_hypertable" in joined
    assert "timescaledb.continuous" in joined
    assert "add_columnstore_policy" in joined
    assert all(";" not in statement and not statement.startswith("--") for statement in script)


def test_busy_slots_are_half_hours_inside_the_window():
    now = datetime(2026, 10, 10, 12, tzinfo=timezone.utc)
    start = int(now.timestamp() * 1000)
    end = start + 60 * 60 * 1000
    slots = busy_slots({"busy": [[start, end]], "statusBusy": []}, now)
    assert slots == [now, now + timedelta(minutes=30)]
    far = now + timedelta(days=200)
    distant = [int(far.timestamp() * 1000), int((far + timedelta(hours=1)).timestamp() * 1000)]
    assert busy_slots({"busy": [distant, [end, start], "nope", [True, 1]]}, now) == []


def test_memory_documents_stay_inside_one_org():
    state = {
        "orgs": {
            "org-a": {"id": "org-a", "name": "Sunrise", "handoff": {"text": "Room booking form"}},
            "org-b": {"id": "org-b", "name": "Other", "handoff": {"text": "Secret budget"}},
        },
        "events": {
            "social": {"id": "social", "orgId": "org-a", "title": "Social", "description": "Order pizza"},
        },
        "guestbook": [{"id": "g1", "eventId": "social", "text": "Bring napkins"}],
        "messages": [{"id": "m1", "channel": "org:org-a", "source": "assistant", "text": "**Summary** — booked the quad", "payload": {"type": "summary"}}],
    }
    docs = {doc["id"]: doc for doc in memory_documents(state)}
    assert set(docs) == {"event:social", "handoff:org-a", "guestbook:g1", "summary:m1", "handoff:org-b"}
    assert docs["handoff:org-a"]["url"].endswith("/board")
    assert docs["guestbook:g1"]["event_id"] == "social"
    assert all(doc["org_id"] == "org-a" or doc["id"] == "handoff:org-b" for doc in docs.values())


def _save(client, mutate):
    snapshot = client.get("/api/state").json
    mutate(snapshot["state"])
    saved = client.put("/api/state", json=snapshot)
    assert saved.status_code == 200
    return saved.json


def _seed(client):
    recent = datetime.now(timezone.utc) - timedelta(hours=1)
    old = datetime.now(timezone.utc) - timedelta(days=40)
    stamp = lambda value: int(value.timestamp() * 1000)

    def fill(state):
        state["users"]["maya"] = {"id": "maya", "name": "Maya Chen"}
        state["orgs"]["org-a"] = {"id": "org-a", "name": "Sunrise", "members": {"maya": {"role": "President"}},
                                  "handoff": {"text": "The room booking form lives in the drive.", "ts": stamp(recent)}}
        state["orgs"]["org-b"] = {"id": "org-b", "name": "Other", "members": {}}
        state["events"]["social"] = {"id": "social", "orgId": "org-a", "title": "Welcome Social",
                                     "start": stamp(recent), "end": stamp(recent) + 3_600_000,
                                     "attendance": ["maya"], "description": "Order pizza from the usual place."}
        state["guestbook"] = [{"id": "g1", "eventId": "social", "userId": "maya", "text": "Bring more napkins next year.", "ts": stamp(recent)}]
        state["messages"] = [
            {"id": "m1", "channel": "org:org-a", "userId": "maya", "text": "See you at the fair", "ts": stamp(recent), "source": "app"},
            {"id": "m2", "channel": "org:org-a", "userId": None, "text": "**Summary** — We booked the quad.", "ts": stamp(recent), "source": "assistant", "payload": {"type": "summary"}},
            {"id": "m3", "channel": "org:org-b", "userId": "maya", "text": "private planning note", "ts": stamp(recent), "source": "app"},
            {"id": "m4", "channel": "org:org-a", "userId": "maya", "text": "ancient", "ts": stamp(old), "source": "app"},
        ]
    _save(client, fill)
    return recent


@pytest.fixture
def client():
    return create_app({"TESTING": True}).test_client()


def test_org_insights_and_memory_search(client):
    recent = _seed(client)
    insights = client.get("/api/orgs/org-a/insights?days=14")
    assert insights.status_code == 200
    body = insights.json
    assert body["backend"] == "memory"
    assert len(body["activity"]) == 24
    assert body["totals"] == {"messages": 2, "checkins": 1}
    assert body["preferredHours"] == [recent.hour]
    assert body["participation"] == [{"userId": "maya", "name": "Maya Chen", "checkins": 1}]
    assert client.get("/api/orgs/org-b/insights").json["totals"]["messages"] == 1

    napkins = client.get("/api/orgs/org-a/memory?q=napkins").json
    assert [item["source"] for item in napkins["results"]] == ["guestbook"]
    assert napkins["results"][0]["eventId"] == "social"
    assert "pizza" in client.get("/api/orgs/org-a/memory?q=pizza").json["results"][0]["snippet"]
    handoff = client.get("/api/orgs/org-a/memory?q=booking").json["results"][0]
    assert handoff["source"] == "handoff" and handoff["url"].endswith("/board")
    assert client.get("/api/orgs/org-a/memory?q=quad").json["results"][0]["source"] == "summary"
    assert client.get("/api/orgs/org-a/memory?q=private").json["results"] == []
    assert client.get("/api/orgs/missing/insights").status_code == 404
    assert client.get("/api/orgs/org-a/insights?days=0").status_code == 400
    assert client.get("/api/orgs/org-a/memory?q=").status_code == 400
    assert client.get("/api/orgs/org-a/memory?q=pizza&limit=0").status_code == 400


def test_tiger_setup_commands_wait_for_configuration():
    app = create_app({"TESTING": True})
    runner = app.test_cli_runner()
    for command in (["tiger-init"], ["tiger-index-memory"]):
        result = runner.invoke(args=command)
        assert result.exit_code != 0
        assert "STORAGE_BACKEND=tiger" in result.output
    with pytest.raises(ValueError, match="TIMESCALE_SERVICE_URL"):
        create_app({"STORAGE_BACKEND": "tiger", "DATABASE_URL": ""})


def test_unit_tests_do_not_open_a_developer_tiger_database(monkeypatch):
    monkeypatch.setenv("STORAGE_BACKEND", "tiger")
    monkeypatch.setenv("TIMESCALE_SERVICE_URL", "postgresql://user:secret@example.test/meadow")
    client = create_app({"TESTING": True}).test_client()
    assert client.post("/api/users", json={"name": "Maya"}).status_code == 201


def test_tiger_failures_do_not_leak_credentials():
    class Boom:
        def snapshot(self):
            raise TigerUnavailable("Tiger schema is not initialized. Run flask --app app tiger-init.", detail="postgresql://user:secret@db.example/meadow")

    client = create_app({"TESTING": True}, repository=Boom()).test_client()
    response = client.get("/api/state")
    assert response.status_code == 503
    assert response.json["error"]["code"] == "storage_unavailable"
    text = response.get_data(as_text=True)
    assert "secret" not in text and "postgresql://" not in text
