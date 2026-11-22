from pathlib import Path
import pytest
import torch
from app import create_app
from core import DEFAULT,PETS,INPUT_DIM,SCHEMA,CATALOG_HASH,validate,features,assess
from engine import Recommender
from network import PetMLP
from train import synthetic,tensors,ndcg,read_real

def test_schema_and_validation():
    assert len(features(DEFAULT,PETS[0]))==INPUT_DIM
    for invalid in [dict(DEFAULT,time=float('nan')),dict(DEFAULT,budget=-1),dict(DEFAULT,allergy='false'),{},[]]:
        with pytest.raises(ValueError): validate(invalid)

def test_rules_cannot_be_overridden(tmp_path):
    model=PetMLP()
    for p in model.parameters(): p.data.zero_()
    model.net[-1].bias.data.fill_(20) # predicts near 100 for EVERY pet
    path=tmp_path/'model.pt'
    torch.save(dict(state_dict=model.state_dict(),schema=SCHEMA,catalog_hash=CATALOG_HASH,source='test'),path)
    engine=Recommender(path)
    for profile in [dict(DEFAULT,pet_allowed=False),dict(DEFAULT,backup=False),dict(DEFAULT,budget=0)]:
        result=engine.recommend(profile)
        assert result['recommendations']==[] and len(result['excluded'])==len(PETS)
    allergy=engine.recommend(dict(DEFAULT,allergy=True))
    assert all(not next(p for p in PETS if p['id']==x['id'])['fur'] for x in allergy['recommendations'])

def test_fallback_and_catalog_guard(tmp_path):
    path=tmp_path/'model.pt'; engine=Recommender(path)
    assert engine.source=='rules_only'
    assert engine.recommend(DEFAULT)['recommendations']
    torch.save(dict(state_dict=PetMLP().state_dict(),schema=SCHEMA,catalog_hash='wrong',source='test'),path)
    assert Recommender(path).source=='rules_only'

def test_gradient_and_shape():
    x,y=tensors(synthetic(12,42)); model=PetMLP(); pred=model(x)
    assert pred.shape==y.shape
    loss=torch.nn.BCEWithLogitsLoss()(pred,y); loss.backward()
    assert all(p.grad is not None and torch.isfinite(p.grad).all() for p in model.parameters())

def test_http_and_feedback_ownership(tmp_path):
    app=create_app(tmp_path/'test.db',Recommender(tmp_path/'missing.pt')); app.config['TESTING']=True
    a=app.test_client(); b=app.test_client()
    assert a.get('/').status_code==200
    assert a.get('/static/app.js').status_code==200
    assert a.get('/api/info').status_code==200
    assert a.post('/api/recommend',json={}).status_code==400
    assert a.post('/api/recommend',data='{',content_type='application/json').status_code==400
    assert a.post('/api/recommend',json=dict(DEFAULT,budget=1e100)).status_code==400
    r=a.post('/api/recommend',json=DEFAULT); assert r.status_code==200
    result=r.get_json(); p=result['recommendations'][0]['id']
    payload=dict(run_id=result['run_id'],pet_id=p,rating=5)
    assert a.post('/api/feedback',json=payload).status_code==200
    assert b.post('/api/feedback',json=payload).status_code==404
    assert a.post('/api/feedback',json=dict(payload,rating=True)).status_code==400
    assert a.post('/api/feedback',json=dict(payload,pet_id='unknown')).status_code==400
    empty=a.post('/api/recommend',json=dict(DEFAULT,time=0)).get_json()
    assert empty['recommendations']==[]

def test_ndcg():
    rows=[('u',DEFAULT,PETS[0],1),('u',DEFAULT,PETS[1],.5)]
    assert ndcg(rows,[1,.5])['ndcg_at_3']==pytest.approx(1)
    assert ndcg(rows,[.5,1])['ndcg_at_3']<1


def test_real_csv_validation(tmp_path):
    import csv,json
    path=tmp_path/'ratings.csv'
    with path.open('w',newline='') as f:
        w=csv.writer(f);w.writerow(['user_id','profile','pet_id','score'])
        w.writerow(['u',json.dumps(DEFAULT),'cat',0.8])
    assert len(read_real(path))==1
    with path.open('a',newline='') as f:
        csv.writer(f).writerow(['u',json.dumps(DEFAULT),'cat',0.2])
    with pytest.raises(ValueError,match='duplicate'): read_real(path)

def test_export_and_retrain_shape(tmp_path,monkeypatch):
    import export_feedback
    folder=tmp_path/'data';folder.mkdir()
    app=create_app(folder/'pawthfinder.sqlite3',Recommender(tmp_path/'missing.pt'))
    a=app.test_client();result=a.post('/api/recommend',json=DEFAULT).get_json()
    a.post('/api/feedback',json=dict(run_id=result['run_id'],pet_id=result['recommendations'][0]['id'],rating=4))
    monkeypatch.setattr(export_feedback,'BASE',tmp_path)
    export_feedback.main()
    rows=read_real(folder/'feedback.csv')
    assert len(rows)==1 and rows[0][3]==0.75


