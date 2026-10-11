"""HTTP transport for the initial, unauthenticated development API."""

from flask import Blueprint, current_app, jsonify, request, url_for
from werkzeug.exceptions import BadRequest, NotFound

from .models import SCHEMAS, DEFAULTS, ValidationError, validate
from .repository import RESOURCES, MissingRecord, VersionConflict

api = Blueprint("api", __name__, url_prefix="/api")


@api.route("/state", methods=["GET", "PUT"])
def state():
    """Development bridge for the existing browser action model."""
    repo = current_app.extensions["repository"]
    if request.method == "GET":
        response = jsonify(repo.snapshot())
        response.headers["Cache-Control"] = "no-store"
        return response
    body = request.get_json()
    if (not isinstance(body, dict) or type(body.get("revision")) is not int
            or not isinstance(body.get("instance"), str)):
        raise ValidationError("A state, revision and instance are required.")
    data = body.get("state")
    if not isinstance(data, dict) or set(data) != set(RESOURCES):
        raise ValidationError("State must contain every Meadow collection.")
    for name, values in data.items():
        array = name in ("friendships", "messages", "guestbook")
        if not isinstance(values, list if array else dict):
            raise ValidationError(f"Invalid {name} collection.")
        entries = enumerate(values) if array else values.items()
        ids = set()
        for key, record in entries:
            if not isinstance(record, dict):
                raise ValidationError("Records must be objects.")
            record_id = record.get("id")
            if name == "friendships" and record_id is None:
                if not all(isinstance(record.get(k), str) and record[k] for k in ("a", "b")):
                    raise ValidationError("Friendships need two user IDs.")
                continue
            if (not isinstance(record_id, str) or not record_id or record_id in ids
                    or (not array and key != record_id)):
                raise ValidationError("Records need unique IDs matching their keys.")
            ids.add(record_id)
    return jsonify(repo.save_snapshot(data, body["revision"], body["instance"]))


def repository(resource):
    if resource not in RESOURCES:
        raise NotFound("Unknown resource.")
    return current_app.extensions["repository"]


@api.get("/health")
def health():
    return jsonify(status="ok")


@api.route("/<resource>", methods=["GET", "POST"])
def collection(resource):
    repo = repository(resource)
    if request.method == "POST":
        record = repo.create(resource, validate(resource, request.get_json()))
        response = jsonify(data=record)
        response.status_code = 201
        response.headers["Location"] = url_for("api.item", resource=resource, record_id=record["id"])
        return response

    # Exact matches on scalar fields, with bounded response size.
    filters = {key: value for key, value in request.args.items() if key not in {"limit", "offset"}}
    allowed = set(SCHEMAS[resource]) | set(DEFAULTS[resource]) | {"id", "createdAt", "updatedAt", "version", "ts"}
    if set(filters) - allowed:
        raise BadRequest("Unknown filter field.")
    try:
        limit, offset = int(request.args.get("limit", 100)), int(request.args.get("offset", 0))
    except ValueError:
        raise BadRequest("limit and offset must be integers.") from None
    if not 1 <= limit <= 500 or offset < 0:
        raise BadRequest("limit must be 1–500 and offset must be nonnegative.")
    records = [record for record in repo.list(resource)
               if all(not isinstance(record.get(k), (dict, list)) and str(record.get(k)) == v
                      for k, v in filters.items())]
    return jsonify(data=records[offset:offset + limit], total=len(records), limit=limit, offset=offset)


@api.route("/<resource>/<record_id>", methods=["GET", "PUT", "PATCH", "DELETE"])
def item(resource, record_id):
    repo = repository(resource)
    if request.method == "DELETE":
        repo.delete(resource, record_id)
        return "", 204
    if request.method == "PUT":
        # Bridge bootstrap: create with a fixed id if missing; leave existing rows alone.
        body = request.get_json()
        if not isinstance(body, dict):
            raise ValidationError("Body must be a JSON object.")
        try:
            return jsonify(data=repo.get(resource, record_id), created=False)
        except MissingRecord:
            record = repo.ensure(resource, record_id, validate(resource, body))
            response = jsonify(data=record, created=True)
            response.status_code = 201
            return response
    record = repo.get(resource, record_id)
    if request.method == "PATCH":
        body = request.get_json()
        if not isinstance(body, dict):
            raise ValidationError("Body must be a JSON object.")
        version = body.pop("version", None)
        if type(version) is not int:
            raise ValidationError("PATCH requires the integer version from your last read.")
        if version != record["version"]:
            raise VersionConflict
        record = repo.replace(resource, record_id, validate(resource, body, existing=record), version)
    return jsonify(data=record)
