"""JSON record validation, independent of HTTP and storage implementation.

Field names follow the existing browser model. These are storage endpoints,
not authenticated business actions (join, claim a role, etc.).
"""

from copy import deepcopy
from math import isfinite
from time import time_ns


class ValidationError(Exception):
    pass


# Required fields and their JSON types. bool must not count as a number.
SCHEMAS = {
    "users": {"name": str},
    "friendships": {"a": str, "b": str},
    "orgs": {"name": str},
    "events": {"orgId": str, "title": str, "start": (int, float), "end": (int, float)},
    "messages": {"channel": str, "userId": str, "text": str},
    "flares": {"eventId": str, "roleId": str, "createdBy": str},
    "guestbook": {"eventId": str, "userId": str, "text": str},
}
DEFAULTS = {
    "users": {"email": "", "photo": "", "busy": [], "statusBusy": [], "calendar": None,
              "bridgeOptIn": {}, "presence": "offline", "away": "", "lastSeen": 0},
    "friendships": {},
    "orgs": {"emoji": "🌿", "inviteCode": "", "members": {},
             "bridge": {"type": "none", "botId": ""}, "handoff": None},
    "events": {"type": "Event", "location": "", "description": "", "status": "pending",
               "createdBy": "", "checkinCode": "", "attendance": [], "roles": []},
    "messages": {"source": "app", "payload": None},
    "flares": {"status": "open", "reason": "", "claimedBy": None, "resolvedAt": None},
    "guestbook": {},
}
NULLABLE_TYPES = {"calendar": dict, "handoff": dict, "payload": dict,
                  "claimedBy": str, "resolvedAt": (int, float)}
ORG_ROLES = {"President", "Vice President", "Treasurer", "Events Chair", "Secretary", "Member"}
METADATA = {"id", "createdAt", "updatedAt", "version"}


def number(value):
    try:
        return type(value) in (int, float) and isfinite(value)
    except OverflowError:
        return False


def validate(resource, body, *, existing=None):
    if not isinstance(body, dict):
        raise ValidationError("Body must be a JSON object.")
    defaults = deepcopy(DEFAULTS[resource])
    if resource in ("messages", "guestbook"):
        defaults["ts"] = time_ns() // 1_000_000
    allowed = set(SCHEMAS[resource]) | set(defaults)
    unknown = set(body) - allowed
    if unknown:
        raise ValidationError("Unknown or read-only fields: " + ", ".join(sorted(unknown)))
    previous = {k: v for k, v in (existing or {}).items() if k not in METADATA}
    record = {**defaults, **previous, **body}
    for key, kind in SCHEMAS[resource].items():
        value = record.get(key)
        if not isinstance(value, kind) or isinstance(value, bool):
            raise ValidationError(f"{key} is required and has an invalid type.")
        if isinstance(value, str):
            record[key] = value.strip()
            if not record[key]:
                raise ValidationError(f"{key} must not be blank.")
    for key, default in defaults.items():
        value = record[key]
        kind = NULLABLE_TYPES[key] if default is None else type(default)
        if default is None and value is None:
            continue
        if not isinstance(value, kind) or isinstance(value, bool):
            raise ValidationError(f"Invalid type for {key}.")
    for key, value in record.items():
        if isinstance(value, (int, float)) and not number(value):
            raise ValidationError(f"{key} must be a finite number.")
    if resource == "users":
        if record["presence"] not in {"online", "away", "offline"}:
            raise ValidationError("Invalid presence.")
        for key in ("busy", "statusBusy"):
            if any(not isinstance(b, list) or len(b) != 2 or
                   not all(number(t) for t in b) or b[0] >= b[1] for b in record[key]):
                raise ValidationError(f"{key} must contain [start, end] millisecond ranges.")
    if resource == "friendships" and record["a"] == record["b"]:
        raise ValidationError("A friendship needs two different users.")
    if resource == "orgs":
        for user_id, member in record["members"].items():
            if (not user_id or not isinstance(member, dict) or
                    not isinstance(member.get("role"), str) or member["role"] not in ORG_ROLES):
                raise ValidationError("Members must map user IDs to objects with a valid org role.")
    if resource == "events":
        if record["end"] <= record["start"]:
            raise ValidationError("end must be after start.")
        if record["status"] not in {"pending", "confirmed", "cancelled"}:
            raise ValidationError("Invalid event status.")
        if any(not isinstance(uid, str) or not uid for uid in record["attendance"]):
            raise ValidationError("attendance must contain user IDs.")
        ids = set()
        for role in record["roles"]:
            if not isinstance(role, dict) or not isinstance(role.get("id"), str) or not role["id"]:
                raise ValidationError("Each event role needs a string id.")
            if role["id"] in ids:
                raise ValidationError("Event role IDs must be unique.")
            ids.add(role["id"])
            if not isinstance(role.get("name"), str) or not role["name"].strip():
                raise ValidationError("Each event role needs a name.")
            if type(role.get("headcount")) is not int or role["headcount"] < 1:
                raise ValidationError("Role headcount must be a positive integer.")
            claims = role.get("claims", [])
            if (not isinstance(claims, list) or any(not isinstance(uid, str) for uid in claims)
                    or len(set(claims)) != len(claims) or len(claims) > role["headcount"]):
                raise ValidationError("Role claims must be distinct user IDs within headcount.")
    if resource == "flares" and record["status"] not in {"open", "claimed", "expired"}:
        raise ValidationError("Invalid flare status.")
    if resource == "messages":
        parts = record["channel"].split(":")
        if not ((len(parts) == 2 and parts[0] in {"org", "event"}) or
                (len(parts) == 3 and parts[0] == "dm")) or not all(parts):
            raise ValidationError("channel must be org:<id>, event:<id>, or dm:<id>:<id>.")
    return record
