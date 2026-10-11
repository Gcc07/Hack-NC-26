"""Optional browser check: pip install playwright; playwright install chromium.

Run: python scripts/browser_smoke.py
Set CHROME_PATH to use an existing Chrome binary instead of bundled Chromium.
"""

import os
import logging
from pathlib import Path
import sys
from threading import Thread

from playwright.sync_api import sync_playwright, expect
from werkzeug.serving import make_server

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend import create_app


app = create_app({"TESTING": True})
api = app.test_client()
assert api.post("/api/auth/signup", json={"username": "smoke_api", "password": "smoke test pass", "name": "API"}).status_code == 201
logging.getLogger("werkzeug").setLevel(logging.ERROR)
server = make_server("127.0.0.1", 0, app, threaded=True)
thread = Thread(target=server.serve_forever, daemon=True)
thread.start()
url = f"http://127.0.0.1:{server.server_port}"
try:
    with sync_playwright() as p:
        options = {"executable_path": os.environ["CHROME_PATH"]} if os.environ.get("CHROME_PATH") else {}
        browser = p.chromium.launch(headless=True, **options)
        first = browser.new_context()
        page = first.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(url)

        def sign_up(pg, name, username, password="smoke test pass"):
            pg.get_by_role("button", name="Create an account").click()
            pg.get_by_label("Display name").fill(name)
            pg.get_by_label("Username").fill(username)
            pg.get_by_label("Password", exact=True).fill(password)
            pg.get_by_label("Confirm password").fill(password)
            pg.get_by_role("button", name="Create account").click()

        # Accounts: sign-up, duplicate usernames, logout, wrong password, login.
        expect(page.get_by_role("button", name="Sign in", exact=True)).to_be_visible()
        assert page.evaluate("fetch('/api/state').then(r => r.status)") == 401
        sign_up(page, "Smoke Tester", "smoke_api")
        expect(page.get_by_text("That username is already taken.")).to_be_visible()
        page.get_by_label("Username").fill("smoke_one")
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_role("button", name="Sign out")).to_be_visible(timeout=15000)
        page.get_by_role("button", name="Sign out").click()
        page.get_by_label("Username").fill("smoke_one")
        page.get_by_label("Password").fill("wrong password")
        page.get_by_role("button", name="Sign in", exact=True).click()
        expect(page.get_by_text("Incorrect username or password.")).to_be_visible()
        page.get_by_label("Password").fill("smoke test pass")
        page.get_by_role("button", name="Sign in", exact=True).click()
        page.get_by_role("button", name="Load demo org").click()
        page.get_by_role("tab", name="Chat", exact=True).click()
        expect(page.get_by_role("textbox", name="Message", exact=True)).to_be_visible()
        page.evaluate("Meadow.store.flush()")
        org_id = page.evaluate("Object.keys(Meadow.store.get().orgs)[0]")
        maya_id = page.evaluate("Meadow.me().id")
        users = page.evaluate("Object.values(Meadow.store.get().users)")
        sam_id = next(user["id"] for user in users if user["name"] == "Sam Okafor")
        second = browser.new_context()
        other = second.new_page()
        other.on("pageerror", lambda error: errors.append(str(error)))
        other.goto(url)
        sign_up(other, "Second Tester", "smoke_two")
        expect(other.get_by_role("button", name="Sign out")).to_be_visible(timeout=15000)
        other.goto(f"{url}/#/as/{maya_id}")  # real profiles cannot be borrowed
        other.wait_for_function("Meadow.me() !== null")
        assert other.evaluate("Meadow.me().name") == "Second Tester"
        other.goto(f"{url}/#/as/{sam_id}")
        other.wait_for_function("Meadow.me() !== null")
        other.evaluate("Meadow.store.flush()")
        other.goto(f"{url}/#/o/{org_id}/chat")
        page.reload()
        expect(page.get_by_role("textbox", name="Message", exact=True)).to_be_visible()
        page.evaluate("Meadow.store.flush()")
        page.get_by_role("textbox", name="Message", exact=True).fill("Hello from browser one")
        page.get_by_role("button", name="Send", exact=True).click()
        page.evaluate("Meadow.store.flush()")
        expect(other.get_by_text("Hello from browser one", exact=True)).to_be_visible(timeout=30000)
        page.reload()
        expect(page.get_by_text("Hello from browser one", exact=True)).to_be_visible()
        page.evaluate("Meadow.store.flush()")
        assert page.evaluate("localStorage.getItem('meadow:v1')") is None
        # Failed saves must be visible and recoverable without losing the draft.
        page.route("**/api/state", lambda route: route.abort() if route.request.method == "PUT" else route.continue_())
        page.get_by_role("textbox", name="Message", exact=True).fill("Retry this message")
        page.get_by_role("button", name="Send", exact=True).click()
        expect(page.get_by_role("button", name="Retry", exact=True)).to_be_visible()
        page.unroute("**/api/state")
        page.get_by_role("button", name="Retry", exact=True).click()
        expect(page.locator("#connection-status")).to_have_text("Connected to Meadow")
        expect(other.get_by_text("Retry this message", exact=True)).to_be_visible(timeout=30000)
        data = api.get("/api/state").json["state"]
        assert data["users"][maya_id]["name"] == "Smoke Tester"
        assert sum(m["text"] == "Retry this message" for m in data["messages"]) == 1
        # Existing role and calendar actions also go through the shared store.
        claimed = page.evaluate("""async () => {
          const s = Meadow.store.get();
          const ev = Object.values(s.events).find(e => e.roles.some(r => r.claims.length < r.headcount && !r.claims.includes(Meadow.me().id)));
          const role = ev.roles.find(r => r.claims.length < r.headcount && !r.claims.includes(Meadow.me().id));
          Meadow.act.claimRole(ev.id, role.id, Meadow.me().id);
          await Meadow.store.flush();
          return {eventId: ev.id, roleId: role.id, userId: Meadow.me().id};
        }""")
        other.wait_for_function("""({eventId, roleId, userId}) =>
          Meadow.store.get().events[eventId].roles.find(r => r.id === roleId).claims.includes(userId)
        """, arg=claimed)
        page.evaluate("""async () => {
          Meadow.act.setBusy(Meadow.me().id, [[1000, 2000]], {source: 'ics', name: 'Test calendar'});
          await Meadow.store.flush();
        }""")
        assert api.get("/api/state").json["state"]["users"][maya_id]["busy"] == [[1000, 2000]]
        # Force a stale base and verify it cannot overwrite another client.
        page.route("**/api/state", lambda route: route.abort() if route.request.method == "GET" else route.continue_())
        api.post("/api/users", json={"name": "Concurrent newcomer"})
        page.evaluate("Meadow.act.setStatus(Meadow.me().id, {away: 'Stale status'})")
        expect(page.get_by_text("Another tab changed the data. Reloading; please repeat your last action.", exact=True)).to_be_visible()
        page.unroute("**/api/state")
        page.evaluate("Meadow.store.retry()")
        expect(page.locator("#connection-status")).to_have_text("Connected to Meadow")
        assert any(u["name"] == "Concurrent newcomer" for u in api.get("/api/state").json["state"]["users"].values())
        assert api.get("/api/state").json["state"]["users"][maya_id]["away"] != "Stale status"
        assert not errors, errors
        browser.close()
        print("Browser smoke passed: accounts, demo, shared chat, reload, save retry, role claims, calendars, and conflict recovery.")
finally:
    server.shutdown()
    thread.join()
