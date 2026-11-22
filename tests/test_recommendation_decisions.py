import pytest
import torch

from app import create_app
from core import ALLERGY_OPTIONS, DEFAULT, INPUT_DIM, REAL_PETS, features, validate
from decision import Status
from engine import Recommender


SUFFICIENT = {
    **DEFAULT, 'space':80, 'time':6, 'budget':4000, 'years':25,
    'activity':5, 'noise':5, 'grooming':5, 'experience':2, 'alone_hours':4,
    'habitat_control':True, 'live_insects':True,
}


@pytest.fixture(scope='module')
def engine():
    return Recommender()


def ids(result):
    return {pet['id'] for pet in result['recommended_pets']}


def test_sufficient_conditions_use_original_model_and_real_pet_catalog(engine,tmp_path):
    app=create_app(tmp_path/'decision.sqlite3',engine)
    client=app.test_client()
    info=client.get('/api/info').get_json()
    assert [option['id'] for option in info['allergy_options']]==list(ALLERGY_OPTIONS)
    assert len(info['pets'])==len(ALLERGY_OPTIONS)+1
    response=client.post('/api/recommend',json={**SUFFICIENT,'has_allergy':False})
    result=response.get_json()
    assert response.status_code==200
    assert result['recommendation_status']==Status.REAL_PET_RECOMMENDATION
    assert result['model_inference_status']=='EXECUTED' and result['model_version']==engine.version
    assert ids(result)==set(ALLERGY_OPTIONS)
    assert result['eligible_count']==len(REAL_PETS)
    assert [pet['score'] for pet in result['ranking']]==sorted(
        (pet['score'] for pet in result['recommended_pets']),reverse=True)
    assert result['virtual_companion'] is None
    assert len(features(validate(SUFFICIENT),REAL_PETS[0]))==INPUT_DIM


@pytest.mark.parametrize('chosen',[['cat'],['cat','small_dog','budgie']])
def test_known_allergies_only_exclude_matching_archives(engine,chosen):
    result=engine.recommend({**SUFFICIENT,'has_allergy':True,'allergy_types':chosen})
    assert ids(result)==set(ALLERGY_OPTIONS)-set(chosen)
    assert result['model_inference_status']=='EXECUTED'
    for pet_id in chosen:
        assert [check['rule_id'] for check in result['exclusion_reasons'][pet_id]]==['A01']
    assert set(next(rule for rule in result['triggered_rules'] if rule['rule_id']=='A01')['pet_ids'])==set(chosen)


def test_clearing_allergy_clears_stale_fields_in_api_and_history(engine,tmp_path):
    client=create_app(tmp_path/'allergy.sqlite3',engine).test_client()
    raw={**SUFFICIENT,'has_allergy':False,'allergy':True,'allergy_types':['cat'],
         'allergy_uncertain':True,'other_allergy':'演示补充'}
    result=client.post('/api/recommend',json=raw).get_json()
    saved=client.get('/api/history/'+result['run_id']).get_json()['profile']
    assert ids(result)==set(ALLERGY_OPTIONS)
    assert not saved['has_allergy'] and not saved['allergy'] and not saved['allergy_uncertain']
    assert saved['allergy_types']==[] and saved['other_allergy']==''


@pytest.mark.parametrize(('change','rule'),[
    ({'pet_allowed':False},'H01'), ({'budget':0},'H07'), ({'space':0},'H05'),
])
def test_no_real_candidate_offers_nailong_without_scoring(engine,change,rule):
    result=engine.recommend({**SUFFICIENT,**change})
    assert result['recommendation_status']==Status.NO_ELIGIBLE_PET
    assert result['fallback_triggered'] and result['virtual_companion']['id']=='nailong'
    assert result['model_inference_status']=='SKIPPED_NO_ELIGIBLE' and result['eligible_count']==0
    assert result['recommended_pets']==result['ranking']==[]
    assert 'score' not in result['virtual_companion']
    assert len(result['excluded_pets'])==len(REAL_PETS)
    assert any(item['rule_id']==rule for item in result['triggered_rules'])
    assert result['suggestions'] and result['fallback_reason']


def test_model_is_never_asked_to_score_excluded_or_virtual_pets():
    class HighScoringModel:
        def __init__(self):
            self.inputs=None
        def __call__(self,inputs):
            self.inputs=inputs
            return torch.full((len(inputs),),100.0)

    recommender=Recommender()
    model=HighScoringModel()
    recommender.model=model
    profile={**SUFFICIENT,'has_allergy':True,'allergy_types':['cat']}
    result=recommender.recommend(profile)
    expected=torch.tensor([features(validate(profile),pet) for pet in REAL_PETS if pet['id']!='cat'])
    assert torch.equal(model.inputs,expected)
    assert all(pet['score']==100.0 for pet in result['recommended_pets'])
    assert 'cat' not in ids(result)
    assert 'nailong' not in ids(result)


def test_uncertain_and_other_allergens_are_reported(engine):
    result=engine.recommend({**SUFFICIENT,'has_allergy':True,'allergy_uncertain':True,'other_allergy':'课程示例'})
    assert result['input_summary']['allergy']
    assert {'A02','A03','A04'}<={rule['rule_id'] for rule in result['triggered_rules']}
    assert result['allergy_notice']
    assert 'cat' not in ids(result)
    assert ids(result)=={pet['id'] for pet in REAL_PETS if not pet['fur']}


@pytest.mark.parametrize('profile',[
    {**SUFFICIENT,'budget':-1}, {k:v for k,v in SUFFICIENT.items() if k!='space'},
    {**SUFFICIENT,'has_allergy':True,'allergy_types':['nailong']},
])
def test_invalid_input_has_no_companion_offer(engine,tmp_path,profile):
    client=create_app(tmp_path/'bad.sqlite3',engine).test_client()
    response=client.post('/api/recommend',json=profile)
    result=response.get_json()
    assert response.status_code==400 and result['recommendation_status']==Status.INVALID_INPUT
    assert not result['fallback_triggered'] and result['virtual_companion'] is None
    assert client.get('/api/history').get_json()['items']==[]


def test_out_of_domain_is_an_unscored_optional_offer(engine,tmp_path):
    client=create_app(tmp_path/'ranges.sqlite3',engine).test_client()
    response=client.post('/api/recommend',json={**SUFFICIENT,'space':501})
    result=response.get_json()
    assert response.status_code==422 and result['recommendation_status']==Status.OUT_OF_DOMAIN
    assert result['range_violations'][0]['maximum']==500
    assert not result['fallback_triggered'] and result['virtual_companion']['optional']
    assert result['model_inference_status']=='SKIPPED_OUT_OF_DOMAIN' and result['ranking']==[]


def test_broken_inference_and_unavailable_model_are_errors(tmp_path,monkeypatch):
    class FailingModel:
        def __call__(self,inputs):
            raise RuntimeError('simulated inference failure')

    recommender=Recommender()
    recommender.model=FailingModel()
    monkeypatch.setenv('PAWTH_REQUIRE_MODEL','1')
    broken=[recommender,Recommender(tmp_path/'missing.pt')]
    for index,model in enumerate(broken):
        client=create_app(tmp_path/f'fail-{index}.sqlite3',model).test_client()
        response=client.post('/api/recommend',json=SUFFICIENT)
        result=response.get_json()
        assert response.status_code==503 and result['recommendation_status']==Status.SYSTEM_ERROR
        assert result['model_inference_status']=='FAILED'
        assert result['virtual_companion'] is None and not result['fallback_triggered']
