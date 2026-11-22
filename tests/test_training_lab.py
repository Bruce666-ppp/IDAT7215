import csv
import io
import time

import training_lab
from app import create_app
from core import DEFAULT
from engine import Recommender


def upload(client, name, cat_score, hamster_score):
    template = csv.DictReader(io.StringIO(training_lab.template_csv()))
    csv_file = io.StringIO()
    writer = csv.DictWriter(csv_file, fieldnames=template.fieldnames)
    writer.writeheader()
    scores = {'cat': cat_score, 'hamster': hamster_score, 'nailong': 0}
    for row in template:
        if row['pet_id'] in scores:
            writer.writerow({**row, 'score': scores[row['pet_id']]})
    response = client.post('/api/training/preview', data={
        'dataset': (io.BytesIO(csv_file.getvalue().encode('utf-8-sig')), name),
    })
    assert response.status_code == 200, response.get_json()
    return response.get_json()


def activate(client, job):
    endpoint = '/api/training/' + job['id']
    response = client.post(endpoint + '/start', json={})
    assert response.status_code == 202
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        status = client.get(endpoint).get_json()
        if status['status'] != 'running':
            assert status['status'] == 'done', status
            return status
        time.sleep(0.2)
    raise AssertionError('The actual local training subprocess did not finish')


def cat_score(client):
    results = client.post('/api/recommend', json=DEFAULT).get_json()
    cat = next(pet for pet in results['recommendations'] if pet['id'] == 'cat')
    return results['model_version'], cat['score']


def test_upload_preview_training_activation_and_restart(tmp_path, monkeypatch):
    monkeypatch.setattr(training_lab, 'EPOCHS', 14)
    database = tmp_path / 'test.sqlite3'
    app = create_app(database, Recommender(tmp_path / 'missing.pt'))
    app.testing = True
    client = app.test_client()

    first = upload(client, 'demo-a.csv', 0.95, 0.05)
    assert first['status'] == 'ready' and first['epoch'] == 0
    assert first['users'] == 24 and first['rows'] == 48
    assert client.get('/api/model').get_json()['mode'] == 'rules_only'
    other_client = app.test_client()
    assert other_client.post('/api/training/' + first['id'] + '/start', json={}).status_code == 404

    trained_first = activate(client, first)
    version_a, score_a = cat_score(client)
    assert version_a == trained_first['model_version']

    second = upload(client, 'demo-b.csv', 0.05, 0.95)
    assert second['dataset_sha256'] != first['dataset_sha256']
    assert cat_score(client) == (version_a, score_a)
    trained_second = activate(client, second)
    version_b, score_b = cat_score(client)
    assert version_b == trained_second['model_version'] != version_a
    assert score_b != score_a
    metrics = client.get('/api/model').get_json()
    assert metrics['dataset_name'] == 'demo-b.csv'
    assert metrics['dataset_sha256'] == second['dataset_sha256']
    assert metrics['metrics']['history'] and metrics['metrics']['per_pet_rows']
    assert all(pet['id']!='nailong' for pet in metrics['metrics']['per_pet_rows'])
    assert cat_score(create_app(database).test_client()) == (version_b, score_b)
