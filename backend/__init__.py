"""Run locally with: python -m flask --app backend run --port 5000."""

from __future__ import annotations

from pathlib import Path
import os
import secrets

from flask import Flask, jsonify, send_from_directory
from dotenv import load_dotenv
from werkzeug.exceptions import HTTPException

from .api import api
from .auth import Throttle, auth_api, guard_api
from .auth_store import InMemoryAuthStore
from .models import ValidationError
from .repository import RESOURCES, InMemoryRepository, MissingRecord, Repository, VersionConflict


def create_app(config=None, *, repository: Repository | None = None):
    load_dotenv(Path(__file__).resolve().parents[1] / ".env", override=False)
    app = Flask(__name__, static_folder=None)
    app.config.from_mapping(MAX_CONTENT_LENGTH=1_000_000,
                            STORAGE_BACKEND=os.getenv("STORAGE_BACKEND", "memory"),
                            DATABASE_URL=os.getenv("TIMESCALE_SERVICE_URL", ""),
                            SECRET_KEY=os.getenv("MEADOW_SECRET_KEY", ""),
                            AUTH_COOKIE_SECURE=os.getenv("MEADOW_SECURE_COOKIES", "").lower() in ("1", "true", "yes"),
                            BEHIND_PROXY=os.getenv("MEADOW_BEHIND_PROXY", "").lower() in ("1", "true", "yes"),
                            GOOGLE_CLIENT_ID=os.getenv("GOOGLE_CLIENT_ID", "").strip(),
                            GOOGLE_CLIENT_SECRET=os.getenv("GOOGLE_CLIENT_SECRET", "").strip(),
                            GOOGLE_REDIRECT_URI=os.getenv("GOOGLE_REDIRECT_URI", "").strip())
    if config:
        app.config.update(config)
    if not app.config["SECRET_KEY"]:
        # Works for one process, but Google sign-ins in progress and stored calendar
        # access are lost on restart. Set MEADOW_SECRET_KEY in .env for real use.
        if not app.config.get("TESTING") and app.config["STORAGE_BACKEND"].strip().lower() == "tiger":
            # Refresh tokens persist in Tiger, so a temporary key would strand them on restart.
            raise ValueError("Tiger storage requires MEADOW_SECRET_KEY in your .env (see .env.example).")
        if not app.config.get("TESTING"):
            app.logger.warning("MEADOW_SECRET_KEY is not set; using a temporary key.")
        app.config["SECRET_KEY"] = secrets.token_urlsafe(32)
    if app.config["BEHIND_PROXY"]:
        # nginx sets X-Forwarded-*; trust exactly one proxy hop for client IP, scheme and host.
        from werkzeug.middleware.proxy_fix import ProxyFix
        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)
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
    if hasattr(repository, "connection"):
        from .auth_store import TigerAuthStore
        app.extensions["auth_store"] = TigerAuthStore(repository)
    else:
        app.extensions["auth_store"] = InMemoryAuthStore()
    app.extensions["auth_throttle"] = Throttle()
    app.before_request(guard_api)
    app.register_blueprint(auth_api)
    app.register_blueprint(api)
    from .gemini import ai_api
    from .insights import insights_api
    from .tiger_cli import register_commands
    app.register_blueprint(ai_api)
    app.register_blueprint(insights_api)
    register_commands(app)

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
