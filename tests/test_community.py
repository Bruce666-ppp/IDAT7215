from io import BytesIO
import sqlite3
from contextlib import closing

from app import create_app
from engine import Recommender


def test_public_posts_have_private_like_state_and_shared_comments(tmp_path):
    app = create_app(tmp_path / 'community.sqlite3', Recommender(tmp_path / 'missing.pt'))
    writer, reader = app.test_client(), app.test_client()
    response = writer.post('/api/community/posts', data={'author': '小林', 'body': '分享选宠心得。'})
    assert response.status_code == 201
    post_id = response.get_json()['id']
    route = '/api/community/posts/' + post_id

    visible = reader.get('/api/community/posts').get_json()
    assert visible['items'][0]['body'] == '分享选宠心得。'
    assert visible['items'][0]['author'] == '小林'
    assert reader.get('/api/community/posts?view=mine').get_json()['items'] == []
    assert writer.get('/api/community/posts?view=mine').get_json()['items'][0]['id'] == post_id

    for _ in range(2):
        assert reader.post(route + '/like', json={'liked': True}).get_json() == {'liked': True, 'likes': 1}
    assert writer.get('/api/community/posts').get_json()['items'][0]['liked'] is False
    assert reader.get('/api/community/posts').get_json()['items'][0]['liked'] is True
    assert reader.post(route + '/like', json={'liked': False}).get_json()['likes'] == 0
    assert reader.post(route + '/comments', json={'author': '小宁', 'body': '谢谢分享。'}).status_code == 201
    replies = writer.get(route + '/comments').get_json()
    assert replies['count'] == 1
    assert replies['items'][0]['author'] == '小宁'
    assert replies['items'][0]['body'] == '谢谢分享。'


def test_paper_post_and_download(tmp_path):
    app = create_app(tmp_path / 'community.sqlite3', Recommender(tmp_path / 'missing.pt'))
    writer, reader = app.test_client(), app.test_client()
    assert writer.post('/api/community/posts',data={
        'kind': 'paper', 'title': '课程论文', 'paper_url': 'javascript:alert(1)',
    }).status_code == 400
    assert writer.post('/api/community/posts',data={
        'kind': 'paper', 'title': '课程论文', 'paper': (BytesIO(b'not a PDF'), 'example.pdf'),
    }).status_code == 400

    pdf = b'%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n'
    posted = writer.post('/api/community/posts',data={
        'kind': 'paper', 'title': '课程论文', 'body': '摘要',
        'paper_url': 'https://example.org/paper', 'paper': (BytesIO(pdf), '课程论文.pdf'),
    })
    assert posted.status_code == 201, posted.get_json()
    item = reader.get('/api/community/posts?view=paper').get_json()['items'][0]
    assert item['title'] == '课程论文'
    assert item['attachment_name'] == '课程论文.pdf'
    assert item['paper_url'] == 'https://example.org/paper'
    download = reader.get('/api/community/posts/' + item['id'] + '/paper')
    assert download.mimetype == 'application/pdf'
    assert 'attachment;' in download.headers['Content-Disposition']
    assert download.data == pdf


def test_feed_search_popularity_and_saved_are_scoped(tmp_path):
    database = tmp_path / 'community.sqlite3'
    initial_engine = Recommender(tmp_path / 'missing.pt')
    app = create_app(database, initial_engine)
    author, viewer = app.test_client(), app.test_client()
    demo = viewer.get('/api/community/posts').get_json()
    assert len(demo['items']) == 4 and all(post['demo'] for post in demo['items'])
    earlier = author.post('/api/community/posts', data={
        'body': '适合新手的时间安排', 'category': 'knowledge', 'topic': '#新手交流#',
    }).get_json()['id']
    latest = author.post('/api/community/posts', data={'body': '今天的日常'}).get_json()['id']
    assert viewer.post(f'/api/community/posts/{earlier}/like', json={'liked': True}).status_code == 200
    assert viewer.post(f'/api/community/posts/{earlier}/comments', json={'body': '分享得好'}).status_code == 201

    def items(client, view, query=''):
        response = client.get('/api/community/posts', query_string={'view': view, 'q': query})
        assert response.status_code == 200
        return [post['id'] for post in response.get_json()['items']]

    assert items(viewer, 'all')[0] == latest
    assert items(viewer, 'popular')[0] == earlier
    assert items(viewer, 'knowledge', '新手交流') == [earlier]
    assert items(viewer, 'life', '新手交流') == []
    assert items(viewer, 'all', '时间安排') == [earlier]
    assert items(viewer, 'paper', 'Reading Card Demo') == ['demo-paper']
    assert viewer.get('/api/community/posts').get_json()['hot'][0]['topic'] == '新手交流'

    save_url = f'/api/community/posts/{earlier}/save'
    assert viewer.post(save_url, json={'saved': True}).get_json()['saved'] is True
    assert items(viewer, 'saved') == [earlier]
    assert items(author, 'saved') == []
    assert viewer.post(save_url, json={'saved': False}).get_json()['saved'] is False
    assert items(viewer, 'saved') == []
    assert create_app(database, initial_engine).test_client().get('/api/community/posts').get_json()['counts']['posts'] == 6


def test_existing_posts_are_migrated_without_demo_insertion(tmp_path):
    database = tmp_path / 'existing.sqlite3'
    with closing(sqlite3.connect(database)) as con, con:
        con.executescript("""
            CREATE TABLE community_posts (
                id TEXT PRIMARY KEY, owner TEXT NOT NULL, author TEXT NOT NULL, kind TEXT NOT NULL,
                title TEXT NOT NULL, body TEXT NOT NULL, paper_url TEXT NOT NULL, created_at TEXT NOT NULL
            );
            INSERT INTO community_posts VALUES
                ('existing-post', 'owner-a', '原作者', 'paper', '已有论文', '保留的正文', '', '2026-11-01T12:00:00+00:00');
        """)
    app = create_app(database, Recommender(tmp_path / 'missing.pt'))
    posts = app.test_client().get('/api/community/posts').get_json()['items']
    assert len(posts) == 1
    assert (posts[0]['body'], posts[0]['category'], posts[0]['demo']) == ('保留的正文', 'research', 0)


def test_existing_demo_copy_is_localised_and_user_posts_are_preserved(tmp_path):
    database=tmp_path/'community.sqlite3'
    engine=Recommender(tmp_path/'missing.pt')
    writer=create_app(database,engine).test_client()
    post=writer.post('/api/community/posts',data={'author':'小林','body':'原有帖子'})
    assert post.status_code==201
    with closing(sqlite3.connect(database)) as con, con:
        con.execute("UPDATE community_posts SET title=?, topic=? WHERE id='demo-paper'",
                    ('阅读卡片示例','阅读笔记'))

    reader=create_app(database,engine).test_client()
    feed=reader.get('/api/community/posts').get_json()
    items={post['id']:post for post in feed['items']}
    personal=items[post.get_json()['id']]
    assert (personal['author'],personal['body'])==('小林','原有帖子')
    assert items['demo-paper']['title'].startswith('Reading Card Demo')
    assert 'Reading Notes' in {item['topic'] for item in feed['hot']}
