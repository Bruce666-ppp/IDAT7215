# PawthFinder 系统设计

## 目标与范围
面向尚未选择宠物的人，以生活方式和照护能力为输入，输出候选类型排序。推荐对象是宠物类别，不是具体出售/领养个体。未实现图片识别、疾病诊断、交易或自动领养。

## 处理流程
1. 浏览器采集 11 个用户字段，向 POST /api/recommend 提交 JSON。
2. 后端拒绝缺失、多余、越界、非有限数值及不正确的布尔类型。
3. 将 15 项问卷特征与每种宠物的 9 个属性拼接成 24 维向量。
4. 模型推理得到每对用户—宠物的适配分值。
5. 规则独立检查许可、替代照护、空间、时间、预算、期限、噪声、过敏及档案要求的环境管理和活饵准备。
6. 只有通过全部硬规则的候选参与模型分数排序；输出所有合格项，并按分数由高到低显示。
7. 返回规则理由和照护提醒，保存运行记录。反馈必须关联同一浏览器会话的既有推荐。

## 深度学习设计
网络为 24 → 64 → 32 → 16 → 1。三个隐藏层使用 ReLU，推理对输出使用 Sigmoid。
优化器：Adam，学习率 0.002，weight_decay=1e-5，batch_size=256。
损失：BCEWithLogitsLoss，训练直接输入 logits，避免先 sigmoid 再 BCE；支持本项目 0–1 软目标。
https://docs.pytorch.org/docs/stable/generated/torch.nn.BCEWithLogitsLoss.html

按用户分组随机划分 train/validation/test，随机种子 42。每轮随机打乱训练对，验证损失连续 12 轮不改善则早停，保存验证集最优权重。测试集仅用于最终报告，不参与选择权重。CPU 训练，不需要大型 GPU。

特征采用固定范围缩放，无需用测试集统计量。用户字段顺序由 core.USER_KEYS 定义。宠物字段由 core.PET_KEYS 定义。模型包含 SCHEMA 与知识库 SHA-256 校验，避免改档案后无提示地继续用旧模型。修改特征顺序必须递增 SCHEMA。

## 规则与解释
硬规则负责教学筛选。规则基线按活动匹配 30%、护理 20%、经验 15%、时间余量 15%、预算余量 10%、照护连续性 10% 加权。连续离家时长和每月外宿晚数影响照护连续性。
“有动物相关过敏则排除有毛宠物”仅用于演示，无法排除羽毛、饲料等其他过敏源；不对医学安全作承诺。

规则生成的 reasons 描述输入与阈值的关系，不代表神经网络内部真实决定依据。深度模型解释若需研究，应另增消融实验或归因方法并明确其限制。

## 数据与评估
每个模拟用户与全部 9 位伙伴配对。奶龙在所有配对中的标签为 0。
报告整体 MSE、过滤后 NDCG@3、可排序用户数、规则基线以及训练/验证损失曲线。整体 MSE 可能受大量被排除零分样本影响，不能单独代表排序质量。

真实 CSV 例子可由以下代码生成一行格式示例（不足以训练）：
```python
import csv,json
from core import DEFAULT
with open('data/ratings_example.csv','w',encoding='utf-8',newline='') as f:
    w=csv.writer(f)
    w.writerow(['user_id','profile','pet_id','score'])
    w.writerow(['anonymous_001',json.dumps(DEFAULT),'cat',0.8])
```
同一 user_id 必须对应相同资料；同一用户—宠物不得重复。若用户资料随时间变化，需要先定义观察窗口并按真实用户隔离划分。不能将不同会话冒充独立用户来提高样本量。

建议采集：匿名用户编号、问卷、候选曝光、明确评分、专家适配判断、后续照护结果与时间。获取知情同意。禁止将未点击/未评分直接当作“不适合”。应比较规则、简单统计基线和 MLP，并进行按用户隔离、时间外推验证、不同人群误差分析。只有真实评估后才能讨论深度学习是否有增益。

