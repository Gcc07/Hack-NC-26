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
CHAT_MODEL = 'gemini-flash-latest'
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


@ai_api.post('/chat')
def chat():
    """Short iMessage-style chat turn. Used by the meadow bridge when Gemini is configured."""
    text = _text('text', 4000)
    body = request.get_json(silent=True) or {}
    system = body.get('system')
    if not isinstance(system, str) or not system.strip():
        system = (
            'You are Dewey, Meadow\'s friendly iMessage assistant for student organizations. '
            'Keep replies to 1–3 short sentences. Do not claim you saved RSVPs or changed schedules '
            'unless the user completed a structured YES / can\'t make it / time / food reply.'
        )
    else:
        system = system.strip()[:8000]
    history = body.get('history') or []
    if not isinstance(history, list):
        raise ValidationError('history must be a list of {role, content} objects.')
    # Gemini generate() is single-turn; fold recent history into the user payload.
    lines = []
    for turn in history[-12:]:
        if not isinstance(turn, dict):
            continue
        role = turn.get('role')
        content = turn.get('content')
        if role in {'user', 'assistant'} and isinstance(content, str) and content.strip():
            lines.append(('Member' if role == 'user' else 'Dewey') + ': ' + content.strip()[:1000])
    lines.append('Member: ' + text)
    prompt = 'Conversation so far:\n' + '\n'.join(lines) + '\nDewey:'
    try:
        return jsonify(text=generate(system, prompt).strip(), model=CHAT_MODEL)
    except GeminiUnavailable as error:
        return jsonify(error={'code': 'ai_unavailable', 'message': str(error)}), 503


@ai_api.post('/sms-intent')
def sms_intent():
    """Map a messy SMS reply onto a structured bridge intent (JSON)."""
    text = _text('text', 2000)
    body = request.get_json(silent=True) or {}
    pending = body.get('pending') or []
    if not isinstance(pending, list):
        raise ValidationError('pending must be a list.')
    pending_desc = []
    for item in pending[:6]:
        if isinstance(item, dict) and isinstance(item.get('kind'), str):
            opts = item.get('options') if isinstance(item.get('options'), list) else []
            pending_desc.append({'kind': item['kind'], 'options': opts[:5]})
    system = (
        'You classify student-org iMessage replies. Reply with ONLY JSON: '
        '{"intent":"rsvp_accept"|"rsvp_decline"|"rsvp_late"|"pick_time"|"food_answer"|"clarify"|"chat",'
        '"choice":string|null,"minutes":number|null,"food":string|null,"clarify":string|null,'
        '"confidence":number}. '
        'Rules: rsvp_late if they are coming but delayed; pick_time only when choosing among options; '
        'food_answer when answering food feedback; clarify when ambiguous (set clarify to a short question); '
        'chat for general conversation. confidence is 0-1. Never invent a save.'
    )
    user = json.dumps({'text': text, 'pending': pending_desc}, ensure_ascii=True)
    try:
        result = json.loads(generate(system, user, json_output=True))
        if not isinstance(result, dict):
            raise ValueError('not an object')
        return jsonify(result=result, model=CHAT_MODEL)
    except (GeminiUnavailable, ValueError) as error:
        return jsonify(error={'code': 'ai_unavailable', 'message': str(error)}), 503


@ai_api.post('/sms-copy')
def sms_copy():
    """Write short, flashy iMessage copy for reminders / polls / surveys."""
    body = request.get_json(silent=True) or {}
    kind = body.get('kind')
    if kind not in {'reminder', 'meeting_time', 'food_feedback', 'availability'}:
        raise ValidationError('kind must be reminder, meeting_time, food_feedback, or availability.')
    title = body.get('title') if isinstance(body.get('title'), str) else 'our event'
    org = body.get('org') if isinstance(body.get('org'), str) else 'your org'
    when = body.get('when') if isinstance(body.get('when'), str) else ''
    options = body.get('options') if isinstance(body.get('options'), list) else []
    options = [str(o)[:40] for o in options if isinstance(o, (str, int, float))][:5]
    system = (
        'You write punchy iMessage copy for a student-org assistant named Dewey. '
        'Return ONLY JSON: {"text": string}. Max 2 short sentences + a clear reply instruction. '
        'No markdown. Friendly, specific, not corporate.'
    )
    user = json.dumps({
        'kind': kind, 'org': org[:80], 'title': title[:80], 'when': when[:80], 'options': options,
    }, ensure_ascii=True)
    try:
        result = json.loads(generate(system, user, json_output=True))
        text = result.get('text') if isinstance(result, dict) else None
        if not isinstance(text, str) or not text.strip():
            raise ValueError('missing text')
        return jsonify(text=text.strip()[:500], model=CHAT_MODEL)
    except (GeminiUnavailable, ValueError) as error:
        return jsonify(error={'code': 'ai_unavailable', 'message': str(error)}), 503
