"""Train a pair-scoring MLP. Synthetic results measure rule imitation ONLY."""
import argparse
import hashlib
from pathlib import Path
import copy
import csv
import json
import random
from collections import Counter
from datetime import datetime, timezone
import numpy as np
import torch
from torch import nn
from core import BASE,PETS,SCHEMA,CATALOG_HASH,FLAGS,OPTIONAL_PROFILE_FIELDS,USER_KEYS,features,validate,rule_score,assess
from network import PetMLP

def synthetic(n,seed):
    r=random.Random(seed); rows=[]
    for i in range(n):
        u=validate(dict(space=r.uniform(2,80),time=r.uniform(.2,5),budget=r.uniform(100,2500),
            activity=r.randint(1,5),noise=r.randint(1,5),grooming=r.randint(1,5),
            experience=r.randint(0,2),years=r.randint(1,25),allergy=r.random()<.15,
            pet_allowed=r.random()<.95,backup=r.random()<.9,alone_hours=r.randint(2,14),
            away_nights=r.randrange(8),habitat_control=r.random()<.4,live_insects=r.random()<.3))
        for p in PETS:
            rows.append((str(i),u,p,rule_score(u,p)))
    return rows

def read_profile(row):
    if 'profile' in row:
        return validate(json.loads(row['profile']))
    profile = {}
    for key in USER_KEYS:
        value = (row.get(key) or '').strip().lower()
        if not value and key in OPTIONAL_PROFILE_FIELDS:
            continue
        if key in FLAGS:
            if value not in ('true', 'false', '1', '0'):
                raise ValueError(f'{key} 需要 true/false 或 1/0')
            profile[key] = value in ('true', '1')
        else:
            profile[key] = float(value)
    return validate(profile)


def read_real(path, *, max_rows=None):
    rows=[]; known={p['id']:p for p in PETS}; profiles={}; pairs=set()
    with open(path,encoding='utf-8-sig',newline='') as f:
        reader = csv.DictReader(f, strict=True)
        fields = reader.fieldnames or []
        required = {'user_id', 'pet_id', 'score'}
        if not required.issubset(fields) or len(set(fields)) != len(fields):
            raise ValueError('CSV 需要唯一的列名，至少包含 user_id、pet_id、score 和问卷资料')
        if 'profile' not in fields and not (set(USER_KEYS) - OPTIONAL_PROFILE_FIELDS).issubset(fields):
            raise ValueError('CSV 缺少 profile 或必填问卷列，请参考评分样表')
        for line,r in enumerate(reader,2):
            try:
                if max_rows is not None and len(rows) >= max_rows:
                    raise ValueError(f'最多接收 {max_rows:,} 条评分')
                if None in r or any(value is None for value in r.values()):
                    raise ValueError('列数与表头不一致')
                uid=r['user_id'].strip(); u=read_profile(r); p=known[r['pet_id'].strip()]
                score=float(r['score']); fingerprint=json.dumps(u,sort_keys=True)
                if not uid or len(uid)>128 or not np.isfinite(score) or not 0<=score<=1:
                    raise ValueError('user_id 长度须为 1–128，score 须在 0–1 之间')
                if p.get('fictional') and score != 0:
                    raise ValueError('奶龙是展示角色，如提供其评分，score 须为 0')
                if uid in profiles and profiles[uid]!=fingerprint: raise ValueError('profile changed within user')
                if (uid,p['id']) in pairs: raise ValueError('duplicate user-pet pair')
                profiles[uid]=fingerprint; pairs.add((uid,p['id']))
                rows.append((uid,u,p,score))
            except (KeyError,ValueError,TypeError) as e:
                raise ValueError(f'CSV 第 {line} 行无效：{e}') from e
    return rows

