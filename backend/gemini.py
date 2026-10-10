"""Gemini client and Dewey's AI endpoints. Everything is optional: without
GEMINI_API_KEY the app falls back to the offline parser and keyword search."""

import json
import math
import os
from datetime import date
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from flask import Blueprint, jsonify, request

from .models import ValidationError

API = 'https://generativelanguage.googleapis.com/v1beta/models/'
CHAT_MODEL = 'gemini-2.5-flash'
EMBEDDING_MODEL = 'gemini-embedding-001'
EMBEDDING_DIMS = 768

ai_api = Blueprint('ai', __name__, url_prefix='/api/ai')


class GeminiUnavailable(Exception):
    pass


def enabled():
    return bool(os.getenv('GEMINI_API_KEY'))


def _call(model, method, body, timeout=20):
    key = os.getenv('GEMINI_API_KEY')
    if not key:
        raise GeminiUnavailable('GEMINI_API_KEY is not set.')
    req = Request(API + model + ':' + method, data=json.dumps(body).encode(),
                  headers={'Content-Type': 'application/json', 'x-goog-api-key': key})
    try:
        with urlopen(req, timeout=timeout) as response:
            return json.load(response)
    except HTTPError as error:
        raise GeminiUnavailable(f'Gemini returned HTTP {error.code}.') from None
    except (URLError, TimeoutError, ValueError):
        raise GeminiUnavailable('Gemini could not be reached.') from None


def generate(system, text, *, json_output=False):
    config = {'temperature': 0.2}
    if json_output:
        config['responseMimeType'] = 'application/json'
    data = _call(CHAT_MODEL, 'generateContent', {
        'systemInstruction': {'parts': [{'text': system}]},
        'contents': [{'role': 'user', 'parts': [{'text': text}]}],
        'generationConfig': config,
    })
    try:
        return ''.join(p.get('text', '') for p in data['candidates'][0]['content']['parts'])
    except (KeyError, IndexError, TypeError):
        raise GeminiUnavailable('Gemini returned no text.') from None


def embed(text, task='RETRIEVAL_DOCUMENT'):
    data = _call(EMBEDDING_MODEL, 'embedContent', {
        'content': {'parts': [{'text': text}]},
        'taskType': task,
        'outputDimensionality': EMBEDDING_DIMS,
    }, timeout=10)
    vector = (data.get('embedding') or {}).get('values')
    if not isinstance(vector, list) or not vector or any(type(v) not in (int, float) or not math.isfinite(v) for v in vector) or not any(vector):
        raise GeminiUnavailable('Gemini returned an invalid embedding.')
    return vector


def _text(field, limit):
    body = request.get_json(silent=True) or {}
    value = body.get(field)
    if not isinstance(value, str) or not value.strip():
        raise ValidationError(f'{field} is required.')
    return value.strip()[:limit]


@ai_api.get('/status')
def status():
    return jsonify(enabled=enabled(), model=CHAT_MODEL if enabled() else None)


@ai_api.post('/parse')
def parse():
    """Turn a natural-language scheduling request into constraint JSON."""
    text = _text('text', 2000)
    system = ('You convert scheduling requests into JSON. Today is ' + date.today().strftime('%A, %B %d, %Y') + '. '
              'Reply with ONLY a JSON object: {"mode":"officers"|"event","durationMin":number,'
              '"days":[0-6 (0=Sunday)],"hourStart":number,"hourEnd":number,'
              '"roles":[{"name":string,"headcount":number}],"title":string}. '
              'Use 24h decimal hours. Omit unknown fields.')
    try:
        return jsonify(result=json.loads(generate(system, text, json_output=True)))
    except (GeminiUnavailable, ValueError) as error:
        return jsonify(error={'code': 'ai_unavailable', 'message': str(error)}), 503


@ai_api.post('/polish')
def polish():
    """Rewrite assistant output (e.g. chat summaries) without adding facts."""
    text = _text('text', 8000)
    instruction = _text('instruction', 500)
    system = 'You are Dewey, a friendly assistant for a student org. ' + instruction + ' Keep it short.'
    try:
        return jsonify(text=generate(system, text).strip())
    except GeminiUnavailable as error:
        return jsonify(error={'code': 'ai_unavailable', 'message': str(error)}), 503
