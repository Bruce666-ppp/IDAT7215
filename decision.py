"""Explainable final decisions and the virtual companion fallback."""
from enum import StrEnum

from core import ALLERGY_CAUTION, DISPLAY_PETS, REAL_PETS, allergy_uncertain


class Status(StrEnum):
    REAL_PET_RECOMMENDATION = 'REAL_PET_RECOMMENDATION'
    NO_ELIGIBLE_PET = 'NO_ELIGIBLE_PET'
    LOW_COMPATIBILITY = 'LOW_COMPATIBILITY'
    OUT_OF_DOMAIN = 'OUT_OF_DOMAIN'
    INVALID_INPUT = 'INVALID_INPUT'
    SYSTEM_ERROR = 'SYSTEM_ERROR'


RULES = {
    'H01': ('Housing permission', 'Confirm that your housing or tenancy allows pets, then revisit your answers.'),
    'H02': ('Backup care', 'Arrange reliable backup care for absences and emergencies.'),
    'H03': ('Special habitat requirements', 'Check the profile’s habitat equipment and temperature requirements.'),
    'H04': ('Live feeder insect preparation', 'Make sure you can regularly source and handle the food this pet needs.'),
    'H05': ('Available space', 'Compare the space you can provide long-term with the profile’s needs.'),
    'H06': ('Daily care time', 'Check how much time you can reliably set aside for daily care.'),
    'H07': ('Monthly budget', 'Work out a sustainable budget that covers everyday and emergency costs.'),
    'H08': ('Long-term care commitment', 'Check how many years you can commit to providing care.'),
    'H09': ('Noise tolerance', 'Check what noise level suits your home and the people you live with.'),
    'A01': ('Known allergy match', 'Keep avoiding your known allergens and ask a specialist to assess any risks as needed.'),
    'A02': ('Precautionary filtering for an unconfirmed allergen', 'Once you know the specific allergen, you can retake the quiz with that information.'),
    'A03': ('Unconfirmed allergen', 'Once you know the specific allergen, you can retake the quiz with that information.'),
    'A04': ('Other allergens to check', 'If a reported allergen falls outside these profiles, you can consult an allergy specialist.'),
}

HTTP_STATUS = {Status.OUT_OF_DOMAIN:422, Status.INVALID_INPUT:400, Status.SYSTEM_ERROR:503}
VIRTUAL_PET = next(pet for pet in DISPLAY_PETS if pet['id']=='nailong' and pet.get('fictional'))


def virtual_companion(status, reason):
    """Offer a real desktop pet feature after a valid decision, never a model score."""
    if status not in (Status.NO_ELIGIBLE_PET, Status.LOW_COMPATIBILITY, Status.OUT_OF_DOMAIN):
        return False, None, None
    fallback = status != Status.OUT_OF_DOMAIN
    return fallback, reason, {
        'id':VIRTUAL_PET['id'], 'name':VIRTUAL_PET['name'], 'optional':not fallback,
        'message':(
            'Given your current situation, you can try caring for Naylong virtually and take your time considering a real pet.'
            if fallback else 'You can try Naylong as a desktop pet and reassess real-pet compatibility when your answers are within the model’s supported range.'
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
                              'reason':'Screening takes your reported allergy into account. The specific allergy risk still needs to be confirmed.'}
        if profile.get('other_allergy'):
            triggered['A04']={'rule_id':'A04','label':RULES['A04'][0],'kind':'caution','pet_ids':[],
                              'reason':'Other allergens you enter are available for review. The rules match allergies against the pet profiles you select.'}
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
        'notice':'Compatibility scores are for this course demo. The care profiles supply the screening rules.',
    }
    if status in HTTP_STATUS:
        payload['error']=reason
    return payload
