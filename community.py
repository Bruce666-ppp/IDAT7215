"""Shared community posts, comments and likes on the existing SQLite database."""
from contextlib import closing
from datetime import datetime, timedelta, timezone
from io import BytesIO
import sqlite3
from urllib.parse import urlsplit
from uuid import uuid4

from flask import Blueprint, jsonify, request, send_file, session

PDF_LIMIT = 8 * 1024 * 1024
POSTS_PER_PAGE = 15
COMMENTS_PER_PAGE = 30
LIKES = '(SELECT COUNT(*) FROM community_likes WHERE post_id=p.id)'
COMMENTS = '(SELECT COUNT(*) FROM community_comments WHERE post_id=p.id)'
POPULARITY = f'({LIKES} + 2 * {COMMENTS})'

DEMO_POSTS = (
    ('daily', 'Daily Life Demo', 'post', 'life', 'Pet Life', '',
     'I tracked pet care separately over the weekend and realised how different my weekday and weekend routines are. How do you make time for care on busy days?'),
    ('desk-pet', 'Desktop Pet Demo', 'post', 'life', 'Desktop Pets', '',
     'I dragged the 3D rabbit to the corner of my desk today. When I lowered its energy, it stopped to sleep, and the decision monitor showed which rule triggered.'),
    ('knowledge', 'Care Tips Demo', 'post', 'knowledge', 'Preparing for a Pet', '',
     'Before choosing a pet, list three things: the time you can set aside each day, the space you have and your regular costs. Think about who can provide care while you travel.'),
    ('paper', 'Reading Demo', 'paper', 'research', 'Reading Notes', 'Reading Card Demo: Start with the data and evaluation',
     'When sharing a paper, you can note where the data came from, how the training and test sets were split and where the results apply. This post demonstrates the research card.'),
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS community_posts (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, author TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('post', 'paper')), title TEXT NOT NULL,
    body TEXT NOT NULL, paper_url TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS community_post_order ON community_posts(created_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS community_papers (
    post_id TEXT PRIMARY KEY REFERENCES community_posts(id) ON DELETE CASCADE,
    filename TEXT NOT NULL, contents BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS community_likes (
    post_id TEXT NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
    owner TEXT NOT NULL, PRIMARY KEY (post_id, owner)
);
CREATE TABLE IF NOT EXISTS community_saves (
    post_id TEXT NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
    owner TEXT NOT NULL, PRIMARY KEY (post_id, owner)
);
CREATE TABLE IF NOT EXISTS community_comments (
    id TEXT PRIMARY KEY, post_id TEXT NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
    owner TEXT NOT NULL, author TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS community_comment_order
    ON community_comments(post_id, created_at DESC, id DESC);
"""


def init_community(con):
    con.executescript(SCHEMA)
    con.execute('BEGIN IMMEDIATE')
    columns = {column['name'] for column in con.execute('PRAGMA table_info(community_posts)')}
    if 'category' not in columns:
        con.execute("ALTER TABLE community_posts ADD COLUMN category TEXT NOT NULL DEFAULT 'life'")
        con.execute("UPDATE community_posts SET category='research' WHERE kind='paper'")
    if 'topic' not in columns:
        con.execute("ALTER TABLE community_posts ADD COLUMN topic TEXT NOT NULL DEFAULT ''")
    if con.execute('SELECT 1 FROM community_posts LIMIT 1').fetchone():
        con.executemany("""
            UPDATE community_posts SET author=?, topic=?, title=?, body=?
            WHERE id=? AND owner='community-demo'
        """, [(name, topic, title, body, f'demo-{key}')
              for key, name, _, _, topic, title, body in DEMO_POSTS])
        return
    now = datetime.now(timezone.utc)
    con.executemany("""
        INSERT INTO community_posts
        (id, owner, author, kind, category, topic, title, body, paper_url, created_at)
        VALUES (?, 'community-demo', ?, ?, ?, ?, ?, ?, '', ?)
    """, [(f'demo-{key}', name, kind, category, topic, title, body,
           (now-timedelta(hours=1+index*2)).isoformat())
          for index, (key, name, kind, category, topic, title, body) in enumerate(DEMO_POSTS)])


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def field(values, key, limit, label, required=False):
    value = values.get(key, '')
    if not isinstance(value, str):
        raise ValueError(f'{label} must be text.')
    value = value.strip()
    if required and not value:
        raise ValueError(f'Enter a value for {label}.')
    if len(value) > limit:
        raise ValueError(f'{label} can contain up to {limit} characters.')
    return value


def paper_link(url):
    if url:
        parsed = urlsplit(url)
        if (any(character.isspace() or ord(character) < 32 for character in url)
                or '\\' in url or parsed.scheme not in ('http', 'https')
                or not parsed.hostname or parsed.username is not None):
            raise ValueError('Enter a valid HTTP or HTTPS paper link.')
    return url


def pdf_attachment(upload):
    if upload is None or not upload.filename:
        return None
    name = upload.filename.replace('\\', '/').rsplit('/', 1)[-1]
    name = ''.join(character for character in name if character.isprintable()).strip()
    data = upload.stream.read(PDF_LIMIT + 1)
    if len(data) > PDF_LIMIT:
        raise ValueError('The maximum PDF size is 8 MB.')
    if not name.lower().endswith('.pdf') or not data.startswith(b'%PDF-') or b'%%EOF' not in data[-1024:]:
        raise ValueError('Choose a valid PDF file.')
    return name[:-4][:140] + '.pdf', data


def register_community(app, connect, owner):
    community = Blueprint('community', __name__, url_prefix='/api/community')

    def connection():
        con = connect()
        con.row_factory = sqlite3.Row
        return con

    with closing(connection()) as con, con:
        init_community(con)

    def author(values=None):
        default = session.get('community_author') or 'Guest · ' + owner()[:5].upper()
        return (field(values, 'author', 24, 'Display name') or default) if values is not None else default

    @community.get('/posts')
    def posts():
        viewer = owner()
        view = request.args.get('view', 'all')
        if view not in ('all', 'popular', 'life', 'knowledge', 'paper', 'saved', 'mine'):
            return jsonify(error='The selected filter is invalid.'), 400
        conditions = []
        args = [viewer, viewer]
        if view == 'paper':
            conditions.append("p.kind = 'paper'")
        elif view in ('life', 'knowledge'):
            conditions.append("p.kind='post' AND p.category = ?")
            args.append(view)
        elif view == 'saved':
            conditions.append('EXISTS(SELECT 1 FROM community_saves WHERE post_id=p.id AND owner=?)')
            args.append(viewer)
        elif view == 'mine':
            conditions.append('p.owner = ?')
            args.append(viewer)
        query = request.args.get('q', '').strip().strip('#＃').strip()
        if len(query) > 100:
            return jsonify(error='Search terms can contain up to 100 characters.'), 400
        if query:
            conditions.append("instr(lower(p.title || char(10) || p.body || char(10) || p.topic),lower(?)) > 0")
            args.append(query)
        ranking = view == 'popular'
        with closing(connection()) as con:
            if before := request.args.get('before'):
                cursor_columns = f'{POPULARITY}, p.created_at, p.id' if ranking else 'p.created_at, p.id'
                cursor = con.execute(f'SELECT {cursor_columns} FROM community_posts p WHERE id = ?', (before,)).fetchone()
                if cursor is None:
                    return jsonify(error='The post order has changed. Refresh the feed.'), 400
                placeholders = ', '.join('?' for _ in cursor)
                conditions.append(f'({cursor_columns}) < ({placeholders})')
                args.extend(cursor)
            where = ('WHERE ' + ' AND '.join(conditions)) if conditions else ''
            order = 'likes + 2 * comments DESC, ' if ranking else ''
            rows = con.execute(f"""
                SELECT p.id, p.author, p.kind, p.title, p.body, p.paper_url, p.created_at,
                       p.category, p.topic, p.owner='community-demo' AS demo, f.filename AS attachment_name,
                       EXISTS(SELECT 1 FROM community_likes WHERE post_id=p.id AND owner=?) AS liked,
                       EXISTS(SELECT 1 FROM community_saves WHERE post_id=p.id AND owner=?) AS saved,
                       {LIKES} AS likes, {COMMENTS} AS comments
                FROM community_posts p LEFT JOIN community_papers f ON f.post_id=p.id
                {where}
                ORDER BY {order}p.created_at DESC, p.id DESC LIMIT ?
            """, (*args, POSTS_PER_PAGE + 1)).fetchall()
            counts = con.execute("""
                SELECT COUNT(*) AS posts, COUNT(CASE WHEN kind='paper' THEN 1 END) AS papers,
                       (SELECT COUNT(*) FROM community_comments) AS comments
                FROM community_posts
            """).fetchone()
            hot = [dict(row) for row in con.execute(f"""
                SELECT p.topic, COUNT(*) AS posts
                FROM community_posts p WHERE p.topic != ''
                GROUP BY p.topic ORDER BY SUM({POPULARITY}) DESC, COUNT(*) DESC, MAX(p.created_at) DESC
                LIMIT 5
            """)]
            if not hot:
                hot = [dict(row) for row in con.execute(f"""
                    SELECT substr(CASE WHEN p.title != '' THEN p.title ELSE p.body END, 1, 25) AS excerpt,
                           {LIKES} + {COMMENTS} AS interactions
                    FROM community_posts p WHERE {POPULARITY} > 0
                    ORDER BY {POPULARITY} DESC, p.created_at DESC LIMIT 5
                """)]
        items = [dict(row, liked=bool(row['liked']), saved=bool(row['saved'])) for row in rows[:POSTS_PER_PAGE]]
        next_before = items[-1]['id'] if len(rows) > POSTS_PER_PAGE else None
        return jsonify(items=items, next_before=next_before, author=author(), counts=dict(counts), hot=hot)

    @community.post('/posts')
    def create_post():
        request.max_content_length = PDF_LIMIT + 64 * 1024
        if request.mimetype not in ('multipart/form-data', 'application/x-www-form-urlencoded'):
            return jsonify(error='Use the post form to publish.'), 415
        values = request.form
        kind = values.get('kind', 'post')
        if kind not in ('post', 'paper'):
            return jsonify(error='Choose a valid post type.'), 400
        try:
            is_paper = kind == 'paper'
            category = 'research' if is_paper else values.get('category', 'life')
            if not is_paper and category not in ('life', 'knowledge'):
                raise ValueError('Choose a valid post category.')
            topic = field(values, 'topic', 28, 'Topic').strip('#＃').strip()
            name = author(values)
            body = field(values, 'body', 3000, 'Post text', required=not is_paper)
            title = field(values, 'title', 120, 'Paper title', required=True) if is_paper else ''
            url = paper_link(field(values, 'paper_url', 2048, 'Paper link')) if is_paper else ''
            attachment = pdf_attachment(request.files.get('paper')) if is_paper else None
            if is_paper and not (body or url or attachment):
                raise ValueError('Add a paper summary, a link or a PDF.')
        except ValueError as error:
            return jsonify(error=str(error)), 400
        post_id = uuid4().hex
        with closing(connection()) as con, con:
            con.execute("""
                INSERT INTO community_posts(id, owner, author, kind, title, body, paper_url, created_at, category, topic)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (post_id, owner(), name, kind, title, body, url, timestamp(), category, topic))
            if attachment:
                con.execute("INSERT INTO community_papers VALUES (?, ?, ?)", (post_id, *attachment))
        session['community_author'] = name
        return jsonify(id=post_id, author=name), 201

    @community.post('/posts/<post_id>/like')
    def like(post_id):
        body = request.get_json(silent=True)
        if not isinstance(body, dict) or type(body.get('liked')) is not bool:
            return jsonify(error='Specify whether the post is liked.'), 400
        viewer = owner()
        liked = body['liked']
        with closing(connection()) as con, con:
            if not con.execute("SELECT 1 FROM community_posts WHERE id=?", (post_id,)).fetchone():
                return jsonify(error='Post not found.'), 404
            if liked:
                con.execute("INSERT OR IGNORE INTO community_likes VALUES (?, ?)", (post_id, viewer))
            else:
                con.execute("DELETE FROM community_likes WHERE post_id=? AND owner=?", (post_id, viewer))
            count = con.execute("SELECT COUNT(*) FROM community_likes WHERE post_id=?", (post_id,)).fetchone()[0]
        return jsonify(liked=liked, likes=count)

    @community.post('/posts/<post_id>/save')
    def save(post_id):
        body = request.get_json(silent=True)
        if not isinstance(body, dict) or type(body.get('saved')) is not bool:
            return jsonify(error='Specify whether the post is saved.'), 400
        viewer, saved = owner(), body['saved']
        with closing(connection()) as con, con:
            if not con.execute('SELECT 1 FROM community_posts WHERE id=?', (post_id,)).fetchone():
                return jsonify(error='Post not found.'), 404
            if saved:
                con.execute('INSERT OR IGNORE INTO community_saves VALUES (?, ?)', (post_id, viewer))
            else:
                con.execute('DELETE FROM community_saves WHERE post_id=? AND owner=?', (post_id, viewer))
        return jsonify(saved=saved)

    @community.get('/posts/<post_id>/comments')
    def comments(post_id):
        with closing(connection()) as con:
            if not con.execute("SELECT 1 FROM community_posts WHERE id=?", (post_id,)).fetchone():
                return jsonify(error='Post not found.'), 404
            args = [post_id]
            older = ''
            if before := request.args.get('before'):
                cursor = con.execute("""
                    SELECT created_at, id FROM community_comments WHERE post_id=? AND id=?
                """, (post_id, before)).fetchone()
                if cursor is None:
                    return jsonify(error='The comment order has changed. Refresh the comments.'), 400
                older = 'AND (created_at, id) < (?, ?)'
                args.extend(cursor)
            rows = con.execute(f"""
                SELECT id, author, body, created_at FROM community_comments WHERE post_id=? {older}
                ORDER BY created_at DESC, id DESC LIMIT ?
            """, (*args, COMMENTS_PER_PAGE + 1)).fetchall()
            count = con.execute("SELECT COUNT(*) FROM community_comments WHERE post_id=?", (post_id,)).fetchone()[0]
        items = [dict(row) for row in rows[:COMMENTS_PER_PAGE]]
        return jsonify(items=items, count=count,
                       next_before=items[-1]['id'] if len(rows) > COMMENTS_PER_PAGE else None)

    @community.post('/posts/<post_id>/comments')
    def create_comment(post_id):
        values = request.get_json(silent=True)
        if not isinstance(values, dict):
            return jsonify(error='Enter a comment.'), 400
        try:
            name = author(values)
            body = field(values, 'body', 500, 'Comment', required=True)
        except ValueError as error:
            return jsonify(error=str(error)), 400
        with closing(connection()) as con, con:
            if not con.execute("SELECT 1 FROM community_posts WHERE id=?", (post_id,)).fetchone():
                return jsonify(error='Post not found.'), 404
            con.execute("INSERT INTO community_comments VALUES (?, ?, ?, ?, ?, ?)",
                        (uuid4().hex, post_id, owner(), name, body, timestamp()))
        session['community_author'] = name
        return jsonify(author=name), 201

    @community.get('/posts/<post_id>/paper')
    def download_paper(post_id):
        with closing(connection()) as con:
            data = con.execute("SELECT filename, contents FROM community_papers WHERE post_id=?", (post_id,)).fetchone()
        if data is None:
            return jsonify(error='PDF attachment not found.'), 404
        return send_file(BytesIO(data['contents']), mimetype='application/pdf',
                         as_attachment=True, download_name=data['filename'])

    app.register_blueprint(community)
