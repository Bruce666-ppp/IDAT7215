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
    assert any('不允许' in reason or '未允许' in reason
               for pet in forbidden['excluded'] for reason in pet['blocked'])
    assert any(pet['id']=='cat' and any('过敏' in reason for reason in pet['blocked']) for pet in allergy['excluded'])
    assert any('4 晚不在家' in reason for pet in allergy['recommendations'] for reason in pet['reasons'])
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
    assert '服务休眠或重启后会清空问卷、评分和社区记录' in index.get_data(as_text=True)
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
