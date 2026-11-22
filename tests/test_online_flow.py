import json
import re

import pytest

from app import create_app
from build_pages import build, published_app_url
from core import DEFAULT
from engine import Recommender


def test_model_profiles_feedback_and_restart(tmp_path, monkeypatch):
    monkeypatch.setenv('PAWTH_DATA_DIR', str(tmp_path))
    client=create_app().test_client()
    index=client.get('/')
    assert b'<button id="submit" type="submit">' in index.data
    health=client.get('/api/health').get_json()
    assert health['status']=='ok' and health['model_loaded'] and health['model_version']

    generous=dict(space=80,time=6,budget=7000,years=25,activity=5,noise=5,grooming=5,
                  experience=2,alone_hours=2,habitat_control=True,live_insects=True)
    changes=[
        {},
        generous,
        dict(space=1,time=0.2,budget=80,years=1),
        dict(pet_allowed=False),
        {**generous,'allergy':True,'alone_hours':15,'away_nights':4},
    ]
    results=[]
    for update in changes:
        profile=DEFAULT|update
        response=client.post('/api/recommend',json=profile)
        assert response.status_code==200
        result=response.get_json()
        assert result['mode'].startswith('synthetic')
        assert result['model_version']==health['model_version']
        detail=client.get('/api/history/'+result['run_id']).get_json()
        assert detail['profile']==profile
        assert all(pet['blocked'] for pet in result['excluded'])
        results.append(result)
    normal,high,low,forbidden,allergy=results
    assert len(high['recommendations'])>len(normal['recommendations'])>0
    assert len({result['run_id'] for result in results})==len(results)
    assert not low['recommendations'] and not forbidden['recommendations']
    assert all(any(check['rule_id']=='H01' for check in pet['exclusion_reasons'])
               for pet in forbidden['excluded'])
    assert any(check['rule_id']=='A02' for check in allergy['exclusion_reasons']['cat'])
    assert any('4 nights away' in reason for pet in allergy['recommendations'] for reason in pet['reasons'])
    top=normal['recommendations'][0]
    assert top['reasons'] and 0<=top['score']<=100
    rating=dict(run_id=normal['run_id'],pet_id=top['id'],rating=5)
    assert client.post('/api/feedback',json=rating).status_code==200

    restarted=create_app()
    stranger=restarted.test_client()
    assert stranger.post('/api/feedback',json=rating).status_code==404
    path='/api/history/'+normal['run_id']
    assert stranger.get(path).status_code==404
    visitor=restarted.test_client()
    visitor.set_cookie('session',client.get_cookie('session').value)
    assert visitor.get(path).get_json()['ratings']=={top['id']:5}
    assert (tmp_path/'pawthfinder.sqlite3').exists()


def test_hosted_api_cookies_health_and_mutations(tmp_path,monkeypatch):
    pages_origin='https://bruce666-ppp.github.io'
    origin='https://app.example'
    monkeypatch.setenv('PAWTH_BEHIND_PROXY','1')
    monkeypatch.setenv('PAWTH_SECURE_COOKIES','1')
    monkeypatch.setenv('PAWTH_PAGES_ORIGIN',pages_origin)
    monkeypatch.setenv('PAWTH_ALLOW_TRAINING','0')
    monkeypatch.setenv('PAWTH_REQUIRE_MODEL','1')
    monkeypatch.setenv('PAWTH_TEMPORARY_RECORDS','1')
    app=create_app(tmp_path/'app.sqlite3',Recommender(tmp_path/'missing.pt'))
    client=app.test_client()
    index=client.get('/',base_url=origin)
    assert 'If the service sleeps or restarts, quiz responses, ratings and community records will be cleared.' in index.get_data(as_text=True)
    cookie=index.headers['Set-Cookie']
    assert all(attribute in cookie for attribute in ('Secure','HttpOnly','SameSite=Lax'))
    health=client.get('/api/health',base_url=origin,headers={'Origin':pages_origin})
    assert health.status_code==503 and not health.get_json()['model_loaded']
    assert health.headers['Access-Control-Allow-Origin']==pages_origin
    assert 'Set-Cookie' not in health.headers
    assert 'Access-Control-Allow-Credentials' not in health.headers
    info=client.get('/api/info',base_url=origin,headers={'Origin':pages_origin})
    assert 'Access-Control-Allow-Origin' not in info.headers
    blocked=client.post('/api/recommend',base_url=origin,json=DEFAULT,headers={'Origin':pages_origin})
    assert blocked.status_code==403
    response=client.post('/api/recommend',base_url=origin,json=DEFAULT,headers={'Origin':origin})
    assert response.status_code==503
    assert response.get_json()['recommendation_status']=='SYSTEM_ERROR'
    assert response.get_json()['virtual_companion'] is None
    proxied=client.post('/api/recommend',base_url='http://app.example',json=DEFAULT,
                        headers={'Origin':origin,'X-Forwarded-Proto':'https'})
    assert proxied.status_code==503
    assert proxied.get_json()['recommendation_status']=='SYSTEM_ERROR'
    assert client.post('/api/training/preview',base_url=origin).status_code==403


def test_pages_entry_configuration(tmp_path):
    app_url='https://pawthfinder.example'
    build(tmp_path/'site',app_url)
    index=(tmp_path/'site/index.html').read_text(encoding='utf-8')
    assert 'lang="en-GB"' in index
    assert 'data-pages-preview' in index
    assert 'href="'+app_url+'/#match"' in index
    assert '<button id="submit" type="submit">' in index
    assert '<section class="panel" hidden>' in index
    assert (tmp_path/'site/snapshot/info.json').is_file()
    assert not (tmp_path/'site/data').exists()
    for url in ('http://pawthfinder.example','javascript:alert(1)','https://127.0.0.1',
                'https://user@pawthfinder.example','https://bruce666-ppp.github.io/'):
        with pytest.raises(ValueError):
            published_app_url(url)


def test_english_interface_and_generated_recommendation_copy(tmp_path):
    client=create_app(tmp_path/'english.sqlite3').test_client()
    html=client.get('/').get_data(as_text=True)
    assert '<html lang="en-GB">' in html
    assert 'Your Pet Lifestyle Guide' in html and 'Find My Companion' in html
    han=re.compile(r'[\u3400-\u9fff]')
    assert not han.search(html)

    info=client.get('/api/info').get_json()
    assert next(p for p in info['pets'] if p['id']=='cat')['display_name']=='Cat'
    assert next(p for p in info['pets'] if p['id']=='nailong')['name']=='Naylong'
    allergy=client.post('/api/recommend',json=DEFAULT|{'has_allergy':True,'allergy_types':['cat']}).get_json()
    assert allergy['exclusion_reasons']['cat'][0]['rule_id']=='A01'
    assert 'allergy' in allergy['exclusion_reasons']['cat'][0]['reason'].lower()
    fallback=client.post('/api/recommend',json=DEFAULT|{'pet_allowed':False}).get_json()
    assert fallback['fallback_triggered'] and fallback['virtual_companion']['name']=='Naylong'
    invalid=client.post('/api/recommend',json={}).get_json()
    assert invalid['error'].startswith('Complete the following fields')
    metrics=client.get('/api/model').get_json()['metrics']
    assert metrics['disclaimer']=='These evaluation results describe this dataset and its labels only.'
    assert all(not han.search(row['name']) for row in metrics['per_pet_rows'])
    for payload in (info,allergy,fallback,invalid):
        assert not han.search(json.dumps(payload,ensure_ascii=False))
