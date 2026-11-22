"""Explainable final decisions and the virtual companion fallback."""
from enum import StrEnum

from core import ALLERGY_CAUTION, PETS, REAL_PETS, allergy_uncertain


class Status(StrEnum):
    REAL_PET_RECOMMENDATION = 'REAL_PET_RECOMMENDATION'
    NO_ELIGIBLE_PET = 'NO_ELIGIBLE_PET'
    LOW_COMPATIBILITY = 'LOW_COMPATIBILITY'
    OUT_OF_DOMAIN = 'OUT_OF_DOMAIN'
    INVALID_INPUT = 'INVALID_INPUT'
    SYSTEM_ERROR = 'SYSTEM_ERROR'


RULES = {
    'H01': ('居所许可', '先确认住宅或租约允许饲养，再重新评估。'),
    'H02': ('替代照护', '为外出和紧急情况安排可靠的替代照护。'),
    'H03': ('特殊饲养环境', '先了解档案所需的环境设施和温度管理。'),
    'H04': ('活饵准备', '选择此类宠物前，确认能持续供应及处理所需食物。'),
    'H05': ('照护空间', '核对可长期提供的照护空间与档案要求。'),
    'H06': ('每日照护时间', '先确认日常可以稳定安排的照护时间。'),
    'H07': ('每月预算', '按实际能力估算稳定预算，并考虑日常与应急开销。'),
    'H08': ('长期照护承诺', '确认可持续提供照护的年限。'),
    'H09': ('噪声条件', '确认居家环境和同住者可以接受的噪声程度。'),
    'A01': ('已知过敏对象匹配', '继续避开已知过敏对象，按需要请专业人员确认相关风险。'),
    'A02': ('过敏原未确定的保守筛选', '确认具体过敏对象后，可以按实际情况重新填写问卷。'),
    'A03': ('过敏原尚未确认', '确认具体过敏对象后，可以按实际情况重新填写问卷。'),
    'A04': ('其他过敏原待确认', '如填写的其他过敏原未被档案覆盖，可咨询过敏专科医生。'),
}

HTTP_STATUS = {Status.OUT_OF_DOMAIN:422, Status.INVALID_INPUT:400, Status.SYSTEM_ERROR:503}
VIRTUAL_PET = next(pet for pet in PETS if pet['id']=='nailong' and pet.get('fictional'))


def virtual_companion(status, reason):
    """Offer a real desktop pet feature after a valid decision, never a model score."""
    if status not in (Status.NO_ELIGIBLE_PET, Status.LOW_COMPATIBILITY, Status.OUT_OF_DOMAIN):
        return False, None, None
    fallback = status != Status.OUT_OF_DOMAIN
    return fallback, reason, {
        'id':VIRTUAL_PET['id'], 'name':VIRTUAL_PET['name'], 'optional':not fallback,
        'message':(
            '按照你现在的生活条件，可以先让奶龙陪你体验虚拟养宠，再慢慢考虑真实宠物。'
            if fallback else '你可以先体验奶龙桌宠，等问卷条件适用于模型时再评估真实宠物。'
        ),
    }


def decision(status, reason, *, profile=None, recommendations=(), excluded=(), eligible_count=None,
             inference='NOT_RUN', model=None, ranges=()):
    recommended = list(recommendations)
    rejected = list(excluded)
    exclusion_reasons = {pet['id']:pet['exclusion_reasons'] for pet in rejected}
    triggered = {}
    for pet_id, checks in exclusion_reasons.items():
        for check in checks:
            code=check['rule_id']
            entry=triggered.setdefault(code,{'rule_id':code,'label':RULES[code][0],'kind':'hard_constraint','pet_ids':[]})
            entry['pet_ids'].append(pet_id)
    if profile is not None and eligible_count is not None and profile['allergy']:
        if allergy_uncertain(profile):
            triggered['A03']={'rule_id':'A03','label':RULES['A03'][0],'kind':'caution','pet_ids':[],
                              'reason':'当前筛选按已报告过敏处理，过敏风险仍需进一步确认。'}
        if profile.get('other_allergy'):
            triggered['A04']={'rule_id':'A04','label':RULES['A04'][0],'kind':'caution','pet_ids':[],
                              'reason':'自由填写的过敏原供复核，规则依据明确选择的宠物档案匹配。'}
    fallback, fallback_reason, companion=virtual_companion(status,reason)
    payload={
        **(model or {}),
        'recommendation_status':status, 'recommended_pets':recommended, 'excluded_pets':rejected,
        'recommendations':recommended, 'excluded':rejected,
        'exclusion_reasons':exclusion_reasons, 'triggered_rules':list(triggered.values()),
        'fallback_triggered':fallback, 'fallback_reason':fallback_reason, 'virtual_companion':companion,
        'model_inference_status':inference, 'decision_reason':reason, 'input_summary':profile,
        'eligible_count':eligible_count, 'real_pet_count':len(REAL_PETS),
        'ranking':[
            {'rank':index,'id':pet['id'],'name':pet['name'],'score':pet['score']}
            for index,pet in enumerate(recommended,1)
        ],
        'suggestions':list(dict.fromkeys(RULES[code][1] for code in triggered)),
        'range_violations':list(ranges),
        'allergy_notice':ALLERGY_CAUTION if profile is not None and profile['allergy'] else '',
        'message':reason,
        'notice':'适配评分用于课程演示。照护档案规则提供筛选依据。',
    }
    if status in HTTP_STATUS:
        payload['error']=reason
    return payload
