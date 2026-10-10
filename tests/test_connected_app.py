from backend import create_app


def test_frontend_assets_are_served_without_exposing_source():
    client = create_app({"TESTING": True}).test_client()
    assert b'id="app"' in client.get("/").data
    for path in ["/js/store.js", "/css/aero.css", "/Assets/Meadow1.png",
                 "/Assets/fonts/AerobicsRegular-mLRZP.ttf"]:
        assert client.get(path).status_code == 200
    for path in ["/backend/repository.py", "/requirements.txt", "/js/../app.py", "/.git/config"]:
        assert client.get(path).status_code == 404
    assert client.get("/api").json["name"] == "Meadow API"


def test_browser_snapshot_and_crud_share_one_repository():
    app = create_app({"TESTING": True})
    one, two = app.test_client(), app.test_client()
    snapshot = one.get("/api/state").json
    snapshot["state"]["users"]["u_maya"] = {"id": "u_maya", "name": "Maya"}
    saved = one.put("/api/state", json=snapshot)
    assert saved.status_code == 200
    assert two.get("/api/state").json["state"]["users"]["u_maya"]["name"] == "Maya"
    assert two.get("/api/users/u_maya").json["data"]["name"] == "Maya"
    two.post("/api/users", json={"name": "Sam"})
    assert len(one.get("/api/state").json["state"]["users"]) == 2
    # An old browser cannot overwrite the CRUD client's addition.
    assert one.put("/api/state", json=saved.json).status_code == 409
    assert two.get("/api/users").json["total"] == 2


def test_browser_conflict_and_restart_protection():
    app = create_app({"TESTING": True})
    one, two = app.test_client(), app.test_client()
    old = one.get("/api/state").json
    assert two.put("/api/state", json=old).status_code == 200
    assert one.put("/api/state", json=old).status_code == 409
    restarted = create_app({"TESTING": True}).test_client()
    assert restarted.put("/api/state", json=old).status_code == 409
    assert restarted.get("/api/state").json["state"]["users"] == {}


def test_snapshot_validation_is_atomic():
    client = create_app({"TESTING": True}).test_client()
    original = client.get("/api/state").json
    for invalid in [{}, {**original, "state": []}, {**original, "revision": True}]:
        assert client.put("/api/state", json=invalid).status_code == 400
    invalid = client.get("/api/state").json
    invalid["state"]["users"] = {"wrong": {"id": "different"}}
    assert client.put("/api/state", json=invalid).status_code == 400
    assert client.get("/api/state").json == original


def test_snapshot_updates_invalidate_crud_versions():
    client = create_app({"TESTING": True}).test_client()
    created = client.post("/api/users", json={"name": "Maya"})
    user_id = created.json["data"]["id"]
    snapshot = client.get("/api/state").json
    snapshot["state"]["users"][user_id]["name"] = "May"
    assert client.put("/api/state", json=snapshot).status_code == 200
    assert client.patch(created.headers["Location"], json={"name": "Stale", "version": 1}).status_code == 409
