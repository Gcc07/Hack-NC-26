import itertools

_names = itertools.count()


def signed_in(app):
    """A test client with a fresh password account and live session cookie."""
    client = app.test_client()
    username = f"tester_{next(_names)}"
    response = client.post("/api/auth/signup", json={
        "username": username, "password": "correct horse battery", "name": "Test User"})
    assert response.status_code == 201, response.json
    client.account = response.json["account"]
    return client
