"""Org activity and searchable memory for the in-memory and Tiger adapters."""

from datetime import datetime, timedelta, timezone

from flask import Blueprint, current_app, jsonify, request
from werkzeug.exceptions import BadRequest

from .repository import MissingRecord
from .tiger_repository import timestamp
from .tiger_search import search_memory

insights_api = Blueprint("insights", __name__, url_prefix="/api")


def _records(state, name):
    values = state.get(name, [])
    if isinstance(values, dict):
        return list(values.values())
    return list(values) if isinstance(values, list) else []


def _record_map(state, name):
    values = state.get(name, {})
    if isinstance(values, dict):
        return {key: value for key, value in values.items() if isinstance(value, dict)}
    return {item["id"]: item for item in values if isinstance(item, dict) and item.get("id")}


def _window(days):
    now = datetime.now(timezone.utc)
    return now - timedelta(days=days), now


def _buckets(message_counts, presence_counts):
    return [{"hour": hour,
             "messages": int(message_counts.get(hour, 0)),
             "presence": int(presence_counts.get(hour, 0))} for hour in range(24)]


def _preferred_hours(activity, limit=3):
    ranked = sorted(activity, key=lambda item: (-(item["messages"] + item["presence"]), item["hour"]))
    return [item["hour"] for item in ranked if item["messages"] or item["presence"]][:limit]


def _participation(counts, users):
    return [{"userId": uid,
             "name": (users.get(uid) or {}).get("name") or "Member",
             "checkins": count}
            for uid, count in sorted(counts.items(), key=lambda item: (-item[1], item[0]))]


def insights_from_state(state, org_id, days, backend):
    """Hour-of-day activity from the app snapshot. Presence history lives only in Tiger."""
    if org_id not in _record_map(state, "orgs"):
        raise MissingRecord
    start, now = _window(days)
    events = [event for event in _records(state, "events")
              if isinstance(event, dict) and event.get("orgId") == org_id]
    event_ids = {event.get("id") for event in events}
    users = _record_map(state, "users")
    message_counts = {}
    for message in _records(state, "messages"):
        if not isinstance(message, dict):
            continue
        kind, _, target = (message.get("channel") or "").partition(":")
        if not ((kind == "org" and target == org_id) or (kind == "event" and target in event_ids)):
            continue
        when = timestamp(message.get("ts"), timestamp(message.get("createdAt")))
        if when is None or when < start or when >= now:
            continue
        message_counts[when.hour] = message_counts.get(when.hour, 0) + 1
    checkins = {}
    for event in events:
        when = timestamp(event.get("start"))
        if when is None or when < start or when >= now:
            continue
        for uid in event.get("attendance") or []:
            if isinstance(uid, str) and uid:
                checkins[uid] = checkins.get(uid, 0) + 1
    activity = _buckets(message_counts, {})
    return {"backend": backend, "orgId": org_id, "days": days, "activity": activity,
            "totals": {"messages": sum(message_counts.values()), "checkins": sum(checkins.values())},
            "preferredHours": _preferred_hours(activity),
            "participation": _participation(checkins, users)}


def _hour_counts(rows):
    counts = {}
    for row in rows:
        if row["hour"] is None:
            continue
        counts[int(row["hour"])] = int(row["n"])
    return counts


def insights_from_tiger(repo, org_id, days):
    """Read the message, presence, and check-in hypertables for one org."""
    start, now = _window(days)
    with repo.connection() as conn:
        row = conn.execute("SELECT document FROM meadow_state WHERE singleton").fetchone()
        if row is None:
            from .tiger_repository import TigerUnavailable
            raise TigerUnavailable("Tiger schema is not initialized. Run flask --app app tiger-init.")
        state = row["document"] if isinstance(row["document"], dict) else {}
        if org_id not in _record_map(state, "orgs"):
            raise MissingRecord
        users = _record_map(state, "users")
        messages = _hour_counts(conn.execute(
            """SELECT EXTRACT(HOUR FROM created_at AT TIME ZONE 'UTC')::int AS hour, COUNT(*)::int AS n
               FROM meadow_messages
               WHERE org_id = %s AND created_at >= %s AND created_at < %s
               GROUP BY 1""", (org_id, start, now)).fetchall())
        presence = _hour_counts(conn.execute(
            """SELECT EXTRACT(HOUR FROM observed_at AT TIME ZONE 'UTC')::int AS hour, COUNT(*)::int AS n
               FROM meadow_presence_events
               WHERE org_id = %s AND observed_at >= %s AND observed_at < %s
               GROUP BY 1""", (org_id, start, now)).fetchall())
        checkin_rows = conn.execute(
            """SELECT user_id, COUNT(*)::int AS n FROM meadow_checkins
               WHERE org_id = %s AND checked_at >= %s AND checked_at < %s
               GROUP BY user_id""", (org_id, start, now)).fetchall()
    activity = _buckets(messages, presence)
    checkins = {item["user_id"]: int(item["n"]) for item in checkin_rows if item["user_id"]}
    return {"backend": "tiger", "orgId": org_id, "days": days, "activity": activity,
            "totals": {"messages": sum(messages.values()), "checkins": sum(checkins.values())},
            "preferredHours": _preferred_hours(activity),
            "participation": _participation(checkins, users)}


def _days():
    try:
        days = int(request.args.get("days", 14))
    except (TypeError, ValueError):
        raise BadRequest("days must be an integer.") from None
    if not 1 <= days <= 90:
        raise BadRequest("days must be from 1 to 90.")
    return days


def _require_org(repo, org_id):
    if org_id not in _record_map(repo.snapshot()["state"], "orgs"):
        raise MissingRecord


@insights_api.get("/orgs/<org_id>/insights")
def org_insights(org_id):
    days = _days()
    repo = current_app.extensions["repository"]
    if hasattr(repo, "connection"):
        payload = insights_from_tiger(repo, org_id, days)
    else:
        payload = insights_from_state(repo.snapshot()["state"], org_id, days, "memory")
    return jsonify(payload)


@insights_api.get("/orgs/<org_id>/memory")
def org_memory(org_id):
    query = request.args.get("q", "")
    if not isinstance(query, str) or not query.strip():
        raise BadRequest("Enter a search phrase.")
    try:
        limit = int(request.args.get("limit", 8))
    except (TypeError, ValueError):
        raise BadRequest("limit must be an integer.") from None
    if not 1 <= limit <= 30:
        raise BadRequest("limit must be 1–30.")
    repo = current_app.extensions["repository"]
    _require_org(repo, org_id)
    return jsonify(search_memory(repo, org_id, query, limit))
