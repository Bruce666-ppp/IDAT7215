import torch
import hashlib
import json
from core import BASE,PETS,SCHEMA,CATALOG_HASH,features,assess,rule_score,validate
from network import PetMLP
class Recommender:
    def __init__(self,model_path=None):
        path=BASE/'artifacts/model.pt' if model_path is None else model_path
        self.model_hash=None; self.dataset_sha256=None; self.model=None; self.source='rules_only'; self.status='未加载模型：当前使用专家规则评分'
        self.version=None; self.metrics=None; self.dataset_name='项目随附合成数据'
        if path.exists():
            try:
                checkpoint=torch.load(path,map_location='cpu',weights_only=True)
                if checkpoint['schema']!=SCHEMA or checkpoint['catalog_hash']!=CATALOG_HASH:
                    raise ValueError('特征或宠物档案已修改，请重新训练')
                self.model=PetMLP(); self.model.load_state_dict(checkpoint['state_dict']); self.model.eval()
                self.model_hash=hashlib.sha256(path.read_bytes()).hexdigest(); self.dataset_sha256=checkpoint.get('dataset_sha256'); self.source=checkpoint['source']; self.status='已加载深度学习模型'
                self.version=self.model_hash[:12]
            except Exception as e:
                self.model=None; self.status=f'模型加载失败，使用规则评分：{type(e).__name__}'
            if self.model is not None:
                try:
                    candidate = json.loads(path.with_name('metrics.json').read_text(encoding='utf-8'))
                    if (candidate.get('source') == self.source and candidate.get('model_sha256') == self.model_hash and
                            candidate.get('dataset_sha256') == self.dataset_sha256):
                        self.metrics = candidate
                except (ValueError, OSError, AttributeError):
                    pass
    def recommend(self,raw):
        u=validate(raw)
        if self.model is not None:
            with torch.no_grad(): scores=self.model(torch.tensor([features(u,p) for p in PETS],dtype=torch.float32)).sigmoid().tolist()
        else: scores=[rule_score(u,p) for p in PETS]
        accepted=[]; excluded=[]
        for p,score in zip(PETS,scores):
            report=assess(u,p)
            item={'id':p['id'],'name':p['name'],'emoji':p['emoji'],**report}
            if report['eligible']:
                item.update(score=round(score*100,1),rule_score=round(rule_score(u,p)*100,1))
                accepted.append(item)
            else: excluded.append(item)
        accepted.sort(key=lambda p:(-p['score'],p['id']))
        return {'mode':self.source,'status':self.status,'model_version':self.version,'recommendations':accepted,
                'excluded':excluded,'notice':'分数为相对适配评分，不是成功概率。解释来自规则，不是神经网络因果解释。',
                'message':'暂无满足当前演示规则的宠物，请先改善照护条件。' if not accepted else '请结合实际个体、照护要求与专业意见进一步了解。'}