def split_csv(path,rows,seed):
    """Respect published user-level splits; never feed metadata/targets as features."""
    assignment={};sources=set()
    with open(path,encoding='utf-8-sig',newline='') as f:
        reader=csv.DictReader(f); has_split='split' in (reader.fieldnames or [])
        for row in reader:
            if row.get('source'): sources.add(row['source'].strip()[:100])
            if has_split:
                uid=row['user_id'].strip();part=row['split']
                if part not in ('train','validation','test'): raise ValueError('split 必须为 train/validation/test')
                if uid in assignment and assignment[uid]!=part: raise ValueError('同一用户跨集合，存在数据泄漏')
                assignment[uid]=part
    ids=sorted({r[0] for r in rows})
    if not has_split:
        random.Random(seed).shuffle(ids);n=len(ids)
        assignment={uid:'train' if i<int(.7*n) else 'validation' if i<int(.85*n) else 'test' for i,uid in enumerate(ids)}
    groups={part:[row for row in rows if assignment[row[0]]==part] for part in ['train','validation','test']}
    if any(not group for group in groups.values()): raise ValueError('训练、验证、测试集合都必须非空；请传入 ratings.csv 全量文件')
    # Identical profile copies across users also inflate held-out results.
    fingerprints={}
    for uid,u,p,y in rows:
        key=json.dumps(u,sort_keys=True)
        if key in fingerprints and fingerprints[key]!=assignment[uid]: raise ValueError('相同用户资料出现在不同集合，请先去重')
        fingerprints[key]=assignment[uid]
    return groups,sources,has_split


def prepare_csv(path, seed=42, *, max_rows=None):
    rows = read_real(path, max_rows=max_rows)
    if len({row[0] for row in rows}) < 20:
        raise ValueError('至少需要 20 位不同用户用于按用户划分')
    if not any(not pet.get('fictional') for _, _, pet, _ in rows):
        raise ValueError('需要至少一种真实宠物的评分')
    return rows, *split_csv(path, rows, seed)

def tensors(rows):
    return (torch.tensor([features(u,p) for _,u,p,_ in rows],dtype=torch.float32),
            torch.tensor([y for *_,y in rows],dtype=torch.float32))

