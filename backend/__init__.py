"""Run locally with: python -m flask --app backend run --port 5000."""

from __future__ import annotations

from pathlib import Path
import os

from flask import Flask, jsonify, send_from_directory
from dotenv import load_dotenv
from werkzeug.exceptions import HTTPException

from .api import api
from .models import ValidationError
from .repository import RESOURCES, InMemoryRepository, MissingRecord, Repository, VersionConflict


def create_app(config=None, *, repository: Repository | None = None):
    load_dotenv(Path(__file__).resolve().parents[1] / ".env", override=False)
    app = Flask(__name__, static_folder=None)
    app.config.from_mapping(MAX_CONTENT_LENGTH=1_000_000,
                            STORAGE_BACKEND=os.getenv("STORAGE_BACKEND", "memory"),
                            DATABASE_URL=os.getenv("TIMESCALE_SERVICE_URL", ""))
    if config:
        app.config.update(config)
    # Unit tests remain isolated even if a developer has a real service in .env.
    if config and config.get("TESTING") and "STORAGE_BACKEND" not in config:
        app.config["STORAGE_BACKEND"] = "memory"
    if repository is None:
        backend = app.config["STORAGE_BACKEND"].strip().lower()
        if backend == "memory":
            repository = InMemoryRepository()
        elif backend == "tiger":
            if not app.config["DATABASE_URL"]:
                raise ValueError("Tiger storage requires TIMESCALE_SERVICE_URL in your local .env.")
            from .tiger_repository import TigerRepository
            repository = TigerRepository(app.config["DATABASE_URL"])
        else:
            raise ValueError("STORAGE_BACKEND must be memory or tiger.")
    app.extensions["repository"] = repository
    # Register /api/ai and /api/insights before the catch-all /api/<resource> routes.
    from .gemini import ai_api
    from .insights import insights_api
    from .tiger_cli import register_commands
    app.register_blueprint(ai_api)
    app.register_blueprint(insights_api)
    register_commands(app)
    app.register_blueprint(api)

    # Connection errors never echo a database URL or password into a response.
    from .tiger_repository import TigerUnavailable

    @app.errorhandler(TigerUnavailable)
    def tiger_unavailable(error):
        app.logger.warning("Tiger database request failed (%s)", error.detail or type(error).__name__)
        return jsonify(error={"code": "storage_unavailable", "message": str(error)}), 503

    try:
        import psycopg
    except ImportError:
        psycopg = None
    if psycopg is not None:
        @app.errorhandler(psycopg.Error)
        def database_error(error):
            app.logger.warning("Tiger database request failed (%s)", type(error).__name__)
            return jsonify(error={"code": "storage_unavailable", "message":
                "Tiger Data is unavailable or not initialized. Check .env and run flask --app app tiger-init."}), 503

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
