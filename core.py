"""Pure domain logic: validation, feature schema, rule screening and explanations."""
import hashlib
import json
import math
from pathlib import Path
BASE = Path(__file__).resolve().parent
PETS = json.loads((BASE / 'data/pets.json').read_text(encoding='utf-8'))
REAL_PETS = tuple(pet for pet in PETS if not pet.get('fictional'))
# The English display copy is separate from the catalog fingerprint used by the model.
PET_TEXT = json.loads((BASE / 'data/pets.en.json').read_text(encoding='utf-8'))
DISPLAY_PETS = [{**pet, **PET_TEXT[pet['id']]} for pet in PETS]
ALLERGY_OPTIONS = {pet['id']: PET_TEXT[pet['id']]['display_name'] for pet in REAL_PETS}
ALLERGY_FIELDS = {'has_allergy', 'allergy_types', 'allergy_uncertain', 'other_allergy'}
ALLERGY_CAUTION = 'Allergy risks vary from person to person. This quiz uses the allergies you report for demonstration screening. If you’re unsure about an allergen, you can consult an allergy specialist.'
MODEL_EVALUATION_NOTE = 'These evaluation results describe this dataset and its labels only.'
SCHEMA = 2
# Monetary values are HKD per month. All catalog thresholds are editable DEMO assumptions.
LIMITS = {'space': (0, 500), 'time': (0, 12), 'budget': (0, 10000),
          'activity': (1, 5), 'noise': (1, 5), 'grooming': (1, 5),
          'experience': (0, 2), 'years': (0, 30), 'alone_hours': (0, 16), 'away_nights': (0, 30)}
FLAGS = ['allergy', 'pet_allowed', 'backup', 'habitat_control', 'live_insects']
USER_KEYS = list(LIMITS) + FLAGS
PET_KEYS = ['space','time','budget','activity','noise','grooming','experience','years','fur']
INPUT_DIM = len(USER_KEYS) + len(PET_KEYS)
CATALOG_HASH = hashlib.sha256(json.dumps(PETS,sort_keys=True).encode()).hexdigest()
DEFAULT = dict(space=30,time=2,budget=1000,activity=3,noise=3,grooming=3,
               experience=0,years=15,allergy=False,pet_allowed=True,backup=True,
               alone_hours=8,away_nights=0,habitat_control=False,live_insects=False)
OPTIONAL_PROFILE_FIELDS = {'alone_hours', 'away_nights', 'habitat_control', 'live_insects'}
FIELD_NAMES = {
    'space':'Available space', 'time':'Daily care time', 'budget':'Monthly budget', 'activity':'Activity level',
    'noise':'Noise tolerance', 'grooming':'Grooming and cleaning', 'experience':'Pet care experience', 'years':'Care commitment',
    'alone_hours':'Hours away at a time', 'away_nights':'Nights away per month', 'pet_allowed':'Housing permission',
    'backup':'Backup care', 'habitat_control':'Habitat management', 'live_insects':'Live feeder insect preparation',
    'allergy':'Animal-related allergy', 'has_allergy':'Animal-related allergy',
}


class ProfileError(ValueError):
    def __init__(self, message, *, ranges=()):
        super().__init__(message)
        self.ranges = ranges


def validate_allergy(raw):
    if not raw['has_allergy']:
        return {'has_allergy':False, 'allergy_types':[], 'allergy_uncertain':False, 'other_allergy':''}
    types = raw.get('allergy_types', [])
    if (not isinstance(types, list) or len(types) > len(ALLERGY_OPTIONS)
            or any(not isinstance(kind, str) or kind not in ALLERGY_OPTIONS for kind in types)):
        raise ProfileError('Choose allergens from the real-pet options.')
    uncertain = raw.get('allergy_uncertain', False)
    if type(uncertain) is not bool:
        raise ProfileError('The allergen uncertainty field must be true or false.')
    other = raw.get('other_allergy', '')
    if not isinstance(other, str) or len(other.strip()) > 100:
        raise ProfileError('Describe any other allergens in up to 100 characters.')
    return {'has_allergy':True, 'allergy_types':list(dict.fromkeys(types)),
            'allergy_uncertain':uncertain, 'other_allergy':other.strip()}


def validate(raw):
    if not isinstance(raw, dict):
        raise ProfileError('Submit the quiz as a valid JSON object.')
    required = set(USER_KEYS) - OPTIONAL_PROFILE_FIELDS - {'allergy'}
    if 'has_allergy' not in raw:
        required.add('allergy')
    missing = required - raw.keys()
    if missing:
        raise ProfileError('Complete the following fields: '+', '.join(FIELD_NAMES[key] for key in USER_KEYS if key in missing)+'.')
    if raw.keys() - set(USER_KEYS) - ALLERGY_FIELDS:
        raise ProfileError('The quiz contains unrecognised fields.')
    detailed = bool(raw.keys() & ALLERGY_FIELDS)
    raw = DEFAULT | raw
    has_allergy = raw.get('has_allergy', raw['allergy'])
    if type(has_allergy) is not bool or type(raw['allergy']) is not bool:
        raise ProfileError('Select yes or no for animal-related allergies.')
    raw['allergy'] = has_allergy
    out = {}
    ranges = []
    for k,(lo,hi) in LIMITS.items():
        v=raw[k]
        label=FIELD_NAMES[k]
        if type(v) not in (int,float) or (type(v) is float and not math.isfinite(v)) or v < 0:
            raise ProfileError(f'{label} must be a finite number of 0 or more.')
        if not lo <= v <= hi:
            ranges.append({'field':k,'label':label,'minimum':lo,'maximum':hi})
        elif k in ('activity','noise','grooming','experience','alone_hours','away_nights') and int(v)!=v:
            raise ProfileError(f'{label} must be a whole number.')
        else:
            out[k]=float(v)
    for k in FLAGS:
        if type(raw[k]) is not bool:
            raise ProfileError(f'{FIELD_NAMES[k]} must be true or false.')
        out[k]=raw[k]
    if detailed:
        out.update(validate_allergy({**raw,'has_allergy':has_allergy}))
    if ranges:
        allowed=', '.join(f"{item['label']} {item['minimum']}–{item['maximum']}" for item in ranges)
        raise ProfileError(f'Your answers are outside the demo model’s supported range ({allowed}). Real-pet compatibility cannot be assessed reliably.', ranges=ranges)
    return out

