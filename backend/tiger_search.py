"""Org-scoped, cited memory retrieval; embedding work is explicitly opt-in."""
import json
import math
import os
import re
from urllib.parse import quote
from urllib.request import Request, urlopen


def _values(value):
    return list(value.values()) if isinstance(value, dict) else value


def memory_documents(state):
    org_rows = [org for org in _values(state.get('orgs', {})) if isinstance(org, dict) and org.get('id')]
    orgs = {org['id']: org for org in org_rows}
    events = {event['id']: event for event in _values(state.get('events', {}))
              if isinstance(event, dict) and event.get('id') and event.get('orgId') in orgs}
    docs = []
    def add(key, org, event, source, title, text, page=None):
        if org not in orgs or not isinstance(text, str) or not text.strip():
            return
        if event:
            suffix = '/events/' + quote(event, safe='')
        elif page:
            suffix = '/' + page
        else:
            suffix = '/chat'
        docs.append(dict(id=key, org_id=org, event_id=event, source=source,
                         title=title, body=text.strip(),
                         url='#/o/' + quote(org, safe='') + suffix))
    for event in events.values():
        add('event:' + event['id'], event['orgId'], event['id'], 'event', event.get('title') or 'Event',
            event.get('description', ''))
    for org in orgs.values():
        handoff = org.get('handoff') if isinstance(org.get('handoff'), dict) else {}
        add('handoff:' + org['id'], org['id'], None, 'handoff',
            (org.get('name') or 'Organization') + ' — officer handoff', handoff.get('text', ''), 'board')
    for note in _values(state.get('guestbook', [])):
        if not isinstance(note, dict) or not note.get('id'):
            continue
        event = events.get(note.get('eventId'))
        if event:
            add('guestbook:' + note['id'], event['orgId'], event['id'], 'guestbook',
                (event.get('title') or 'Event') + ' — guestbook', note.get('text', ''))
    for message in _values(state.get('messages', [])):
        if not isinstance(message, dict) or not message.get('id'):
            continue
        text = message.get('text', '')
        payload = message.get('payload') or {}
        if message.get('source') != 'assistant' or not (payload.get('type') == 'summary' or (isinstance(text, str) and text.startswith('**Summary**'))):
            continue
        kind, _, target = message.get('channel', '').partition(':')
        event = events.get(target) if kind == 'event' else None
        org = event['orgId'] if event else target if kind == 'org' else None
        if kind == 'event' and not event:
            continue
        add('summary:' + message['id'], org, event['id'] if event else None,
            'summary', ((event.get('title') if event else None) or 'Organization chat') + ' — summary', text)
    return docs


def _optional(conn, sql):
    """Unsupported optional extensions must not abort the surrounding transaction."""
    try:
        with conn.transaction():
            conn.execute(sql)
        return True
    except Exception:
        return False


def init_search_schema(conn):
    conn.execute('''CREATE TABLE IF NOT EXISTS meadow_memory (
        id text PRIMARY KEY, org_id text NOT NULL, event_id text, source text NOT NULL,
        title text NOT NULL, body text NOT NULL, url text NOT NULL,
        search_text text GENERATED ALWAYS AS (title || ' ' || body) STORED,
        embedding_model text)''')
    conn.execute('CREATE INDEX IF NOT EXISTS meadow_memory_org ON meadow_memory(org_id)')
    conn.execute("CREATE INDEX IF NOT EXISTS meadow_memory_fts ON meadow_memory USING gin(to_tsvector('english', search_text))")
    if os.getenv('TIGER_SEARCH_BM25', 'auto') != 'off':
        if _optional(conn, 'CREATE EXTENSION IF NOT EXISTS pg_textsearch'):
            _optional(conn, "CREATE INDEX IF NOT EXISTS meadow_memory_bm25 ON meadow_memory USING bm25(search_text) WITH (text_config='english')")
    if _optional(conn, 'CREATE EXTENSION IF NOT EXISTS vector'):
        conn.execute('ALTER TABLE meadow_memory ADD COLUMN IF NOT EXISTS embedding vector')


def sync_memory_documents(conn, state):
    archived = conn.execute("SELECT id,channel,body,source,payload FROM meadow_messages WHERE source='assistant'").fetchall()
    messages = {m['id']: dict(m, text=m['body']) for m in archived}
    messages.update({m['id']: m for m in _values(state.get('messages', []))})
    docs = memory_documents({**state, 'messages': list(messages.values())})
    conn.execute('DELETE FROM meadow_memory WHERE NOT (id = ANY(%s::text[]))', ([d['id'] for d in docs],))
    for d in docs:
        conn.execute('''INSERT INTO meadow_memory(id,org_id,event_id,source,title,body,url)
            VALUES (%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (id) DO UPDATE SET
            org_id=excluded.org_id,event_id=excluded.event_id,source=excluded.source,
            title=excluded.title,body=excluded.body,url=excluded.url,
            embedding_model=CASE WHEN meadow_memory.body=excluded.body AND meadow_memory.title=excluded.title
                AND meadow_memory.org_id=excluded.org_id THEN meadow_memory.embedding_model ELSE NULL END''',
            tuple(d[k] for k in ('id','org_id','event_id','source','title','body','url')))


def _embedding_config():
    url, model = os.getenv('MEADOW_EMBEDDING_URL', ''), os.getenv('MEADOW_EMBEDDING_MODEL', '')
    return (url, model) if url and model else None


