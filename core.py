"""Pure domain logic: validation, feature schema, rule screening and explanations."""
import hashlib
import json
import math
from pathlib import Path
BASE = Path(__file__).resolve().parent
PETS = json.loads((BASE / 'data/pets.json').read_text(encoding='utf-8'))
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

def validate(raw):
    if not isinstance(raw, dict):
        raise ValueError('用户资料必须是 JSON 对象')
    required = set(USER_KEYS) - OPTIONAL_PROFILE_FIELDS
    if not required <= raw.keys() <= set(USER_KEYS):
        raise ValueError('问卷字段缺失或多余。必填字段：'+', '.join(k for k in USER_KEYS if k in required))
    raw = DEFAULT | raw
    out = {}
    for k,(lo,hi) in LIMITS.items():
        v=raw[k]
        if type(v) not in (int,float) or not math.isfinite(v) or not lo <= v <= hi:
            raise ValueError(f'{k} 必须是 {lo} 到 {hi} 的有限数值')
        if k in ('activity','noise','grooming','experience','alone_hours','away_nights') and int(v)!=v:
            raise ValueError(f'{k} 必须是整数')
        out[k]=float(v)
    for k in FLAGS:
        if type(raw[k]) is not bool:
            raise ValueError(f'{k} 必须是布尔值')
        out[k]=raw[k]
    return out

def features(u,p):
    user=[(u[k]-lo)/(hi-lo) for k,(lo,hi) in LIMITS.items()]
    user += [float(u[k]) for k in FLAGS]
    pet=[(p[k]-LIMITS[k][0])/(LIMITS[k][1]-LIMITS[k][0]) for k in PET_KEYS[:-1]]
    return user+pet+[float(p['fur'])]

def assess(u,p):
    """Hard exclusions are never overridden by the neural score."""
    blocked=[]
    if p.get('fictional'):
        return {'eligible':False,'blocked':['奶龙是虚构角色，不参与真实养宠推荐'],'reasons':[],'warnings':[p['note']]} 
    if not u['pet_allowed']: blocked.append('居住条件尚未允许饲养宠物')
    if not u['backup']: blocked.append('尚未安排外出或紧急情况的替代照护')
    if p.get('requires_habitat') and not u.get('habitat_control', DEFAULT['habitat_control']):
        blocked.append('此档案需要能监测并管理温度等饲养环境条件')
    if p.get('requires_live_insects') and not u.get('live_insects', DEFAULT['live_insects']):
        blocked.append('此档案需要能定期准备和处理活饵昆虫')
    for k,label,unit in [('space','可用照护空间','㎡'),('time','每日照护时间','小时'),
                         ('budget','每月预算','港币'),('years','可承诺照护期限','年')]:
        if u[k]<p[k]: blocked.append(f'{label}低于本演示档案阈值 {p[k]} {unit}')
    if u['allergy'] and p['fur']:
        blocked.append('报告了动物相关过敏，演示规则保守排除有毛宠物')
    if u['noise']<p['noise']: blocked.append('可接受噪声等级低于档案要求')
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
    if u['allergy']: warnings.append('无毛或无皮毛不代表不会过敏；本系统不做过敏风险诊断。')
    return {'eligible':not blocked,'blocked':blocked,'reasons':reasons,'warnings':warnings}

def rule_score(u,p):
    if not assess(u,p)['eligible']: return 0.0
    activity=1-abs(u['activity']-p['activity'])/4
    care=min(1,u['grooming']/p['grooming'])
    experience=1 if u['experience']>=p['experience'] else .5
    time=min(1,u['time']/(p['time']*1.5))
    budget=min(1,u['budget']/(p['budget']*1.5))
    absence = max(0.0, u.get('alone_hours', DEFAULT['alone_hours']) - p.get('alone_reference', 10))
    travel = u.get('away_nights', DEFAULT['away_nights'])
    continuity = max(0.0, 1 - absence / 12 - (travel / 30) * (p['grooming'] / 5))
    return .30*activity+.20*care+.15*experience+.15*time+.10*budget+.10*continuity
