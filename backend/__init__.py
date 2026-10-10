"""Run locally with: python -m flask --app backend run --port 5000."""

from pathlib import Path

from flask import Flask, jsonify, send_from_directory
from werkzeug.exceptions import HTTPException

from .api import api
from .models import ValidationError
from .repository import RESOURCES, InMemoryRepository, MissingRecord, Repository, VersionConflict


def create_app(config=None, *, repository: Repository | None = None):
    app = Flask(__name__, static_folder=None)
    app.config.from_mapping(MAX_CONTENT_LENGTH=1_000_000)
    if config:
        app.config.update(config)
    app.extensions["repository"] = repository if repository is not None else InMemoryRepository()
    app.register_blueprint(api)

    @app.get("/")
    def index():
        return send_from_directory(Path(app.root_path).parent, "index.html")

    @app.get("/<any(js,css,Assets):folder>/<path:filename>")
    def frontend_asset(folder, filename):
        return send_from_directory(Path(app.root_path).parent / folder, filename)

    @app.get("/api")
    def api_index():
        return jsonify(name="Meadow API", health="/api/health", api="/api",
                       resources=list(RESOURCES))

    @app.errorhandler(ValidationError)
    def invalid(error):
        return jsonify(error={"code": "validation_error", "message": str(error)}), 400

    @app.errorhandler(MissingRecord)
    def missing(error):
        return jsonify(error={"code": "not_found", "message": "Record not found."}), 404

    @app.errorhandler(VersionConflict)
    def conflict(error):
        return jsonify(error={"code": "version_conflict", "message": "Record changed. Read it again before updating."}), 409

    @app.errorhandler(HTTPException)
    def http_error(error):
        response = error.get_response()
        response.data = app.json.dumps({"error": {"code": error.name.lower().replace(" ", "_"), "message": error.description}})
        response.content_type = "application/json"
        return response

    return app
