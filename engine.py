import hashlib
import json
import logging
from pathlib import Path

import torch

from core import BASE,REAL_PETS,SCHEMA,CATALOG_HASH,ProfileError,features,assess,rule_score,validate
from decision import Status,decision
from network import PetMLP

logger = logging.getLogger(__name__)


class Recommender:
    def __init__(self,model_path=None):
        path=BASE/'artifacts/model.pt' if model_path is None else Path(model_path)
        self.model_hash=None; self.dataset_sha256=None; self.model=None; self.source='rules_only'; self.status='未加载模型：当前使用专家规则评分'
        self.version=None; self.metrics=None; self.dataset_name='项目随附合成数据'
        self.load_failed=False
        if path.exists():
            try:
                checkpoint=torch.load(path,map_location='cpu',weights_only=True)
                if checkpoint['schema']!=SCHEMA or checkpoint['catalog_hash']!=CATALOG_HASH:
                    raise ValueError('特征或宠物档案已修改，请重新训练')
                self.model=PetMLP(); self.model.load_state_dict(checkpoint['state_dict']); self.model.eval()
                self.model_hash=hashlib.sha256(path.read_bytes()).hexdigest(); self.dataset_sha256=checkpoint.get('dataset_sha256'); self.source=checkpoint['source']; self.status='已加载深度学习模型'
                self.version=self.model_hash[:12]
            except Exception as e:
                self.model=None; self.load_failed=True; self.status=f'模型加载失败：{type(e).__name__}'
                logger.exception('Could not load the PawthFinder model')
            if self.model is not None:
                try:
                    candidate = json.loads(path.with_name('metrics.json').read_text(encoding='utf-8'))
                    if (candidate.get('source') == self.source and candidate.get('model_sha256') == self.model_hash and
                            candidate.get('dataset_sha256') == self.dataset_sha256):
                        self.metrics = candidate
                except (ValueError, OSError, AttributeError):
                    pass
    def recommend(self,raw,*,require_model=False):
        model={'mode':self.source,'status':self.status,'model_version':self.version}
        try:
            u=validate(raw)
        except ProfileError as error:
            status=Status.OUT_OF_DOMAIN if error.ranges else Status.INVALID_INPUT
            return decision(status,str(error),ranges=error.ranges,model=model,
                            inference='SKIPPED_OUT_OF_DOMAIN' if error.ranges else 'SKIPPED_INVALID_INPUT')
        if self.load_failed or (require_model and self.model is None):
            return decision(Status.SYSTEM_ERROR,'暂时无法加载推荐模型，请稍后重试。',
                            profile=u,inference='FAILED',model=model)

        candidates=[]; excluded=[]
        for p in REAL_PETS:
            report=assess(u,p)
            item={'id':p['id'],'name':p['name'],'emoji':p['emoji'],**report}
            if report['eligible']:
                candidates.append((p,item))
            else:
                excluded.append(item)
        trace={'profile':u,'excluded':excluded,'eligible_count':len(candidates),'model':model}
        if not candidates:
            return decision(Status.NO_ELIGIBLE_PET,f'当前条件下，{len(excluded)} 种真实宠物档案均触发了硬性筛选规则。',
                            inference='SKIPPED_NO_ELIGIBLE',**trace)

        baseline=[rule_score(u,pet,assessment=item) for pet,item in candidates]
        scores=baseline
        inference='RULES_ONLY'
        if self.model is not None:
            try:
                with torch.inference_mode():
                    inputs=torch.tensor([features(u,pet) for pet,_ in candidates],dtype=torch.float32)
                    logits=self.model(inputs)
                    if logits.shape!=(len(candidates),) or not torch.isfinite(logits).all():
                        raise ValueError('The model returned invalid scores')
                    scores=logits.sigmoid().tolist()
                inference='EXECUTED'
            except Exception:
                logger.exception('PawthFinder inference failed')
                return decision(Status.SYSTEM_ERROR,'模型计算遇到问题，请稍后重新提交。',inference='FAILED',**trace)
        accepted=[]
        for (_,item),score,rule in zip(candidates,scores,baseline):
            item.update(score=round(score*100,1),rule_score=round(rule*100,1))
            accepted.append(item)
        accepted.sort(key=lambda p:(-p['score'],p['id']))
        reason=f'{len(accepted)} 种真实宠物通过档案筛选，按'+('模型适配评分' if inference=='EXECUTED' else '专家规则备用评分')+'排序。'
        return decision(Status.REAL_PET_RECOMMENDATION,reason,recommendations=accepted,inference=inference,**trace)