def ndcg(rows,scores):
    groups={}
    for row,score in zip(rows,scores):
        uid,u,p,y=row
        if assess(u,p)['eligible']: groups.setdefault(uid,[]).append((y,float(score)))
    values=[]
    for pairs in groups.values():
        if len(pairs)<2: continue
        def dcg(seq): return sum((2**v-1)/np.log2(i+2) for i,v in enumerate(seq[:3]))
        ideal=dcg(sorted((y for y,_ in pairs),reverse=True))
        if ideal>0: values.append(dcg([y for y,_ in sorted(pairs,key=lambda a:a[1],reverse=True)])/ideal)
    return {'ndcg_at_3':float(np.mean(values)) if values else None,'rankable_users':len(values)}

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--csv',type=str,help='评分 CSV；不提供时使用内置模拟数据')
    parser.add_argument('--data-source',choices=['synthetic','real','upload'],default='synthetic',help='CSV 来源：内置合成、真实或本地上传')
    parser.add_argument('--users',type=int,default=1800)
    parser.add_argument('--epochs',type=int,default=80)
    parser.add_argument('--seed',type=int,default=42)
    parser.add_argument('--out',type=str,default=str(BASE/'artifacts'))
    a=parser.parse_args()
    if a.epochs<1: parser.error('epochs must be positive')
    torch.manual_seed(a.seed); np.random.seed(a.seed); torch.set_num_threads(2)
    sources = set()
    if a.csv:
        rows,groups,sources,explicit_split=prepare_csv(a.csv,a.seed)
    else:
        rows=synthetic(a.users,a.seed)
    ids=sorted({r[0] for r in rows})
    if len(ids)<20: parser.error('至少需要 20 位不同用户用于按用户划分')
    if a.csv:
        if a.data_source=='real' and any(x.startswith('synthetic') for x in sources):
            parser.error('合成数据不能标注为真实用户数据')
        tr,va,te=groups['train'],groups['validation'],groups['test']
    else:
        random.Random(a.seed).shuffle(ids);n=len(ids)
        ti=set(ids[:int(.7*n)]);vi=set(ids[int(.7*n):int(.85*n)])
        tr=[r for r in rows if r[0] in ti];va=[r for r in rows if r[0] in vi];te=[r for r in rows if r[0] not in ti|vi]
        explicit_split=False
    train_ids={r[0] for r in tr};val_ids={r[0] for r in va};test_ids={r[0] for r in te};n=len(ids)
    source=({'real':'real_user_labels','synthetic':'synthetic_generated_dataset','upload':'uploaded_user_data'}[a.data_source]
            if a.csv else 'synthetic_rule_distillation')
    dataset_sha=hashlib.sha256(Path(a.csv).read_bytes()).hexdigest() if a.csv else None
    x,y=tensors(tr); vx,vy=tensors(va); tx,ty=tensors(te)
    model=PetMLP(); opt=torch.optim.Adam(model.parameters(),lr=.002,weight_decay=1e-5)
    lossfn=nn.BCEWithLogitsLoss(); best=float('inf'); best_epoch=0; state=None; history=[]; stale=0
    for epoch in range(a.epochs):
        model.train(); losses=[]
        for ix in torch.randperm(len(x)).split(256):
            opt.zero_grad(); loss=lossfn(model(x[ix]),y[ix]); loss.backward(); opt.step(); losses.append(loss.item())
        model.eval()
        with torch.no_grad(): val=lossfn(model(vx),vy).item()
        history.append({'epoch':epoch+1,'train_bce':float(np.mean(losses)),'val_bce':val})
        if val<best-1e-5: best=val; best_epoch=epoch+1; state=copy.deepcopy(model.state_dict()); stale=0
        else: stale+=1
        print(f'epoch={epoch+1} val_bce={val:.4f}',flush=True)
        if stale>=12: break
    model.load_state_dict(state); model.eval()
    with torch.no_grad(): pred=model(tx).sigmoid().numpy()
    baseline=np.array([rule_score(u,p) for _,u,p,_ in te])
    labels=ty.numpy()
    eligible_indices = [i for i, (_, u, p, _) in enumerate(te) if assess(u, p)['eligible']]
    scatter_indices = random.Random(a.seed).sample(eligible_indices, min(140, len(eligible_indices)))
    per_pet = [Counter(p['id'] for _, _, p, _ in split) for split in (tr, va, te)]
    metrics={'source':source,'dataset_sha256':dataset_sha,'explicit_user_split':explicit_split,
       'trained_at':datetime.now(timezone.utc).isoformat(),'input_sources':sorted(sources),
       'dataset_rows':len(rows),'best_epoch':best_epoch,
       'per_pet_rows':[{'id':p['id'],'name':p['display_name'],'rows':sum(c[p['id']] for c in per_pet)} for p in PETS],
       'prediction_sample':[{'label':round(float(labels[i]),4),'prediction':round(float(pred[i]),4)} for i in scatter_indices],
       'train_rows':len(tr),'val_rows':len(va),
       'disclaimer':'评估反映本次数据及其标签，不能代表真实照护结果。',
       'seed':a.seed,'train_users':len(train_ids),'val_users':len(val_ids),'test_users':len(test_ids),
       'test_rows':len(te),'model_mse':float(np.mean((pred-labels)**2)),
       'rule_mse':float(np.mean((baseline-labels)**2)),
       'eligible_test_rows':len(eligible_indices),
       'eligible_model_mse':float(np.mean((pred[eligible_indices]-labels[eligible_indices])**2)) if eligible_indices else None,
       'model_ranking':ndcg(te,pred),'rule_ranking':ndcg(te,baseline),'history':history}
    out=__import__('pathlib').Path(a.out); out.mkdir(parents=True,exist_ok=True)
    # Write temporary checkpoint first; readers never observe a partially written model.
    tmp=out/'model.tmp'
    torch.save({'state_dict':state,'schema':SCHEMA,'catalog_hash':CATALOG_HASH,'source':metrics['source'],'dataset_sha256':dataset_sha},tmp)
    tmp.replace(out/'model.pt')
    metrics['model_sha256']=hashlib.sha256((out/'model.pt').read_bytes()).hexdigest()
    (out/'metrics.json').write_text(json.dumps(metrics,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({k:v for k,v in metrics.items() if k not in ('history','prediction_sample')},ensure_ascii=False,indent=2))
if __name__=='__main__': main()
