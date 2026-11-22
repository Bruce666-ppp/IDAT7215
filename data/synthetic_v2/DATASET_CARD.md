# PawthFinder 合成训练数据集 v2

**全部数据均由程序生成，不包含真实个人信息、调查记录或经过兽医审核的标签。**
该数据集用于开发、训练和演示自训练宠物推荐模型。测试成绩只能反映模型对生成机制的拟合，不能解释为真实领养成功率或推荐准确率。

## 规模和划分

- 6,000 位不同的模拟用户；9 位伙伴；每位用户对所有 9 位伙伴都有标签，共 54,000 对。
- 训练：4,200 位用户 / 37,800 对。
- 验证：900 位用户 / 8,100 对。
- 测试：900 位用户 / 8,100 对。
- 先按用户划分，再生成配对文件；同一用户的全部配对只属于一个集合。
- 生成种子 2026，划分种子 42；不跨集合复用相同问卷。随机种子和样本数不变时 CSV 可复现。

## 文件

| 文件 | 内容 |
|---|---|
| profiles.csv | 6,000 行，用户字段平铺，方便查看和分析 |
| ratings.csv | 54,000 行，完整训练入口，含固定 split |
| train.csv | 37,800 行训练子集 |
| validation.csv | 8,100 行验证子集 |
| test.csv | 8,100 行测试子集 |
| synthetic.sqlite3 | 同一数据的 SQLite 关系表镜像，与网页反馈数据库分离 |
| pets_snapshot.json | 生成时的 9 位伙伴档案快照 |
| manifest.json | 种子、计数、分布、知识库哈希和数据文件 SHA-256 |
| DATASET_CARD.md | 本说明 |

`ratings.csv` 是直接给 train.py 的文件；三个拆分文件方便独立研究，不应单独作为该脚本的完整数据输入。

## 用户字段

| 字段 | 类型/单位 | 含义 |
|---|---|---|
| user_id | 字符串 | syn_ 前缀模拟 ID；不作为模型特征 |
| space | 数值，㎡ | 可用照护空间 |
| time | 数值，小时/天 | 每天可用于照护的时间 |
| budget | 数值，港币/月 | 每月常规照护预算 |
| activity | 整数，1–5 | 喜好的活动强度 |
| noise | 整数，1–5 | 可接受噪声等级 |
| grooming | 整数，1–5 | 愿意承担的护理强度 |
| experience | 整数，0–2 | 饲养经验等级 |
| years | 数值，年 | 可承诺照护期限 |
| allergy | 布尔 | 模拟的动物相关过敏标记；不是医疗诊断 |
| pet_allowed | 布尔 | 居所是否允许饲养 |
| backup | 布尔 | 是否安排替代照护 |
| alone_hours | 整数，小时 | 工作日连续离家时长 |
| away_nights | 整数，晚/月 | 每月通常在外过夜的晚数 |
| habitat_control | 布尔 | 是否愿意管理专门的饲养环境 |
| live_insects | 布尔 | 是否接受准备活饵昆虫 |
| scenario | 字符串 | 生成场景，供审计，不作为特征 |
| split | 字符串 | train / validation / test，不能作为特征 |

CSV 中平铺布尔值为 True/False；ratings.csv 的 profile 是合法 JSON 对象，布尔值为 true/false。编码统一为 UTF-8。

## 配对字段

| 字段 | 含义 |
|---|---|
| user_id | 关联 profiles.csv 的模拟用户 |
| profile | 完整 11 字段问卷 JSON，训练脚本会严格校验 |
| pet_id | 关联宠物档案 ID |
| score | 0–1 合成适配标签，监督学习目标 |
| split | 已确定的用户级集合 |
| source | 固定为 synthetic_generated_dataset |
| eligible | 专家规则检查是否通过，0/1，仅供审计 |
| teacher_score | 加噪前的合成标签，仅供审计 |

**不得把 score、teacher_score、eligible、split、source、user_id 或 scenario 当成输入特征。**
当前模型使用问卷 15 维与宠物属性 9 维，共 24 维输入。

## 标签怎样生成

1. 用现有硬规则检查许可、替代照护、时间、空间、预算、期限、噪声和过敏标记。不合格配对标签为 0。
2. 对合格配对计算规则基线 B。
3. 定义活动协调度 H = max(0, 1 - ((user.activity - pet.activity) / 4)^2)。
4. 定义护理满足度 C = min(1, user.grooming / pet.grooming)。
5. 定义预算余量 R = min(1, max(0, (user.budget / pet.budget - 1) / 1.5))。
6. 无噪声目标 T = 0.70B + 0.15HC + 0.15R。
7. 加上标准差 0.025 的高斯噪声，裁剪到 [0.01, 0.99]，得到合格配对 score。

这些公式是开发者设定的假设，不是从真实行为中发现的规律。噪声也仅为模拟，不代表测量过的真实满意度差异。
场景覆盖准备充分、一般条件、时间有限、预算有限、活动偏好、安静偏好、无许可和过敏标记。场景抽样权重不是人口分布。

## 重新生成并自行训练

在 PawthFinder 项目目录执行：

```bash
python generate_dataset.py --users 6000 --seed 2026
python train.py --csv data/synthetic_v2/ratings.csv --data-source synthetic --epochs 100
python app.py
```

生成会覆盖同一输出目录的合成数据。修改用户数或种子会产生新数据。训练脚本识别 ratings.csv 的 split，保持发布的固定划分；验证集选择最佳模型，测试集只用于最后报告。训练结束后重启 app.py 加载新权重。
模型文件 metadata 保存 CSV SHA-256，metrics.json 保存模型 SHA-256，页面只展示与已加载模型哈希匹配的指标。

## SQLite 后端查询示例

数据库与实际网站运行库 `data/pawthfinder.sqlite3` 分离；不要将模拟评价灌入真实用户历史。

```sql
SELECT p.user_id, p.profile_json, r.pet_id, r.score
FROM profiles p JOIN ratings r ON p.user_id = r.user_id
WHERE p.split = 'train';
```

## 评估与限制

同时报告全体 MSE、合格候选 MSE、过滤后 NDCG@3、有效排序用户数和规则基线。大量零分会影响整体 MSE，所以不能只看一个指标。
这是人工生成机制；即使模型的 NDCG 很高，也不能证明对真实用户有效。宠物属性阈值仍是未验证的教学参数，没有个体性格、品种、年龄、健康、地域价格等真实资料。用于实际推荐前应替换知识库并用独立真实数据验证。

## V2 档案说明
8 类真实宠物包括猫、狗、兔子、仓鼠、刺猬、豹纹守宫、虎皮鹦鹉和观赏鱼。奶龙为虚构角色，全部配对标签为 0，并由规则从真实推荐中排除。
手绘插画为生成的展示素材，不用于训练；模型输入仍是结构化属性。
