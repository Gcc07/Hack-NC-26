"""Transactional Tiger Data persistence and time-series projections."""
from contextlib import contextmanager
from datetime import datetime, timezone, timedelta
from pathlib import Path
import math
from .repository import RESOURCES, InMemoryRepository

class TigerUnavailable(RuntimeError):
    """Safe diagnostic without database credentials."""

    def __init__(self, message, *, detail=""):
        super().__init__(message)
        self.detail = detail

def split_sql(script):
    """psycopg executes one statement at a time."""
    lines = []
    for line in script.splitlines():
        comment = line.find("--")
        if comment >= 0:
            line = line[:comment]
        lines.append(line)
    return [part.strip() for part in "\n".join(lines).split(";") if part.strip()]

def timestamp(value, fallback=None):
    try:
        if isinstance(value, bool): return fallback
        return datetime.fromtimestamp(float(value) / 1000, timezone.utc)
    except (ValueError, TypeError, OverflowError, OSError): return fallback

def busy_slots(user, now, extra=()):
    """Project intersecting half-hours, bounded to a 91-day operational window."""
    low = math.floor((now - timedelta(days=1)).timestamp() / 1800)
    high = math.ceil((now + timedelta(days=90)).timestamp() / 1800)
    slots = set()
    for block in list(user.get("busy", [])) + list(user.get("statusBusy", [])) + list(extra):
        if not isinstance(block, (list, tuple)) or len(block) != 2: continue
        start, end = timestamp(block[0]), timestamp(block[1])
        if start is None or end is None or end <= start: continue
        a = max(low, math.floor(start.timestamp() / 1800))
        b = min(high, math.ceil(end.timestamp() / 1800))
        slots.update(range(a, b))
    return [datetime.fromtimestamp(slot * 1800, timezone.utc) for slot in sorted(slots)]

