"""Pure domain logic: validation, feature schema, rule screening and explanations."""
import hashlib
import json
import math
from pathlib import Path
BASE = Path(__file__).resolve().parent
PETS = json.loads((BASE / 'data/pets.json').read_text(encoding='utf-8'))
REAL_PETS = tuple(pet for pet in PETS if not pet.get('fictional'))
ALLERGY_OPTIONS = {pet['id']: pet.get('display_name') or pet['name'] for pet in REAL_PETS}
ALLERGY_FIELDS = {'has_allergy', 'allergy_types', 'allergy_uncertain', 'other_allergy'}
ALLERGY_CAUTION = '过敏风险因人而异。此问卷依据你提供的对象做教学筛选。若对过敏原存疑，可咨询过敏专科医生。'
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
    'space':'照护空间', 'time':'每日照护时间', 'budget':'每月预算', 'activity':'活动强度',
    'noise':'可接受噪声', 'grooming':'护理强度', 'experience':'饲养经验', 'years':'承诺期限',
    'alone_hours':'连续离家时长', 'away_nights':'每月外宿晚数', 'pet_allowed':'居所许可',
    'backup':'替代照护', 'habitat_control':'饲养环境管理', 'live_insects':'活饵准备',
    'allergy':'动物相关过敏', 'has_allergy':'动物相关过敏',
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
        raise ProfileError('过敏对象须从真实宠物选项中选择。')
    uncertain = raw.get('allergy_uncertain', False)
    if type(uncertain) is not bool:
        raise ProfileError('不确定具体过敏原选项须为是或否。')
    other = raw.get('other_allergy', '')
    if not isinstance(other, str) or len(other.strip()) > 100:
        raise ProfileError('其他过敏原须为最多 100 字的说明。')
    return {'has_allergy':True, 'allergy_types':list(dict.fromkeys(types)),
            'allergy_uncertain':uncertain, 'other_allergy':other.strip()}


def validate(raw):
    if not isinstance(raw, dict):
        raise ProfileError('问卷须为有效的 JSON 对象。')
    required = set(USER_KEYS) - OPTIONAL_PROFILE_FIELDS - {'allergy'}
    if 'has_allergy' not in raw:
        required.add('allergy')
    missing = required - raw.keys()
    if missing:
        raise ProfileError('请填写：'+'、'.join(FIELD_NAMES[key] for key in USER_KEYS if key in missing)+'。')
    if raw.keys() - set(USER_KEYS) - ALLERGY_FIELDS:
        raise ProfileError('问卷包含无法识别的字段。')
    detailed = bool(raw.keys() & ALLERGY_FIELDS)
    raw = DEFAULT | raw
    has_allergy = raw.get('has_allergy', raw['allergy'])
    if type(has_allergy) is not bool or type(raw['allergy']) is not bool:
        raise ProfileError('动物相关过敏须为是或否。')
    raw['allergy'] = has_allergy
    out = {}
    ranges = []
    for k,(lo,hi) in LIMITS.items():
        v=raw[k]
        label=FIELD_NAMES[k]
        if type(v) not in (int,float) or (type(v) is float and not math.isfinite(v)) or v < 0:
            raise ProfileError(f'{label}须为大于或等于 0 的有限数值。')
        if not lo <= v <= hi:
            ranges.append({'field':k,'label':label,'minimum':lo,'maximum':hi})
        elif k in ('activity','noise','grooming','experience','alone_hours','away_nights') and int(v)!=v:
            raise ProfileError(f'{label}须为整数。')
        else:
            out[k]=float(v)
    for k in FLAGS:
        if type(raw[k]) is not bool:
            raise ProfileError(f'{FIELD_NAMES[k]}须为是或否。')
        out[k]=raw[k]
    if detailed:
        out.update(validate_allergy({**raw,'has_allergy':has_allergy}))
    if ranges:
        allowed='、'.join(f"{item['label']} {item['minimum']}–{item['maximum']}" for item in ranges)
        raise ProfileError(f'当前输入超出演示模型适用范围（{allowed}），系统无法可靠判断真实宠物适配度。', ranges=ranges)
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

    if p.get('fictional'):
        return {'eligible':False,'blocked':['虚拟伙伴属于独立的桌宠模块'],'exclusion_reasons':[],
                'reasons':[],'warnings':[p['note']]}
    if not u['pet_allowed']: reject('H01','居住条件尚未允许饲养宠物')
    if not u['backup']: reject('H02','尚未安排外出或紧急情况的替代照护')
    if p.get('requires_habitat') and not u.get('habitat_control', DEFAULT['habitat_control']):
        reject('H03','此档案需要能监测并管理温度等饲养环境条件')
    if p.get('requires_live_insects') and not u.get('live_insects', DEFAULT['live_insects']):
        reject('H04','此档案需要能定期准备和处理活饵昆虫')
    for k,rule_id,unit in [('space','H05','㎡'),('time','H06','小时'),('budget','H07','港币'),
                           ('years','H08','年'),('noise','H09','级')]:
        if u[k]<p[k]:
            reject(rule_id,f'{FIELD_NAMES[k]} {u[k]:g} {unit}，低于档案要求的 {p[k]:g} {unit}',
                   field=k,actual=u[k],required=p[k],unit=unit)
    if u['allergy'] and p['id'] in u.get('allergy_types', []):
        reject('A01',f"你选择了对{ALLERGY_OPTIONS[p['id']]}过敏，档案与该过敏对象一致")
    if allergy_uncertain(u) and p['fur']:
        reject('A02','具体过敏原尚未确认，现有演示规则保守排除此有毛宠物档案')
    reasons=[f'可提供 {u["time"]:g} 小时/天；档案要求 {p["time"]:g} 小时',
             f'预算 {u["budget"]:g} 港币/月；档案估计 {p["budget"]:g} 港币/月',
             f'可用空间 {u["space"]:g} ㎡；档案阈值 {p["space"]:g} ㎡']
    warnings=[p['note'],'档案数值为教学假设，不是兽医或动物福利标准；需按个体与当地情况核实。']
    if u['experience']<p['experience']: warnings.append('经验不足，建议先学习照护知识并获得指导。')
    if u['grooming']<p['grooming']: warnings.append('你愿意承担的清洁护理强度可能不足。')
    if u.get('alone_hours', DEFAULT['alone_hours']) > p.get('alone_reference', 10):
        warnings.append('工作日连续离家时间偏长，建议安排中途检查或照护。')
    if u.get('away_nights', DEFAULT['away_nights']):
        reasons.append(f'典型月份有 {u["away_nights"]:g} 晚不在家，需确认替代照护安排。')
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
