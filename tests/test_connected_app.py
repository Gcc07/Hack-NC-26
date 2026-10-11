from backend import create_app
from conftest import signed_in


def test_frontend_assets_are_served_without_exposing_source():
    client = signed_in(create_app({"TESTING": True}))
    assert b'id="app"' in client.get("/").data
    for path in ["/js/store.js", "/css/aero.css", "/Assets/Meadow1.png",
                 "/Assets/fonts/AerobicsRegular-mLRZP.ttf"]:
        assert client.get(path).status_code == 200
    for path in ["/backend/repository.py", "/requirements.txt", "/js/../app.py", "/.git/config"]:
        assert client.get(path).status_code == 404
    assert client.get("/api").json["name"] == "Meadow API"


def test_privacy_policy_is_public():
    client = create_app({"TESTING": True}).test_client()
    response = client.get("/privacy")
    assert response.status_code == 200
    assert b"Privacy Policy" in response.data


def test_browser_snapshot_and_crud_share_one_repository():
    app = create_app({"TESTING": True})
    one, two = signed_in(app), signed_in(app)
    snapshot = one.get("/api/state").json
    snapshot["state"]["users"]["u_maya"] = {"id": "u_maya", "name": "Maya"}
    saved = one.put("/api/state", json=snapshot)
    assert saved.status_code == 200
    assert two.get("/api/state").json["state"]["users"]["u_maya"]["name"] == "Maya"
    assert two.get("/api/users/u_maya").json["data"]["name"] == "Maya"
    two.post("/api/users", json={"name": "Sam"})
    # Two signed-in profiles, Maya and Sam.
    assert len(one.get("/api/state").json["state"]["users"]) == 4
    # An old browser cannot overwrite the CRUD client's addition.
    assert one.put("/api/state", json=saved.json).status_code == 409
    assert two.get("/api/users").json["total"] == 4


def test_browser_conflict_and_restart_protection():
    app = create_app({"TESTING": True})
    one, two = signed_in(app), signed_in(app)
    old = one.get("/api/state").json
    assert two.put("/api/state", json=old).status_code == 200
    assert one.put("/api/state", json=old).status_code == 409
    restarted = signed_in(create_app({"TESTING": True}))
    assert restarted.put("/api/state", json=old).status_code == 409
    assert list(restarted.get("/api/state").json["state"]["users"]) == [restarted.account["userId"]]


def test_snapshot_validation_is_atomic():
    client = signed_in(create_app({"TESTING": True}))
    original = client.get("/api/state").json
    for invalid in [{}, {**original, "state": []}, {**original, "revision": True}]:
        assert client.put("/api/state", json=invalid).status_code == 400
    invalid = client.get("/api/state").json
    invalid["state"]["users"] = {"wrong": {"id": "different"}}
    assert client.put("/api/state", json=invalid).status_code == 400
    assert client.get("/api/state").json == original


def test_snapshot_updates_invalidate_crud_versions():
    client = signed_in(create_app({"TESTING": True}))
    created = client.post("/api/users", json={"name": "Maya"})
    user_id = created.json["data"]["id"]
    snapshot = client.get("/api/state").json
    snapshot["state"]["users"][user_id]["name"] = "May"
    assert client.put("/api/state", json=snapshot).status_code == 200
    assert client.patch(created.headers["Location"], json={"name": "Stale", "version": 1}).status_code == 409
