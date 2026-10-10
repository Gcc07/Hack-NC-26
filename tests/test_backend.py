from concurrent.futures import ThreadPoolExecutor

import pytest

from backend import create_app
from backend.repository import InMemoryRepository, VersionConflict


@pytest.fixture
def client():
    return create_app({"TESTING": True}).test_client()


EXAMPLES = {
    "users": {"name": "Maya Chen", "busy": [[1000, 2000]]},
    "friendships": {"a": "maya", "b": "sam"},
    "orgs": {"name": "Sunrise", "members": {"maya": {"role": "President"}}},
    "events": {"orgId": "sunrise", "title": "Social", "start": 1000, "end": 2000},
    "messages": {"channel": "org:sunrise", "userId": "maya", "text": "Hello!"},
    "flares": {"eventId": "social", "roleId": "setup", "createdBy": "maya"},
    "guestbook": {"eventId": "social", "userId": "maya", "text": "Bring more pizza."},
}


@pytest.mark.parametrize("resource,body", EXAMPLES.items())
def test_crud(client, resource, body):
    url = "/api/" + resource
    created = client.post(url, json=body)
    assert created.status_code == 201
    record = created.json["data"]
    assert record["id"] and record["version"] == 1
    assert record["createdAt"] == record["updatedAt"]
    location = created.headers["Location"]
    assert client.get(location).json["data"] == record
    assert client.get(url).json["data"] == [record]
    patched = client.patch(location, json={**body, "version": record["version"]})
    assert patched.status_code == 200
    assert patched.json["data"]["version"] == 2
    assert patched.json["data"]["createdAt"] == record["createdAt"]
    assert client.delete(location).status_code == 204
    assert client.get(location).status_code == 404
    assert client.get(url).json["data"] == []


def test_app_instances_are_isolated_and_repository_is_injectable():
    repo = InMemoryRepository()
    one = create_app(repository=repo).test_client()
    shared = create_app(repository=repo).test_client()
    independent = create_app().test_client()
    one.post("/api/users", json={"name": "Maya"})
    assert shared.get("/api/users").json["total"] == 1
    assert independent.get("/api/users").json["total"] == 0


def test_storage_returns_detached_copies():
    repo = InMemoryRepository()
    data = {"name": "Maya", "busy": [[1000, 2000]]}
    user = repo.create("users", data)
    data["busy"].clear()
    user["busy"].clear()
    listed = repo.list("users")
    listed[0]["busy"].clear()
    assert repo.get("users", user["id"])["busy"] == [[1000, 2000]]


def test_patch_rejects_stale_writes_and_preserves_other_fields(client):
    created = client.post("/api/users", json={"name": "Maya", "email": "maya@example.com"})
    location = created.headers["Location"]
    assert client.patch(location, json={"name": "May", "version": 1}).status_code == 200
    assert client.patch(location, json={"name": "Stale", "version": 1}).status_code == 409
    result = client.get(location).json["data"]
    assert result["name"] == "May"
    assert result["email"] == "maya@example.com"
    assert client.patch(location, json={"name": "No version"}).status_code == 400


def test_competing_writes_are_atomic():
    repo = InMemoryRepository()
    user = repo.create("users", {"name": "Maya"})

    def update(name):
        try:
            repo.replace("users", user["id"], {"name": name}, version=1)
            return True
        except VersionConflict:
            return False

    with ThreadPoolExecutor(max_workers=8) as pool:
        outcomes = list(pool.map(update, [str(i) for i in range(20)]))
    assert sum(outcomes) == 1
    assert repo.get("users", user["id"])["version"] == 2


@pytest.mark.parametrize("resource,body", [
    ("users", []), ("users", {}), ("users", {"name": "  "}),
    ("users", {"name": "Maya", "id": "overwrite"}),
    ("users", {"name": "Maya", "busy": [[2000, 1000]]}),
    ("users", {"name": "Maya", "busy": [[True, 1000]]}),
    ("users", {"name": "Maya", "presence": "invisible"}),
    ("events", {**EXAMPLES["events"], "end": 0}),
    ("events", {**EXAMPLES["events"], "start": True}),
    ("events", {**EXAMPLES["events"], "start": float("nan")}),
    ("events", {**EXAMPLES["events"], "roles": [{"id": "r", "name": "Setup", "headcount": 0}]}),
    ("orgs", {"name": "Sunrise", "members": {"maya": {"role": []}}}),
    ("friendships", {"a": "maya", "b": "maya"}),
    ("messages", {**EXAMPLES["messages"], "channel": "unknown:x"}),
])
def test_validation_has_no_side_effects(client, resource, body):
    response = client.post("/api/" + resource, json=body)
    assert response.status_code == 400
    assert response.json["error"]["code"] == "validation_error"
    assert client.get("/api/" + resource).json["total"] == 0


def test_patch_validates_merged_record(client):
    created = client.post("/api/events", json=EXAMPLES["events"])
    location = created.headers["Location"]
    assert client.patch(location, json={"end": 500, "version": 1}).status_code == 400
    assert client.get(location).json["data"]["end"] == 2000


def test_filtering_and_pagination(client):
    for channel in ["org:a", "org:b", "org:a"]:
        client.post("/api/messages", json={**EXAMPLES["messages"], "channel": channel})
    response = client.get("/api/messages?channel=org:a&limit=1&offset=1")
    assert response.json["total"] == 2
    assert len(response.json["data"]) == 1
    assert response.json["data"][0]["channel"] == "org:a"
    for query in ["limit=0", "limit=no", "offset=-1", "limit=501", "bogus=x"]:
        assert client.get("/api/messages?" + query).status_code == 400


def test_http_errors_are_json(client):
    assert client.get("/api/health").json == {"status": "ok"}
    for path in ["/missing", "/api/missing", "/api/users/missing"]:
        response = client.get(path)
        assert response.status_code == 404 and "error" in response.json
    assert client.post("/api/users", data="not JSON").status_code == 415
    assert client.post("/api/users", data="{", content_type="application/json").status_code == 400
    response = client.put("/api/users")
    assert response.status_code == 405 and "GET" in response.headers["Allow"]
    assert "error" in response.json


def test_request_size_limit():
    client = create_app({"TESTING": True, "MAX_CONTENT_LENGTH": 20}).test_client()
    response = client.post("/api/users", json={"name": "x" * 100})
    assert response.status_code == 413
    assert response.json["error"]["code"] == "request_entity_too_large"
