"""Storage contract and a process-local implementation. No Flask dependencies."""

from copy import deepcopy
from threading import RLock
from time import time_ns
from typing import Any, Protocol
from uuid import uuid4

Record = dict[str, Any]
RESOURCES = ("users", "friendships", "orgs", "events", "messages", "flares", "guestbook")


class MissingRecord(Exception):
    pass


class VersionConflict(Exception):
    pass


class Repository(Protocol):
    """A future database adapter implements these methods without changing routes.

    Returned records are detached copies. replace must atomically compare versions
    and write, and raise VersionConflict if another request changed the record.
    """

    def list(self, resource: str) -> list[Record]: ...
    def get(self, resource: str, record_id: str) -> Record: ...
    def create(self, resource: str, data: Record) -> Record: ...
    def ensure(self, resource: str, record_id: str, data: Record) -> Record: ...
    def replace(self, resource: str, record_id: str, data: Record, version: int) -> Record: ...
    def delete(self, resource: str, record_id: str) -> None: ...
    def snapshot(self) -> Record: ...
    def save_snapshot(self, state: Record, revision: int, instance: str) -> Record: ...


class InMemoryRepository:
    """One store per app instance; restarts clear it and workers do not share it."""

    def __init__(self):
        self._records: dict[str, dict[str, Record]] = {name: {} for name in RESOURCES}
        self._lock = RLock()
        self._revision = 0
        self._instance = uuid4().hex

    def list(self, resource):
        with self._lock:
            return deepcopy(list(self._records[resource].values()))

    def get(self, resource, record_id):
        with self._lock:
            try:
                return deepcopy(self._records[resource][record_id])
            except KeyError:
                raise MissingRecord from None

    def create(self, resource, data):
        with self._lock:
            now = time_ns() // 1_000_000
            record = {**deepcopy(data), "id": uuid4().hex, "createdAt": now,
                      "updatedAt": now, "version": 1}
            self._records[resource][record["id"]] = record
            self._revision += 1
            return deepcopy(record)

    def ensure(self, resource, record_id, data):
        """Create with a client-chosen id if missing; otherwise return the existing row."""
        with self._lock:
            existing = self._records[resource].get(record_id)
            if existing is not None:
                return deepcopy(existing)
            now = time_ns() // 1_000_000
            record = {**deepcopy(data), "id": record_id, "createdAt": now,
                      "updatedAt": now, "version": 1}
            self._records[resource][record_id] = record
            self._revision += 1
            return deepcopy(record)

    def replace(self, resource, record_id, data, version):
        with self._lock:
            previous = self.get(resource, record_id)
            if previous["version"] != version:
                raise VersionConflict
            record = {**deepcopy(data), "id": record_id, "createdAt": previous["createdAt"],
                      "updatedAt": time_ns() // 1_000_000, "version": version + 1}
            self._records[resource][record_id] = record
            self._revision += 1
            return deepcopy(record)

    def delete(self, resource, record_id):
        with self._lock:
            self.get(resource, record_id)
            del self._records[resource][record_id]
            self._revision += 1

    def snapshot(self):
        with self._lock:
            state = {name: deepcopy(list(records.values()) if name in
                     ("friendships", "messages", "guestbook") else records)
                     for name, records in self._records.items()}
            return {"state": state, "revision": self._revision, "instance": self._instance}

    def save_snapshot(self, state, revision, instance):
        """Atomically replace a browser snapshot only if its base is still current."""
        with self._lock:
            if instance != self._instance or revision != self._revision:
                raise VersionConflict
            records = {}
            now = time_ns() // 1_000_000
            for name, values in state.items():
                entries = values.values() if isinstance(values, dict) else values
                records[name] = {}
                for value in entries:
                    record = deepcopy(value)
                    record_id = record.get("id") or uuid4().hex
                    previous = self._records[name].get(record_id)
                    record["id"] = record_id
                    record.setdefault("createdAt", now)
                    comparable = {k: v for k, v in record.items() if k not in ("version", "updatedAt")}
                    old = {k: v for k, v in (previous or {}).items() if k not in ("version", "updatedAt")}
                    changed = comparable != old
                    record["version"] = (previous or {}).get("version", 0) + int(changed)
                    record["updatedAt"] = now if changed else previous["updatedAt"]
                    records[name][record_id] = record
            self._records = records
            self._revision += 1
            return self.snapshot()