def features(u,p):
    user=[(u[k]-lo)/(hi-lo) for k,(lo,hi) in LIMITS.items()]
    user += [float(u[k]) for k in FLAGS]
    pet=[(p[k]-LIMITS[k][0])/(LIMITS[k][1]-LIMITS[k][0]) for k in PET_KEYS[:-1]]
    return user+pet+[float(p['fur'])]

def allergy_uncertain(u):
    return u['allergy'] and (u.get('allergy_uncertain', False) or not u.get('allergy_types'))


def assess(u,p):
    """Hard exclusions are never overridden by the neural score."""
    violations=[]
    def reject(rule_id, reason, **comparison):
        violations.append({'rule_id':rule_id,'reason':reason,**comparison})

    note = PET_TEXT.get(p.get('id'), p)['note']
    if p.get('fictional'):
        return {'eligible':False,'blocked':['Virtual companions are available in the separate desktop pet feature.'],'exclusion_reasons':[],
                'reasons':[],'warnings':[note]}
    if not u['pet_allowed']: reject('H01','Your housing does not currently allow pets.')
    if not u['backup']: reject('H02','Backup care for absences or emergencies has not been arranged.')
    if p.get('requires_habitat') and not u.get('habitat_control', DEFAULT['habitat_control']):
        reject('H03','This profile requires you to monitor and manage habitat conditions such as temperature.')
    if p.get('requires_live_insects') and not u.get('live_insects', DEFAULT['live_insects']):
        reject('H04','This profile requires regular preparation and handling of live feeder insects.')
    for k,rule_id,unit in [('space','H05','m²'),('time','H06','h'),('budget','H07','HKD'),
                           ('years','H08','years'),('noise','H09','levels')]:
        if u[k]<p[k]:
            reject(rule_id,f'{FIELD_NAMES[k]} {u[k]:g} {unit} is below the profile requirement of {p[k]:g} {unit}.',
                   field=k,actual=u[k],required=p[k],unit=unit)
    if u['allergy'] and p['id'] in u.get('allergy_types', []):
        reject('A01',f"Your selected allergy matches this profile ({ALLERGY_OPTIONS[p['id']]}).")
    if allergy_uncertain(u) and p['fur']:
        reject('A02','The allergen is unconfirmed, so the demo applies a precautionary filter to this pet with fur.')
    reasons=[f'You can provide {u["time"]:g} h of care per day. The profile requires {p["time"]:g} h.',
             f'Your monthly budget is HK$ {u["budget"]:g}. The profile estimates HK$ {p["budget"]:g} per month.',
             f'You have {u["space"]:g} m² available. The profile requires {p["space"]:g} m².']
    warnings=[note,'Care figures are for teaching purposes only. Check the individual animal’s needs and local requirements against relevant veterinary and welfare guidance.']
    if u['experience']<p['experience']: warnings.append('Build your care knowledge and seek guidance if you have less experience than the profile calls for.')
    if u['grooming']<p['grooming']: warnings.append('The amount of grooming and cleaning you can take on may fall short of this profile’s needs.')
    if u.get('alone_hours', DEFAULT['alone_hours']) > p.get('alone_reference', 10):
        warnings.append('You’re away for long stretches on weekdays. Consider arranging a check-in or care while you’re out.')
    if u.get('away_nights', DEFAULT['away_nights']):
        reasons.append(f'You spend {u["away_nights"]:g} nights away in a typical month. Confirm your backup care arrangements.')
    if u['allergy']: warnings.append(ALLERGY_CAUTION)
    return {'eligible':not violations,'blocked':[check['reason'] for check in violations],
            'exclusion_reasons':violations,'reasons':reasons,'warnings':warnings}

def rule_score(u,p,*,assessment=None):
    report=assess(u,p) if assessment is None else assessment
    if not report['eligible']: return 0.0
    activity=1-abs(u['activity']-p['activity'])/4
    care=min(1,u['grooming']/p['grooming'])
    experience=1 if u['experience']>=p['experience'] else .5
    time=min(1,u['time']/(p['time']*1.5))
    budget=min(1,u['budget']/(p['budget']*1.5))
    absence = max(0.0, u.get('alone_hours', DEFAULT['alone_hours']) - p.get('alone_reference', 10))
    travel = u.get('away_nights', DEFAULT['away_nights'])
    continuity = max(0.0, 1 - absence / 12 - (travel / 30) * (p['grooming'] / 5))
    return .30*activity+.20*care+.15*experience+.15*time+.10*budget+.10*continuity