class TigerRepository:
    def __init__(self, database_url, *, connect_timeout=5):
        if not database_url: raise TigerUnavailable("TIMESCALE_SERVICE_URL is required.")
        self._database_url, self._connect_timeout = database_url, connect_timeout

    @contextmanager
    def connection(self, *, autocommit=False):
        try:
            import psycopg
            from psycopg.rows import dict_row
        except ImportError:
            raise TigerUnavailable("Install backend requirements to enable Tiger Data.") from None
        try:
            with psycopg.connect(self._database_url, connect_timeout=self._connect_timeout, row_factory=dict_row, autocommit=autocommit) as conn:
                conn.execute("SET TIME ZONE 'UTC'")
                yield conn
        except psycopg.Error as error:
            diag = getattr(error, "diag", None)
            primary = getattr(diag, "message_primary", None) if diag else None
            detail = primary[:300] if isinstance(primary, str) and "://" not in primary and "password" not in primary.lower() else ""
            raise TigerUnavailable("Tiger Data operation failed. Check connectivity and run flask --app app tiger-init on a Tiger Cloud service with TimescaleDB.", detail=detail) from None

    def initialize(self):
        """Install hypertables and search tables. Safe to run again."""
        from psycopg.types.json import Jsonb
        from .tiger_search import init_search_schema
        scripts = sorted(Path(__file__).with_name("sql").glob("*.sql"))
        # Timescale DDL is applied one statement at a time, outside a wrapping transaction.
        with self.connection(autocommit=True) as conn:
            for script in scripts:
                for statement in split_sql(script.read_text()):
                    conn.execute(statement)
        with self.connection() as conn:
            initial = InMemoryRepository().snapshot()
            conn.execute("INSERT INTO meadow_state(singleton,document,revision,instance) VALUES(true,%s,0,%s) ON CONFLICT DO NOTHING", (Jsonb(initial["state"]), initial["instance"]))
            init_search_schema(conn)

    def _load(self, conn, *, lock=False):
        row = conn.execute("SELECT document,revision,instance FROM meadow_state WHERE singleton" + (" FOR UPDATE" if lock else "")).fetchone()
        if row is None: raise TigerUnavailable("Tiger schema is not initialized. Run flask --app app tiger-init.")
        memory = InMemoryRepository()
        document = row["document"] if isinstance(row["document"], dict) else {}
        records = {}
        for name in RESOURCES:
            values = document.get(name, [] if name in ("friendships", "messages", "guestbook") else {})
            entries = values.values() if isinstance(values, dict) else values if isinstance(values, list) else []
            records[name] = {}
            for index, record in enumerate(entries):
                if not isinstance(record, dict): continue
                record_id = record.get("id")
                if not isinstance(record_id, str) or not record_id:
                    record_id = f"{record.get('a', '')}:{record.get('b', '')}:{index}" if name == "friendships" else f"{name}:{index}"
                records[name][record_id] = record
        memory._records = records
        memory._revision, memory._instance = row["revision"], row["instance"]
        return memory

    def _read(self, method, *args):
        with self.connection() as conn: return getattr(self._load(conn), method)(*args)

    def _write(self, method, *args):
        from psycopg.types.json import Jsonb
        from .tiger_search import sync_memory_documents
        with self.connection() as conn:
            memory = self._load(conn, lock=True)
            previous = memory.snapshot()["state"]
            result = getattr(memory, method)(*args)
            snapshot = memory.snapshot()
            state = snapshot["state"]
            self._project(conn, previous, state)
            if method == "delete" and args[0] == "messages":
                conn.execute("DELETE FROM meadow_messages WHERE id=%s", (args[1],))
            sync_memory_documents(conn, state)
            conn.execute("UPDATE meadow_state SET document=%s,revision=%s WHERE singleton", (Jsonb(state), snapshot["revision"]))
            return result

    def list(self, resource): return self._read("list", resource)
    def get(self, resource, record_id): return self._read("get", resource, record_id)
    def snapshot(self): return self._read("snapshot")
    def create(self, resource, data): return self._write("create", resource, data)
    def ensure(self, resource, record_id, data): return self._write("ensure", resource, record_id, data)
    def replace(self, resource, record_id, data, version): return self._write("replace", resource, record_id, data, version)
    def delete(self, resource, record_id): return self._write("delete", resource, record_id)
    def save_snapshot(self, state, revision, instance): return self._write("save_snapshot", state, revision, instance)

    def _project(self, conn, old, state):
        from psycopg.types.json import Jsonb
        now = datetime.now(timezone.utc)
        users, orgs, events = state["users"], state["orgs"], state["events"]
        for uid in old["users"].keys() - users.keys():
            for table in ("meadow_messages", "meadow_presence_events", "meadow_checkins"):
                conn.execute(f"DELETE FROM {table} WHERE user_id=%s", (uid,))
        for oid in old["orgs"].keys() - orgs.keys():
            for table in ("meadow_messages", "meadow_presence_events", "meadow_checkins"):
                conn.execute(f"DELETE FROM {table} WHERE org_id=%s", (oid,))
        if not any(state.values()):
            for table in ("meadow_messages", "meadow_presence_events", "meadow_checkins"):
                conn.execute(f"DELETE FROM {table}")
        conn.execute("DELETE FROM meadow_org_members")
        conn.execute("DELETE FROM meadow_busy_slots")
        commitments = {}
        for event in events.values():
            if event.get("status") == "cancelled": continue
            for role in event.get("roles", []):
                for uid in role.get("claims", []):
                    commitments.setdefault(uid, []).append([role.get("start", event.get("start")), role.get("end", event.get("end"))])
        with conn.cursor() as cur:
            memberships = [(oid,uid,member.get("role", "Member")) for oid,org in orgs.items() for uid,member in org.get("members", {}).items() if isinstance(member, dict)]
            slots = [(uid,slot) for uid,user in users.items() for slot in busy_slots(user,now,commitments.get(uid, []))]
            if memberships: cur.executemany("INSERT INTO meadow_org_members(org_id,user_id,role) VALUES(%s,%s,%s)", memberships)
            if slots: cur.executemany("INSERT INTO meadow_busy_slots(user_id,slot_start) VALUES(%s,%s)", slots)
        for oid,uid,_ in memberships:
            user = users.get(uid)
            if not user: continue
            before = old["users"].get(uid, {})
            new_membership = uid not in old["orgs"].get(oid, {}).get("members", {})
            if new_membership or before.get("presence") != user.get("presence"):
                conn.execute("INSERT INTO meadow_presence_events(user_id,org_id,observed_at,presence) VALUES(%s,%s,%s,%s) ON CONFLICT DO NOTHING", (uid,oid,now,user.get("presence", "offline")))
        messages = state["messages"].values() if isinstance(state["messages"], dict) else state["messages"]
        live_ids = []
        for message in messages:
            if not isinstance(message, dict) or not isinstance(message.get("id"), str) or not message["id"]: continue
            channel = message.get("channel", "")
            kind, _, target = channel.partition(":")
            oid = target if kind == "org" else events.get(target, {}).get("orgId") if kind == "event" else None
            # created_at is part of the hypertable key, so a missing timestamp must stay stable across saves.
            created = timestamp(message.get("ts"), timestamp(message.get("createdAt"))) or datetime.fromtimestamp(0, timezone.utc)
            live_ids.append(message["id"])
            conn.execute("INSERT INTO meadow_messages(id,org_id,channel,user_id,body,source,payload,created_at) VALUES(%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT(id,created_at) DO UPDATE SET body=EXCLUDED.body,source=EXCLUDED.source,payload=EXCLUDED.payload,org_id=EXCLUDED.org_id,user_id=EXCLUDED.user_id,channel=EXCLUDED.channel", (message["id"],oid,channel,message.get("userId"),message.get("text", ""),message.get("source", "app"),Jsonb(message.get("payload")),created))
        conn.execute("DELETE FROM meadow_messages WHERE NOT (id = ANY(%s::text[]))", (live_ids,))
        for eid in old["events"].keys() - events.keys():
            conn.execute("DELETE FROM meadow_checkins WHERE event_id=%s", (eid,))
            conn.execute("DELETE FROM meadow_messages WHERE channel=%s", ("event:" + eid,))
        for eid,event in events.items():
            attendees = set(event.get("attendance", []))
            prior = set(old["events"].get(eid, {}).get("attendance", []))
            for uid in prior - attendees:
                conn.execute("DELETE FROM meadow_checkins WHERE event_id=%s AND user_id=%s", (eid,uid))
            for uid in attendees - prior:
                conn.execute("INSERT INTO meadow_checkins(event_id,user_id,org_id,checked_at) VALUES(%s,%s,%s,%s) ON CONFLICT DO NOTHING", (eid,uid,event.get("orgId", ""),now))
