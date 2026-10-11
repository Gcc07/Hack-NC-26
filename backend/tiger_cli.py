"""One-time Tiger Cloud setup. Ordinary app startup never creates schema."""

import click

from .gemini import GeminiUnavailable
from .tiger_repository import TigerUnavailable
from .tiger_search import reindex_embeddings


def register_commands(app):
    @app.cli.command("tiger-init")
    def tiger_init():
        """Create Meadow tables, hypertables, aggregates, and search schema."""
        _run(lambda: _repository().initialize())
        click.echo("Tiger Data schema is ready.")

    @app.cli.command("tiger-index-memory")
    @click.option("--limit", default=100, show_default=True, type=click.IntRange(1, 1000))
    def tiger_index_memory(limit):
        """Embed org memory with Gemini. Requires GEMINI_API_KEY."""
        result = _run(lambda: reindex_embeddings(_repository(), limit))
        click.echo(f"Indexed {result['indexed']} documents with {result['model']}.")


def _repository():
    from flask import current_app
    repo = current_app.extensions["repository"]
    if not hasattr(repo, "initialize"):
        raise click.ClickException("Set STORAGE_BACKEND=tiger and TIMESCALE_SERVICE_URL in .env, then run this again.")
    return repo


def _run(action):
    try:
        return action()
    except (TigerUnavailable, GeminiUnavailable, ValueError) as error:
        detail = getattr(error, "detail", "")
        message = f"{error} ({detail})" if detail else str(error)
        raise click.ClickException(message) from None