## HTTP 接口
| 方法 | 路径 | 作用 |
|---|---|---|
| GET | / | 网页 |
| GET | /api/info | 模型状态、默认值、宠物知识库 |
| POST | /api/recommend | 接收完整问卷，返回 run_id、mode、推荐/排除项 |
| POST | /api/feedback | 接收 run_id、pet_id、rating(1–5) |

请求示例：
```json
{"space":30,"time":2,"budget":1000,"activity":3,"noise":3,"grooming":3,"experience":0,"years":15,"allergy":false,"pet_allowed":true,"backup":true}
```
响应中的 `mode` 为 `synthetic_rule_distillation`、`real_user_labels` 或 `rules_only`。`real_user_labels` 只表示使用了导入 CSV，不保证 CSV 的真实性或专业质量。

## 数据库
runs：id 主键、owner 会话标识、created_at、profile JSON、result JSON。
feedback：(run_id,pet_id) 联合主键、rating、created_at。重复评分更新该条记录。
使用 SQL 参数绑定与外键、JSON 内容类型限制、Strict SameSite 会话、HttpOnly cookie、请求大小限制和 CSP；前端通过 textContent 构建数据内容，避免 HTML 注入。

## 已知限制与扩展
- 演示知识库未由动物行为/兽医专家审定，无地区成本校准；必须先替换为可追溯数据。
- 类别过粗，无法覆盖个体性格、年龄、疾病、品种、群居关系以及住所具体设施。
- 模型规模小，结构化小数据通常不保证深度学习胜过规则或树模型。
- 网页训练在独立进程运行，验证权重、指标与数据指纹后切换模型。服务重启会恢复最近成功启用的模型。
- 仅本机开发服务；没有跨设备身份或生产服务管理。
- 反馈采样与会话身份有限，不能直接用作严格实验数据。

## V2 扩展设计

前端增加五个功能视图：智能推荐、宠物百科、对比清单、推荐历史、模型实验室。保留原问卷与模型接口。

| 方法 | 新接口 | 功能 |
|---|---|---|
| GET | /api/history | 本会话最近 20 次记录概要 |
| GET | /api/history/<run_id> | 隔离会话读取单条问卷、结果与评分 |
| POST | /api/scenario | before / after 两份完整问卷，无写入的重新推理与差异比较 |
| GET | /api/model | 模型模式、架构、参数量与配套训练指标 |

历史接口按 owner 和 run_id 查询，不接受客户端指定其他 owner。条件模拟执行与正式推荐相同的输入校验及硬规则。差异表只对前后均合格的宠物计算分值差；资格变化单独标注，无资格时不显示假分数。

百科筛选仅操作目录，不暗示满足个人照护条件。对比清单限制为 3 类，持久化前后检查已知宠物 ID；本地保存不包含问卷。报告在浏览器内生成 Markdown Blob，无上传行为。

模型曲线直接绘制 metrics.json 的 train_bce / val_bce。仅在模型可用且来源模式匹配时显示指标；人工替换模型时需同步替换配套指标。默认训练脚本会生成两者。

会话密钥保存在数据库同目录的 .session_secret，源码包排除密钥、数据库、缓存与用户报告。该机制适用于本机原型，不等于账号认证或跨设备身份。

## V3 自生成数据训练

加入 generate_dataset.py 和 data/synthetic_v2 数据目录；固定用户级划分，包含 6000 位模拟用户、54000 对与独立 SQLite 数据镜像。
train.py 默认将导入数据按 synthetic 解释；CSV 有 split 时优先使用，禁止用户跨集合、问卷跨集合重复及重复配对。自生成数据明确标记 synthetic_generated_dataset。
训练输入为 24 维。teacher_score、eligible 和标签等字段仅用于监督或评估。权重绑定 CSV 哈希，评估文件绑定权重哈希。
本次不引入真实用户数据。合成目标增加活动—护理交互、预算余量和少量噪声，属于模拟教师函数，性能不能外推到真实用户。
