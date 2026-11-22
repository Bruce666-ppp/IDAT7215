"""Reproducible synthetic profiles, labels, fixed user splits and SQLite mirror.
No real people, surveys, veterinary judgements or observed adoption outcomes.
"""
import argparse,csv,hashlib,json,random,sqlite3
from collections import Counter
from contextlib import closing
from pathlib import Path
from core import BASE,PETS,USER_KEYS,CATALOG_HASH,validate,assess,rule_score

def profile(r,scenario):
    u=dict(space=round(r.uniform(3,90),1),time=round(r.uniform(.3,5),1),
           budget=round(r.uniform(150,2800)/10)*10,activity=r.randint(1,5),
           noise=r.randint(1,5),grooming=r.randint(1,5),experience=r.randint(0,2),
           years=r.randint(1,25),allergy=r.random()<.12,pet_allowed=r.random()<.96,backup=r.random()<.9,
           alone_hours=r.randint(2,12),away_nights=r.randrange(8),habitat_control=r.random()<.40,
           live_insects=r.random()<.30)
    if scenario=='ready':
        u.update(time=round(r.uniform(2,5),1),budget=r.randrange(1000,3001,10),years=r.randint(15,25),
                 noise=r.randint(3,5),pet_allowed=True,backup=True,allergy=False)
    elif scenario=='busy': u.update(time=round(r.uniform(.1,1.5),1),budget=r.randrange(300,1601,10))
    elif scenario=='budget': u.update(budget=r.randrange(100,701,10),time=round(r.uniform(1,4),1))
    elif scenario=='active': u.update(activity=r.randint(4,5),space=round(r.uniform(25,100),1),time=round(r.uniform(2,6),1))
    elif scenario=='quiet': u.update(noise=r.randint(1,2),activity=r.randint(1,3))
    elif scenario=='no_permission': u.update(pet_allowed=False)
    elif scenario=='allergy': u.update(allergy=True)
    return validate(u)

def target(u,p,r):
    if not assess(u,p)['eligible']: return 0.0,0.0,False
    # Synthetic teacher: known rule score plus nonlinear resource-preference interactions.
    base=rule_score(u,p)
    harmony=max(0,1-((u['activity']-p['activity'])/4)**2)
    care=min(1,u['grooming']/p['grooming'])
    reserve=min(1,max(0,(u['budget']/p['budget']-1)/1.5))
    teacher=.7*base+.15*harmony*care+.15*reserve
    return round(min(.99,max(.01,teacher+r.gauss(0,.025))),5),round(teacher,5),True

def generate(out,users=6000,seed=2026):
    if users<20: raise ValueError('至少生成 20 位用户')
    out=Path(out);out.mkdir(parents=True,exist_ok=True);r=random.Random(seed)
    ids=[f'syn_{i:06d}' for i in range(users)]
    shuffled=ids.copy();random.Random(42).shuffle(shuffled)
    train=set(shuffled[:int(.7*users)]);val=set(shuffled[int(.7*users):int(.85*users)])
    split={uid:'train' if uid in train else 'validation' if uid in val else 'test' for uid in ids}
    scenarios=['ready']*4+['general']*3+['busy','budget','active','quiet','no_permission','allergy']
    rows=[];people=[];seen=set();scenario_counts=Counter();eligible=Counter();per_pet=Counter()
    for uid in ids:
        scenario=r.choice(scenarios)
        while True:
            u=profile(r,scenario);fingerprint=json.dumps(u,sort_keys=True,separators=(',',':'))
            if fingerprint not in seen: seen.add(fingerprint);break
        people.append(dict(user_id=uid,scenario=scenario,split=split[uid],**u));scenario_counts[scenario]+=1
        for p in PETS:
            score,teacher,ok=target(u,p,r)
            rows.append(dict(user_id=uid,profile=fingerprint,pet_id=p['id'],score=score,
                             split=split[uid],source='synthetic_generated_dataset',eligible=int(ok),teacher_score=teacher))
            eligible[split[uid]]+=int(ok);per_pet[p['id']]+=int(ok)
    fields=['user_id','profile','pet_id','score','split','source','eligible','teacher_score']
    def write_csv(name,records,cols):
        with (out/name).open('w',encoding='utf-8',newline='') as f:
            w=csv.DictWriter(f,fieldnames=cols);w.writeheader();w.writerows(records)
    write_csv('profiles.csv',people,['user_id','scenario','split']+USER_KEYS)
    write_csv('ratings.csv',rows,fields)
    for part in ['train','validation','test']: write_csv(part+'.csv',[x for x in rows if x['split']==part],fields)
    (out/'pets_snapshot.json').write_text(json.dumps(PETS,ensure_ascii=False,indent=2),encoding='utf-8')
    # Rebuild via temp database and atomically replace only this generated dataset.
    tmp=out/'synthetic.tmp.sqlite3'
    if tmp.exists(): tmp.unlink()
    with closing(sqlite3.connect(tmp)) as con, con:
        con.executescript('CREATE TABLE profiles(user_id TEXT PRIMARY KEY, profile_json TEXT, scenario TEXT, split TEXT);'
                         'CREATE TABLE pets(pet_id TEXT PRIMARY KEY, attributes_json TEXT);'
                         'CREATE TABLE ratings(user_id TEXT REFERENCES profiles(user_id), pet_id TEXT REFERENCES pets(pet_id), score REAL CHECK(score BETWEEN 0 AND 1), eligible INTEGER, teacher_score REAL, PRIMARY KEY(user_id,pet_id));'
                         'CREATE INDEX profile_split ON profiles(split);')
        con.executemany('INSERT INTO profiles VALUES (?,?,?,?)',[(p['user_id'],json.dumps({k:p[k] for k in USER_KEYS}),p['scenario'],p['split']) for p in people])
        con.executemany('INSERT INTO pets VALUES (?,?)',[(p['id'],json.dumps(p,ensure_ascii=False)) for p in PETS])
        con.executemany('INSERT INTO ratings VALUES (?,?,?,?,?)',[(x['user_id'],x['pet_id'],x['score'],x['eligible'],x['teacher_score']) for x in rows])
    tmp.replace(out/'synthetic.sqlite3')
    counts=Counter(split.values())
    manifest=dict(dataset_id=f'pawthfinder-synthetic-v2-seed{seed}-n{users}',source='synthetic_generated_dataset',
        generator_seed=seed,split_seed=42,users=users,pet_types=len(PETS),rows=len(rows),
        users_by_split=dict(counts),rows_by_split={k:v*len(PETS) for k,v in counts.items()},
        eligible_rows_by_split=dict(eligible),eligible_rows_by_pet=dict(per_pet),scenario_counts=dict(scenario_counts),
        catalog_hash=CATALOG_HASH,noise_std=.025,
        warning='全部为程序合成数据；非真实调查、非兽医标签、非领养结果。模拟测试仅说明对生成机制的拟合。',
        feature_columns=USER_KEYS,never_use_as_features=['score','teacher_score','eligible','split','source','user_id','scenario'])
    manifest['sha256']={name:hashlib.sha256((out/name).read_bytes()).hexdigest() for name in ['profiles.csv','ratings.csv','train.csv','validation.csv','test.csv','pets_snapshot.json','synthetic.sqlite3']}
    (out/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({k:manifest[k] for k in ['dataset_id','users','rows','users_by_split','eligible_rows_by_split']},ensure_ascii=False,indent=2))
    return manifest
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--users',type=int,default=6000);p.add_argument('--seed',type=int,default=2026)
    p.add_argument('--out',default=str(BASE/'data/synthetic_v2'));a=p.parse_args();generate(a.out,a.users,a.seed)