def test_history_isolation_and_restore(tmp_path):
    app=create_app(tmp_path/'test.db',Recommender(tmp_path/'missing.pt'))
    a,b=app.test_client(),app.test_client()
    assert a.get('/api/history').get_json()['items']==[]
    result=a.post('/api/recommend',json=DEFAULT).get_json()
    rid=result['run_id']; pet=result['recommendations'][0]['id']
    a.post('/api/feedback',json=dict(run_id=rid,pet_id=pet,rating=4))
    history=a.get('/api/history').get_json()['items']
    assert len(history)==1 and history[0]['run_id']==rid
    detail=a.get('/api/history/'+rid).get_json()
    assert detail['profile']['budget']==DEFAULT['budget'] and detail['ratings'][pet]==4
    assert b.get('/api/history').get_json()['items']==[]
    assert b.get('/api/history/'+rid).status_code==404
    assert a.get('/api/history/not-real').status_code==404


def test_scenario_is_stateless_and_respects_rules(tmp_path):
    app=create_app(tmp_path/'test.db',Recommender(tmp_path/'missing.pt')); a=app.test_client()
    data=a.post('/api/scenario',json=dict(before=dict(DEFAULT,budget=0),after=DEFAULT)).get_json()
    assert data['before_count']==0 and data['after_count']>0
    assert any(p['state']=='新增合格' for p in data['changes'])
    assert a.get('/api/history').get_json()['items']==[]
    none=a.post('/api/scenario',json=dict(before=DEFAULT,after=dict(DEFAULT,pet_allowed=False))).get_json()
    assert none['after_count']==0
    assert all(p['after'] is None for p in none['changes'])
    assert a.post('/api/scenario',json={'before':DEFAULT}).status_code==400
    assert a.post('/api/scenario',json={'before':DEFAULT,'after':dict(DEFAULT,time=-1)}).status_code==400


def test_session_key_and_model_fallback_info(tmp_path):
    db=tmp_path/'test.db'; engine=Recommender(tmp_path/'missing.pt')
    first=create_app(db,engine);second=create_app(db,engine)
    assert first.secret_key==second.secret_key
    assert (tmp_path/'.session_secret').exists()
    result=first.test_client().get('/api/model').get_json()
    assert result['mode']=='rules_only' and result['metrics'] is None


def test_generated_dataset_reproducible_and_isolated(tmp_path):
    from generate_dataset import generate
    from train import split_csv
    import json,csv,sqlite3
    a,b=tmp_path/'a',tmp_path/'b'
    m=generate(a,40,2026);generate(b,40,2026)
    assert (a/'ratings.csv').read_bytes()==(b/'ratings.csv').read_bytes()
    assert m['rows']==40*len(PETS)
    rows=read_real(a/'ratings.csv');groups,sources,explicit=split_csv(a/'ratings.csv',rows,42)
    sets=[{r[0] for r in groups[p]} for p in ['train','validation','test']]
    assert len(sets[0])==28 and len(sets[1])==6 and len(sets[2])==6
    assert not sets[0]&sets[1] and not sets[0]&sets[2] and not sets[1]&sets[2]
    assert sources=={'synthetic_generated_dataset'} and explicit
    assert all(y==0 for _,u,p,y in rows if not assess(u,p)['eligible'])
    with sqlite3.connect(a/'synthetic.sqlite3') as con:
        assert con.execute('SELECT COUNT(*) FROM ratings').fetchone()[0]==40*len(PETS)


def test_split_rejects_leakage(tmp_path):
    from train import split_csv
    from generate_dataset import generate
    import csv
    path=tmp_path/'dataset';generate(path,40)
    f=path/'ratings.csv'
    with f.open(newline='') as handle: rows=list(csv.DictReader(handle))
    rows[1]['split']='test' if rows[0]['split']!='test' else 'train'
    with f.open('w',newline='') as handle:
        writer=csv.DictWriter(handle,fieldnames=rows[0].keys());writer.writeheader();writer.writerows(rows)
    with pytest.raises(ValueError,match='同一用户跨集合'): split_csv(f,read_real(f),42)


def test_nine_partners_with_fiction_excluded(tmp_path):
    assert len(PETS)==9
    assert len({p['id'] for p in PETS})==9
    assert len([p for p in PETS if p.get('fictional')])==1
    assert next(p for p in PETS if p.get('fictional'))['id']=='nailong'
    engine=Recommender(tmp_path/'no.pt')
    result=engine.recommend(dict(DEFAULT,space=500,time=12,budget=10000,years=30,noise=5,grooming=5,experience=2))
    assert 'nailong' not in {p['id'] for p in result['recommendations']}
    assert any(p['id']=='nailong' and '虚构' in p['blocked'][0] for p in result['excluded'])