def _embed(text, config):
    url, model = config
    headers = {'Content-Type': 'application/json'}
    key = os.getenv('MEADOW_EMBEDDING_API_KEY')
    if key:
        headers['Authorization'] = 'Bearer ' + key
    request = Request(url, data=json.dumps({'model': model, 'input': text}).encode(), headers=headers)
    with urlopen(request, timeout=10) as response:
        vector = json.load(response)['data'][0]['embedding']
    if not isinstance(vector, list) or not vector or any(type(v) not in (int, float) or not math.isfinite(v) for v in vector) or not any(vector):
        raise ValueError('Embedding provider returned an invalid vector.')
    return json.dumps(vector)


def reindex_embeddings(repo, limit=100):
    config = _embedding_config()
    if not config or not hasattr(repo, 'connection'):
        raise ValueError('Configure Tiger storage, MEADOW_EMBEDDING_URL and MEADOW_EMBEDDING_MODEL first.')
    with repo.connection() as conn:
        if not _has_vector(conn):
            raise ValueError('Enable the PostgreSQL vector extension and restart the app first.')
        docs = conn.execute('SELECT id,title,body,org_id FROM meadow_memory WHERE embedding_model IS DISTINCT FROM %s ORDER BY id LIMIT %s', (config[1], max(1, min(int(limit), 1000)))).fetchall()
    count = 0
    for doc in docs:
        vector = _embed(doc['title'] + ' ' + doc['body'], config)
        with repo.connection() as conn:
            # Another writer may edit or delete the document during the API request.
            result = conn.execute('''UPDATE meadow_memory SET embedding=%s::vector,embedding_model=%s
                WHERE id=%s AND title=%s AND body=%s AND org_id=%s''',
                (vector, config[1], doc['id'], doc['title'], doc['body'], doc['org_id']))
            count += result.rowcount
    return {'indexed': count, 'model': config[1]}


def _has_vector(conn):
    return bool(conn.execute("SELECT 1 FROM information_schema.columns WHERE table_name='meadow_memory' AND column_name='embedding'").fetchone())


def _result(d, score):
    return dict(id=d['id'], source=d['source'], title=d['title'], snippet=d['body'][:600],
                eventId=d.get('event_id'), url=d['url'], score=float(score))


def search_memory(repo, org_id, query, limit=8):
    query = query.strip()[:500]
    limit = max(1, min(int(limit), 30))
    if not query:
        return {'mode': 'empty', 'results': []}
    if not hasattr(repo, 'connection'):
        tokens = set(re.findall(r'\w+', query.lower()))
        found = []
        for d in memory_documents(repo.snapshot()['state']):
            if d['org_id'] == org_id:
                words = re.findall(r'\w+', (d['title'] + ' ' + d['body']).lower())
                score = sum(words.count(t) for t in tokens)
                if score:
                    found.append(_result(d, score))
        return {'mode': 'memory-keyword', 'results': sorted(found, key=lambda d: (-d['score'], d['id']))[:limit]}
    with repo.connection() as conn:
        mode = 'postgres-full-text'
        rows = None
        if os.getenv('TIGER_SEARCH_BM25', 'auto') != 'off' and conn.execute("SELECT 1 FROM pg_indexes WHERE indexname='meadow_memory_bm25'").fetchone():
            try:
                with conn.transaction():
                    rows = conn.execute('''SELECT *, search_text <@> to_bm25query(%s, 'meadow_memory_bm25') AS score
                        FROM meadow_memory WHERE org_id=%s
                        ORDER BY search_text <@> to_bm25query(%s, 'meadow_memory_bm25') LIMIT %s''',
                        (query, org_id, query, limit * 4)).fetchall()
                    rows = [r for r in rows if r['score'] < 0]
                    mode = 'bm25'
            except Exception:
                rows = None
        if rows is None:
            rows = conn.execute('''SELECT *,ts_rank_cd(to_tsvector('english',search_text),websearch_to_tsquery('english',%s)) AS score
                FROM meadow_memory WHERE org_id=%s AND to_tsvector('english',search_text) @@ websearch_to_tsquery('english',%s)
                ORDER BY score DESC,id LIMIT %s''', (query,org_id,query,limit * 4)).fetchall()
        config = _embedding_config()
        vector_ready = config and _has_vector(conn) and conn.execute('SELECT 1 FROM meadow_memory WHERE org_id=%s AND embedding_model=%s LIMIT 1', (org_id,config[1])).fetchone()
    # Network call happens outside the SQL transaction.
    warning = None
    if vector_ready:
        try:
            vector = _embed(query, config)
            with repo.connection() as conn:
                semantic = conn.execute('''SELECT * FROM meadow_memory WHERE org_id=%s AND embedding_model=%s
                    AND embedding IS NOT NULL AND vector_dims(embedding)=vector_dims(%s::vector)
                    ORDER BY embedding <=> %s::vector LIMIT %s''', (org_id,config[1],vector,vector,limit * 4)).fetchall()
            merged = {}
            for ranking in (rows, semantic):
                for rank, row in enumerate(ranking, 1):
                    item = merged.setdefault(row['id'], _result(row, 0))
                    item['score'] += 1 / (60 + rank)
            return {'mode': 'hybrid-' + mode + '-vector', 'results': sorted(merged.values(), key=lambda d: (-d['score'],d['id']))[:limit]}
        except Exception:
            warning = 'Semantic search unavailable; showing keyword matches.'
    return {'mode': mode, 'results': [_result(d, -d['score'] if mode == 'bm25' else d['score']) for d in rows[:limit]], **({'warning': warning} if warning else {})}
