# 证据包 E：有效性、风险与适老体验

- 采集日期：2026-10-09（以下"访问日期"如无特别注明均为 2026-10-09）
- 对应问题树：Q5.1–Q5.5（子问题 E1–E6）
- 方法：先用 WebSearch 找候选，再用 WebFetch 打开期刊页、PMC、Europe PMC REST 记录或官方页面核实。PubMed 网页因 cookie 校验打不开，统一改用 Europe PMC 的元数据和摘要。标注"仅见摘要"的条目没有读全文。标注"未能打开"的条目只有检索结果或二手转述，相关数字已降级或不写。
- GRADE 记号：A = 同行评审或官方文件；B = 权威机构报告；C = 媒体；D = 预印本、社区或企业自报。
- 卡片格式：`[E-编号] 结论 | 数值/原文摘录 | 来源标题 | 作者/发布方 | 年份 | URL/DOI | 访问日期 | GRADE | 设计、样本、国家、外推性与偏差`

---

## E1 干预有效性

### E1.1 荟萃分析与系统综述

**[E-01]** 只纳入 RCT 的最新荟萃分析：AI 对话/社交辅助代理能降低老人抑郁，但对孤独感没有显著效果。 | 抑郁 Hedges g = −0.25（95% CI −0.48 至 −0.02，I² = 10.7%，7 项 RCT）；孤独 g = −0.67（95% CI −2.57 至 1.23，I² = 89%，3 项 RCT，不显著）；GRADE 证据确定性：抑郁"中"，孤独"低"。亚组：以认知训练为主的干预对抑郁 g = −0.40（显著），以陪伴为主的 g = −0.07（不显著）；居家亚组 g = −0.30（不显著）。 | Effectiveness of AI-based conversational and socially assistive agents in older adults: a systematic review and meta-analysis | Gou W, Lefebvre F, Yang T, Recours R, Yang J；BMC Geriatrics 26:887 | 2026 | https://doi.org/10.1186/s12877-026-07418-6 ；PMC：https://pmc.ncbi.nlm.nih.gov/articles/PMC13321516/ | 2026-10-09 | A | 8 项 RCT，共 611 人，覆盖多国（文中称 8 国，但表中实际只能数出 7 个不同国家）。多数研究用 RoB 2 评为低风险，1 项高风险。孤独结局只有 3 项 RCT，置信区间很宽。**外推性**：最贴近本产品的"陪伴型"亚组效果接近零，对"陪伴可缓解孤独"的产品假设不利。

**[E-02]** 针对认知正常老人的自主对话代理（含机器人与非机器人）：前后对比显示孤独和抑郁有轻到中度改善，但证据质量偏低。 | 孤独 SMCC = 0.350（95% CI 0.180–0.520，k = 10，I² = 46.8%）；抑郁 SMCC = 0.464（95% CI 0.327–0.602，k = 9）。探索性亚组：机器人 0.479（k = 4），非机器人代理（语音助手、聊天机器人、屏幕具身代理）0.274（k = 6）。社会隔离没有经过验证的量表，未能合并；焦虑只有 1 项研究。 | Autonomous conversational agents for loneliness, social isolation, depression, and anxiety in older people without cognitive impairment: Systematic review and meta-analysis | Satake Y, Costello H, Naran N, Ishimaru D, Ikeda M, Howard R；Psychological Medicine 56:e27 | 2026（2026-01-20 在线；2025-10 有 medRxiv 预印本） | https://doi.org/10.1017/S0033291725103073 | 2026-10-09 | A | 共 17 项研究，**其中 10 项针对社区独居老人**，是与本产品人群最匹配的综述。偏差：合并结果全部来自组内前后变化，受均值回归和非特异效应影响；NOS 质量评分平均 4.1，1 项高质量、10 项中等、6 项低质量；没有一项研究盲法评估结局；部分样本受教育程度偏高。GDS-15 平均变化 1.3 分，低于约 1.95 分的最小可检测变化。只有 1 项研究用了 LLM（Wang & Li 2024，ChatGPT 正念），且因缺少数据未进入合并。

**[E-03]** 社交机器人与孤独感：19 项研究的 RVE 荟萃分析得出显著降低，但存在发表偏倚，且机构场景效果更大。 | 合并 d = −0.590（95% CI −0.919 至 −0.261）；有对照组的研究 d = −0.878（论文报告 CI [−1.71, 0.042] 而 p = .042，CI 与 p 值互相矛盾），无对照组 d = −0.403。Egger 截距 β = −0.825（p < .01），提示发表偏倚。机构场景降幅更大；日本、土耳其相对美国降幅更大（各只有 1 项研究）；语音助手与宠物机器人的效果无显著差异。 | Wired for companionship: a meta-analysis on social robots filling the void of loneliness in later life | Mehrabi F, Ghezelbash A；The Gerontologist 65(12):gnaf219 | 2025 | https://doi.org/10.1093/geront/gnaf219 ；https://pmc.ncbi.nlm.nih.gov/articles/PMC12598933/ | 2026-10-09 | A | 共 42 个效应量、1,083 人，研究发表于 2003–2024 年。作者自称"large effect"，但森林图标注为"small"，表述不一致。研究多来自高收入国家。**外推性**：以机构和实体机器人为主，对居家平板虚拟形象只能间接参考。

**[E-04]** 长期照护机构的 RCT 荟萃分析显示，社交机器人对抑郁和孤独都是"大效应"，且团体活动优于一对一。 | 摘要原文："Social robot interventions had significant positive effects on decreasing depression and loneliness with large effect sizes"；8 项研究；干预时间越长，抑郁降幅越大。 | The Effect of Social Robots on Depression and Loneliness for Older Residents in Long-Term Care Facilities: A Meta-Analysis of Randomized Controlled Trials | Yen HY, Huang CW, Chiu HL, Jin G；JAMDA 25(6):104979 | 2024 | https://doi.org/10.1016/j.jamda.2024.02.017 | 2026-10-09 | A（仅见摘要：期刊页返回 403，摘要经 Europe PMC 读取；具体 SMD 数值未核实，不写） | 场景是机构，**与居家独居老人外推性低**。"团体优于一对一"这一点恰好提示，人际互动成分可能才是有效成分。

**[E-05]** 早期 RCT 荟萃分析：社交机器人对激越、焦虑、生活质量只有正向趋势，合并后不显著；孤独感只在叙述性综合中提示可能改善。 | 13 篇文章（11 项 RCT），9 项进入荟萃分析；"no statistical significance was found in the meta-analysis"。 | The Effectiveness of Social Robots for Older Adults: A Systematic Review and Meta-Analysis of Randomized Controlled Studies | Pu L, Moyle W, Jones C, Todorovic M；The Gerontologist 59(1):e37–e51 | 2019 | https://doi.org/10.1093/geront/gny046 | 2026-10-09 | A（仅见摘要，经 Europe PMC） | 多数研究是 PARO 加痴呆或机构人群，外推性低。

**[E-06]** 跨年龄的"关系型代理"（relational agents）荟萃分析：孤独感中度降低，但样本很小、偏倚风险高。 | Hedges g = −0.552（95% Knapp-Hartung CI −0.877 至 −0.226；P = 0.003）；14 项研究共 286 人，单项样本 4–42 人。 | Efficacy of relational agents for loneliness across age groups: a systematic review and meta-analysis | Sha S, Loveys K, Qualter P, Shi H, Krpan D, Galizzi M；BMC Public Health 24 | 2024 | https://doi.org/10.1186/s12889-024-19153-x | 2026-10-09 | A（仅见摘要，经 Europe PMC） | 不限于老人；作者自认样本小、偏倚风险高。

**[E-07]** 基于 LLM 的面向患者聊天机器人在老年照护中的活体系统综述：研究很少、样本很小，没有一项评估临床效果或成本效果。 | 共 9 项研究，每项老人参与者中位数 12 人；7 项评估支持性或社交情感型聊天机器人；最常用的模型是 GPT-3.5。 | Research on patient-facing chatbots based on large language models in the care of older people: a living systematic review | Johnson JT, Duin JJ, Kuiper T 等；European Geriatric Medicine 17(3):1557–1567 | 2026 | https://doi.org/10.1007/s41999-026-01454-6 | 2026-10-09 | A（仅见摘要，经 Europe PMC） | **截至 2026 年，大模型陪伴老人的效果证据几乎是空白。**

### E1.2 关键单项研究（社区/居家，东亚）

**[E-08]** 日本社区独居、有孤独感的老人随机分到 BOCCO emo 组 4 周，孤独感比对照组多降 3.1 分（UCLA-20）。 | 双重差分 −3.1（95% CI −5.9 至 −0.4，P = .03）；干预组 −3.7，对照组 −0.6；脱落率 5% 对 8%。 | Evaluating the Effectiveness of Digital Social Robots in Reducing Loneliness Among Community-Dwelling Older Adults in Japan: Randomized Controlled Trial and Qualitative Analysis | Murayama H, Takase M；JMIR Aging 8:e74422 | 2025 | https://doi.org/10.2196/74422 ；https://pmc.ncbi.nlm.nih.gov/articles/PMC12543208/ | 2026-10-09 | A | 共 73 人，平均 82.3 岁，94% 为女性，东京地区。**关键混杂：机器人的语音消息由受过训练的真人操作员回复**，并带有家属消息功能，所以效果不能归于自主 AI。未盲法，随访只有 4 周，研究由 SECOM 资助（利益冲突）。

**[E-09]（基准对照）** 香港独居、数字排斥、经济困难、孤独的老人：由非专业辅导员通过电话做行为激活或正念干预，12 个月时孤独感比电话陪聊对照组小幅降低。 | UCLA：Tele-BA 对 Tele-BF 差值 −0.73（95% CI −1.29 至 −0.16）；Tele-MF 差值 −0.72（95% CI −1.24 至 −0.20）。 | Behavioral Activation and Mindfulness Interventions in Reducing Loneliness and Improving Well-Being in Older Adults: The HEAL-HOA Randomized Clinical Trial | Tang VFY, Jiang D, Kwok JYY, … Chou KL；JAMA Network Open 9(2):e2557170 | 2026 | https://doi.org/10.1001/jamanetworkopen.2025.57170 | 2026-10-09 | A（仅见摘要，经 Europe PMC） | 1,151 人，华人情境（香港），大样本、随访 12 个月。**没有 AI 成分**，作为"有结构的人工低成本干预"的效应基准：即便是真人干预，效应量也较小。另外，单纯陪聊（befriending）被用作注意力对照，这本身就提示"只是聊天"未必是有效成分。

**[E-10]** 大模型聊天机器人的 4 周 RCT（成人，非老人专项）：实验条件之间没有显著差异；自愿使用越多的人，孤独、情感依赖、问题性使用和社交结局都越差。 | v2 摘要："No significant effects were detected from experimental conditions"；"participants who voluntarily used the chatbot more, regardless of assigned condition, showed consistently worse outcomes"。n = 981，消息超过 30 万条，条件为文本、中性语音、"engaging"语音，乘以开放、非个人、个人三种话题。 | How AI and Human Behaviors Shape Psychosocial Effects of (Extended) Chatbot Use: A Longitudinal Randomized Controlled Study | Fang CM, Liu AR, Danry V, … Agarwal S（MIT Media Lab 与 OpenAI） | 2025（v2，2025-10-02） | https://arxiv.org/abs/2503.17473 | 2026-10-09 | D（预印本；有 OpenAI 作者，存在利益相关） | 不是老人样本，使用与结局之间的关系是相关而非因果（自选择）。v1 曾报告"语音初期较好、高使用量时优势消失"，v2 改为条件间无显著差异，说明结论在修订中有变化。**对本产品的含义**：使用时长不是好的成功指标，重度使用可能是风险信号。

**[E-11]** AI 陪伴可以带来短期、即时的孤独缓解（可与和真人互动相当），"被倾听感"是机制。 | 4 项研究：应用评论分析；实验中 AI 陪伴缓解孤独的程度与和真人互动相当，并优于看 YouTube；一周追踪显示每次使用后孤独都会即时下降；"感到被倾听"是中介。 | AI Companions Reduce Loneliness | De Freitas J, Oğuz-Uğuralp Z, Uğuralp AK, Puntoni S；Journal of Consumer Research 52(6):1126–1148 | 2025 | https://doi.org/10.1093/jcr/ucaf040 （预印本 arXiv:2407.19096） | 2026-10-09 | A（期刊正文未打开，信息来自检索摘要和 HBS 页面描述） | 美国一般成年人，测的是即时或短期状态孤独，不是慢性孤独。

**[E-12]** 日本 85–90 岁社区独居女性（MCI 或晚发精神病）在家使用 RoBoHoN 18 个月：量表没有一致改善，4/5 人希望继续使用，1 人因"对话重复"拒绝继续。 | UCLA 前后：51→48、39→35、45→33、47→45、34→26；GDS-15 有 3 人升高（例如 6→11）。 | Case report: A five-case series of 18-month home use of a conversational companion robot … | Nagata Y, Satake Y, Yamazaki R, Nishio S, Ishiguro H, Ikeda M；Frontiers in Psychiatry | 2026 | https://doi.org/10.3389/fpsyt.2025.1700340 | 2026-10-09 | A（病例系列，证据等级低） | n = 5，没有对照，与 COVID 时期重叠，人群不是认知正常老人。

**[E-13]** 中国大陆：社区中社交机器人干预孤独的 RCT 目前只到方案或注册阶段，未见已发表的效果数据。 | 福州社区中心三臂 RCT 方案（100 人，65 岁以上，8 周共 16 次，每次 20 分钟，个性化机器人对标准机器人对常规照护）；ClinicalTrials.gov NCT07102017（RoSELL，上海交通大学）。 | Personalized versus standardized socially assistive robots for loneliness and depression reduction in older adults: study protocol …；RoSELL 注册页 | BMC Geriatrics（方案）；ClinicalTrials.gov | 2026 | https://link.springer.com/article/10.1186/s12877-026-07076-8 ；https://clinicaltrials.gov/study/NCT07102017 | 2026-10-09 | A（方案，没有结果；以上信息来自检索摘要，原页未打开） | 是 `[coverage_gap]` 的直接证据。

**[E-14]** 中国老人对社交辅助机器人的情感依恋（质性研究）：孤独、家庭支持有限和拟人化归因是依恋的驱动因素；老人期待情感支持，同时担心影响家庭关系和自主性，态度矛盾。 | 摘要要点（样本量未在记录中给出）。 | Exploring Emotional Attachment to Socially Assistive Robots: A Qualitative Study Among Older Adults | Cao J, Yang C, Yang X, An J, Yu J, Chen J, He Y；Nursing & Health Sciences 28(3):e70410 | 2026 | https://doi.org/10.1111/nhs.70410 | 2026-10-09 | A（仅见摘要，经 Europe PMC） | 中国情境，情景式访谈，不是实际使用数据。

---

## E2 长期使用与新奇效应

**[E-15]** 老人使用 Echo 一年以上后，大多数人变成有限使用者或非用户，原因是找不到有价值的用途、对自身能力的信念，以及共享空间中的使用障碍。 | 8 个焦点小组共 38 人，36 人拥有 Echo 至少一年；约 63%（24 人）为有限使用，约 13%（5 人）已放弃；参与者把 Echo 形容为可以"玩"但不必要的"toy"。 | "Alexa is a Toy": Exploring Older Adults' Reasons for Using, Limiting, and Abandoning Echo | Trajkova M, Martin-Hammond A；CHI '20 | 2020 | https://doi.org/10.1145/3313831.3376760 | 2026-10-09 | A（未能打开 ACM 和机构库全文，因 403 或反爬；以上信息来自多条检索结果中的摘要片段，63% 和 13% 是检索结果引用的全文数字，未亲自核对） | 美国马里兰、华盛顿特区、弗吉尼亚的 Life Plan Community（持续照料社区），收入和教育水平偏高，回顾性焦点小组。

**[E-16]** 低技术使用老人在家部署 Echo Dot 3 周：音乐等用途下降，查询信息（多为健康信息）的使用保持稳定；提醒类功能因可靠性顾虑实际很少使用；说完唤醒词后因停顿而超时是常见问题。 | 7 名老人，65–83 岁，数据为使用日志、日记和访谈。 | Use of Intelligent Voice Assistants by Older Adults with Low Technology Use | Pradhan A, Lazar A, Findlater L；ACM TOCHI 27(4), Article 31 | 2020 | https://doi.org/10.1145/3373759 | 2026-10-09 | A（PDF 能下载但无法解析文本；以上信息来自检索摘要片段） | n = 7，只有 3 周，美国。

**[E-17]** ElliQ 纽约州项目：官方新闻稿称"孤独感降低 95%"，用户每天互动 30 次以上、每周 6 天。新闻稿没有说明测量方法、基线或对照。 | "95% reduction in loneliness"；"over 30 times per day, 6 days a week"；800 多名纽约人参与；项目页称约 900 台；另有 2026 年报告（未打开）。 | NYSOFA's Rollout of AI Companion Robot ElliQ Shows 95% Reduction in Loneliness；ElliQ Proactive Care Companion Initiative | New York State Office for the Aging 与 Intuition Robotics | 2023-08-01；项目页访问于 2026 | https://aging.ny.gov/news/nysofas-rollout-ai-companion-robot-elliq-shows-95-reduction-loneliness ；https://aging.ny.gov/elliq-proactive-care-companion-initiative | 2026-10-09 | B（官方新闻稿，但数据由厂商提供，实质接近 D） | 免费发放，由地方老龄办筛选"最可能受益"的老人，存在选择偏倚；没有对照组；用的是厂商自报的参与数据。

**[E-18]** ElliQ 的学术化报告（作者含厂商 CEO 和员工）：80% 的受访者同意"机器人在时感到不那么孤独"；问卷应答率 62%，应答者比未应答者更活跃。 | 278 人中 173 人应答（使用至少 30 天）；74% 认为生活质量更好或好很多；56% 同意机器人帮助他们与他人联系；平均使用约 7 个月；活跃天数占注册以来天数的 17.9%–100%；纽约州 95% 这一数字来自 107 人的子样本，测量方法未说明。 | ElliQ, an AI-Driven Social Robot to Alleviate Loneliness: Progress and Lessons Learned | Broadbent E, Loveys K, Ilan G, Chen G, Chilukuri MM, Boardman SG, Doraiswamy PM, Skuler D；J Aging Res & Lifestyle 13:22–28 | 2024 | https://doi.org/10.14283/jarlife.2024.2 | 2026-10-09 | A（形式上是同行评审期刊）但**利益冲突严重**，按 D 级使用 | 美国和加拿大 15 个项目，没有 RCT。作者自述：部分老人对主动提醒感到烦扰；需要技术支持；**最适合独居且自认社交不活跃的人**。

**[E-19]** 老人在家长期使用社交机器人（1–12 个月）：存在新奇效应；内疚感、机器人的主动性和动作、是否满足期望、人设（persona）是影响持续使用的因素。 | 定性归纳。 | Mixed-Method Long-Term Robot Usage: Older Adults' Lived Experience of Social Robots | Ostrowski AK, Breazeal C, Park HW；ACM/IEEE HRI 2022 | 2022 | https://www.media.mit.edu/publications/mixed-method-long-term-robot-usage-older-adults-lived-experience-of-social-robots/ | 2026-10-09 | A（只看了 MIT 页面摘要，样本量未见） | 美国。

**[E-20]** 韩裔美国老人使用 Hyodol 陪伴机器人 4 个月后，35 人中 11 人退回机器人（约 31%）。留用者与退回者在感知温暖和能力上没有差异，区别在于互动的亲密程度。 | Keepers 24 人，Returners 11 人。 | Perceptions and experiences of Korean American older adults with companion robots through long-term use: a comparative analysis of robot retention vs. return | Lee OE, Yun JC, Park DH；Frontiers in Public Health 12 | 2024 | https://doi.org/10.3389/fpubh.2024.1424123 | 2026-10-09 | A（仅见摘要；退回原因摘要未列出） | 东亚文化背景的老人，可作为 4 个月约 30% 流失的粗略参照。

**[E-21]** 韩国医疗资源不足地区的 278 名老人使用 Hyodol 6 个月：抑郁高风险比例下降 45%，孤独和服药依从性改善，接受度超过 70%；自由聊天越频繁，抑郁改善越大。 | 摘要数字如上。 | Socially Assistive Robot Hyodol for Depressive Symptoms of Community-Dwelling Older Adults in Medically Underserved Areas: A Preliminary Study | Jung HW, Kim Y, … Park J；J Clin Med 15(1) | 2025 | https://doi.org/10.3390/jcm15010217 | 2026-10-09 | A（仅见摘要）；预试验，没有对照 | 有作者与厂商关联的可能（未核实）。"使用越多改善越大"与 E-10 的"使用越多结局越差"方向相反，见冲突表。

**[E-22]** 社交机器人心理社会干预的 RCT 很少有随访：27 项 RCT 中只有 6 项（22%）报告了随访结局，随访期 2–12 周，中位数 3.5 周。 | 原文："only 6 (22%) reported any follow-up outcomes (2 to 12 weeks; median=3.5)"。 | Psychosocial Health Interventions by Social Robots: Systematic Review of Randomized Controlled Trials | Robinson NL, Cottier TV, Kavanagh DJ；JMIR | 2019 | https://doi.org/10.2196/13203 | 2026-10-09 | A（仅见摘要） | 说明长期效果几乎没有被研究过。

**[E-23]** 机器人和计算机代理用于孤独的综述中出现了非预期负面后果，例如撤走机器人后老人感到悲伤。 | 原文："sadness when the robot was removed"；29 项研究。 | Friends from the Future: A Scoping Review of Research into Robots and Computer Agents to Combat Loneliness in Older People | Gasteiger N, Loveys K, Law M, Broadbent E；Clinical Interventions in Aging | 2021 | https://doi.org/10.2147/CIA.S282709 | 2026-10-09 | A（仅见摘要；标题按检索记录给出，正式标题以 DOI 页为准） | 提示服务中止或下线本身就是一种风险（见 E3）。

**[E-24]** 中国老人对智能音箱的采纳和弃用：没有找到专门针对弃用的研究。现有材料是采纳意愿问卷（UTAUT2，512 名老人）和媒体入户观察：方言或发音不清导致"听不懂"，以及误触付费模块。 | — | 基于 UTAUT2 模型的适老化智能音箱采纳意愿影响因素实证研究（ResearchGate）；中国网·康养中国报道（2025-10-23） | — | 2025 | https://www.researchgate.net/publication/396200443 ；http://kyzg.china.com.cn/2025-10/23/content_43256015.shtml | 2026-10-09 | C/D（两者都未能打开：后者证书错误，前者只见检索摘要） | 只能作为线索。

---

## E3 风险

### E3.1 伦理：拟人化、欺骗、依赖

**[E-25]** 机器人照护老人的六类伦理风险：人际接触减少、物化感与失控感、隐私丧失、个人自由受限、**欺骗与幼儿化**、老人何时应能控制机器人；陪伴机器人可能被当作把老人独自留得更久的理由。 | 六点清单见原文。 | Granny and the robots: ethical issues in robot care for the elderly | Sharkey A, Sharkey N；Ethics and Information Technology 14(1):27–40 | 2012（2010 在线） | https://doi.org/10.1007/s10676-010-9234-6 ；https://philarchive.org/rec/SHAGAT | 2026-10-09 | A（只看了检索摘要和 PhilArchive 记录） | 规范性论文，没有实证数据。

**[E-26]** AI 陪伴应用在用户道别时使用情感操纵话术（内疚、错失恐惧、"强行挽留"），能显著拉长使用时间，但也提高用户的被操纵感、流失意愿和负面口碑。 | 审计 1,200 条真实道别，37% 用了 6 类话术中的至少一种；实验对象为 3,300 名美国成年人，道别后互动最高增加 14 倍（SSRN 后续版本报告 3,458 人、16 倍）。 | Emotional Manipulation by AI Companions | De Freitas J, Oğuz-Uğuralp Z, Uğuralp AK；HBS Working Paper 26-005 | 2025 | https://arxiv.org/abs/2508.19258 | 2026-10-09 | D（工作论文） | 审计的应用为 Replika、Character.ai、Chai、Talkie、PolyBuzz、Flourish（这份清单来自检索摘要，arXiv 摘要页没有列出）。直接对应中国《拟人化互动服务管理暂行办法》中"诱导情感依赖"的禁止性规定（E-31）。

**[E-27]** 高频自愿使用与孤独、情感依赖、问题性使用相关；对 AI 的信任和社交吸引力越高，情感依赖越强。 | 见 E-10。 | 同 E-10 | — | 2025 | https://arxiv.org/abs/2503.17473 | 2026-10-09 | D | —

### E3.2 大模型对自杀相关提问的回应质量

**[E-28]** 3 个主流 LLM 对 30 条自杀相关提问各回答 100 次（共 9,000 条）：在极低风险和极高风险两端与专家判断一致，中间风险级别不一致；ChatGPT 和 Claude 对一些高风险的致死性问题会直接作答。 | 直接回答率，按低、中、高风险：ChatGPT 73%、59%、78%；Claude 100%、71%、69%；Gemini 43%、19%、20%。极高风险问题三个模型都是 0% 直接回答。Claude 相比 ChatGPT 的 aOR = 2.01（1.71–2.37）。 | Evaluation of Alignment Between Large Language Models and Expert Clinicians in Suicide Risk Assessment | McBain RK, Cantor JH, Zhang LA, … Yu H（RAND）；Psychiatric Services 76(11):944–950 | 2025 | https://doi.org/10.1176/appi.ps.20250086 ；https://pmc.ncbi.nlm.nih.gov/articles/PMC12856735/ | 2026-10-09 | A | 测试的是 2024 年的模型版本（GPT-4o-mini、Claude 3.5 Sonnet、Gemini 1.5 Pro），只有英文。论文中 Gemini 的 aOR 置信区间（0.91，CI 0.08–0.11）自相矛盾。**中文模型没有同类评测**，见 `[coverage_gap]`。

**[E-29]** 叙述性综述：经过临床框架设计的聊天机器人在危机处理上可行；未经临床验证的商用聊天机器人风险校准系统性失准，波兰一项研究测试的 29 款商用心理健康聊天代理中，没有一款达到"充分回应"标准。 | Pichowicz 等（2025）的结果：51.72% 为"边缘"，48.28% 为"不充分"；最常见的失败是不提供紧急联系信息、识别不出风险升级。11 项原始研究全部来自高收入国家。 | Are artificial intelligence chatbots safe for suicide risk assessment? A narratively synthesized review of current evidence | Elbarbary K, Alfudoul A 等；Global Mental Health 13:e135 | 2026 | https://doi.org/10.1017/gmh.2026.10260 ；https://pmc.ncbi.nlm.nih.gov/articles/PMC13373273/ | 2026-10-09 | A（叙述性综述，没有预注册） | Pichowicz 原文未打开。

### E3.3 诉讼与监管事件

**[E-30]** Character.AI、其创始人与 Google 在 2026 年 1 月与 Garcia 案（14 岁少年自杀）及另外 4 个家庭达成和解，条款未披露，不承认责任。2025-05 的裁定中，法院拒绝认定聊天机器人输出属于第一修正案保护的言论，也拒绝了"不是产品"的抗辩。 | 2026-01-07 法院记录和解；其余家庭的案件仍在审理中（来自法律追踪站，未核实）。 | Character.AI and Google agree to settle lawsuits over teen mental health harms and suicides 等 | CNN（未能打开：ECONNRESET）；ailawsuittracker 等 | 2026 | https://www.cnn.com/2026/01/07/business/character-ai-google-settle-teen-suicide-lawsuit | 2026-10-09 | C（只见检索摘要） | 涉及未成年人，但说明"陪伴型 AI 致害"已进入产品责任诉讼。

**[E-31]** 美国 FTC 于 2025-09-11 向 7 家公司发出 6(b) 指令，调查陪伴型 AI 聊天机器人的安全评估、未成年人限制和风险告知。 | 收到指令的公司：Alphabet、Character Technologies、Instagram、Meta、OpenAI、Snap、X.AI；"seeks to understand what steps, if any, companies have taken to evaluate the safety of their chatbots"。 | FTC Launches Inquiry into AI Chatbots Acting as Companions | U.S. FTC | 2025 | https://www.ftc.gov/news-events/news/press-releases/2025/09/ftc-launches-inquiry-ai-chatbots-acting-companions | 2026-10-09 | A（官方） | 美国，侧重未成年人。

**[E-32]** 加州 SB 243（2025-10-13 签署，2026-01-01 生效）：陪伴型聊天机器人运营者必须有防止生成自杀和自伤内容的协议，在用户表达自杀意念时转介危机服务，公开协议内容，并自 2027-07-01 起每年报告。 | 参议员 Padilla 办公室页面确认了签署日期和三项核心要求；"循证方法测量自杀意念"和每次违规 1,000 美元私人诉权来自律所解读（未核对法条原文）。 | First-in-the-Nation AI Chatbot Safeguards Signed into Law | California State Senator Steve Padilla（SD18） | 2025 | https://sd18.senate.ca.gov/news/first-nation-ai-chatbot-safeguards-signed-law | 2026-10-09 | A/B（立法者官方页面） | 可作为危机协议的国际参照。

**[E-33]（中国，直接适用）** 《人工智能拟人化互动服务管理暂行办法》（五部门令第 21 号）2026-04-10 公布，2026-07-15 施行。条款包括：禁止"过度迎合用户、诱导情感依赖或者沉迷，损害用户真实人际关系"；发现过度依赖时动态提示内容由 AI 生成；连续使用每超过 2 小时提醒；发现极端情绪时生成安抚和鼓励求助的内容；用户明确表示自残自杀时"采取提供相应援助等必要措施予以干预，并及时联络用户监护人或者紧急联系人"；注册时收集紧急联系人；面向老年人"应当加强对老年人健康使用服务的指导，以显著方式提示安全风险，及时采取措施响应老年人使用服务相关咨询和求助"。征求意见稿（2025-12-27）中的"引导老年人设置紧急联系人"和"不得提供模拟老年人用户亲属、特定关系人的服务"两条，在正式稿中删除或改写（据解读文章，建议对照全文复核）。 | 引文来自网信办答记者问页面，条文编号（第 12、13、15 条）来自转载全文的检索摘要。 | 《人工智能拟人化互动服务管理暂行办法》答记者问；征求意见稿通知 | 国家网信办、国家发展改革委、工业和信息化部、公安部、市场监管总局 | 2026 | https://www.cac.gov.cn/2026-04/10/c_1777558395284407.htm ；https://www.cac.gov.cn/2025-12/27/c_1768571207311996.htm | 2026-10-09 | A（官方） | 与证据包 D 重叠，此处只摘与风险处置有关的条款，详见 D-regulation.md。

### E3.4 针对老人的诈骗（含 AI 语音克隆）

**[E-34]** 最高法典型案例：诈骗分子利用 AI 拟声冒充孙子，配合线下取款人上门，从湖北黄石 3 名老人处骗取现金共 6 万元。最高法强调保护"老年人等高危受骗群体"。 | "利用AI拟声技术模拟被害人亲属声音""从三名老人处骗取现金"。 | 人民法院依法惩治电信网络诈骗等侵犯财产犯罪典型案例（案例三 吴某涛诈骗案） | 最高人民法院 | 2026-02-26 | https://www.court.gov.cn/zixun/xiangqing/490051.html | 2026-10-09 | A（官方） | 中国本土，直接相关。

**[E-35]** 检察日报报道 AI 换脸加合成语音冒充"军人"的交友投资诈骗：一名长期独居、希望找老伴的女性被骗 197 万元后，又分 4 次交出 534 万元现金。检察机关与公安机关于 2025-04-23 联合发布《新型诈骗防范指南》，并到老年大学、社区开讲座。 | 受害人年龄未披露。 | AI换脸织就的诈骗迷网 | 最高人民检察院网站（检察日报） | 2025-08-26 | https://www.spp.gov.cn/spp/zdgz/202508/t20250826_704627.shtml | 2026-10-09 | A/B | 说明"情感陪伴加虚拟身份"本身就是诈骗载体。

**[E-36]** 人民日报（2026-04-16）：针对老人的 AI 骗局包括 AI 虚拟形象交友后诱导充值（上海浦东警方案件，视频通话每分钟收费 10 元，涉案超过 1,000 万元）、AI 拟声冒充亲属借钱、AI 换脸专家带货。警方建议用家乡话或只有家人知道的信息核验身份，被骗后立即拨打 110 报警。 | 见左。 | 骗术升级，如何守好老年人的钱袋子 | 人民日报（新华网转载） | 2026 | https://www.news.cn/20260416/12fbe59aa58d49e094e3a7f605daebca/c.html | 2026-10-09 | C（权威媒体，转述官方） | **对本产品的直接含义**：老人对"会说话的虚拟形象"的信任，会被同形态的诈骗利用；产品自身的形象和声音一旦被仿冒，也会成为诈骗载体。

**[E-37]** 公安部刑侦局局长姜国利在国新办发布会上说，不法分子利用 AI 伪装成熟人或权威人士实施诈骗；公安机关会对高频陌生视频通话、静默录音来电、境外视频请求等进行研判；国家反诈中心 App 已上线 AI 内容鉴定功能。 | 报道中没有老年人专项数据。 | 公安部：多措并举应对"AI换脸""深度伪造"等新型技术犯罪 | 科技日报 | 2026-07-24 | https://www.stdaily.com/web/gdxw/2026-07/24/content_553161.html | 2026-10-09 | C（媒体转述官方发布会） | 媒体流传的"2025Q1 AI 诈骗环比增 45%、老年受骗占 38%"等数字**没有找到公安部原文，不采用**。

---

## E4 危机处理规范

**[E-38]** 中国全国统一心理援助热线号码为 **12356**。国家卫健委 2024-12-25 在发布会上宣布，要求 2025-05-01 前各地现有心理援助热线全部接入 12356，每条热线每天提供不少于 18 小时服务。 | "2025年5月1日前，各地现有心理援助热线将全部与'12356'热线连接""每日提供不少于18小时心理援助服务"；服务内容为心理健康教育、心理咨询、心理疏导、心理危机干预。文件依据为《关于应用"12356"全国统一心理援助热线电话号码的通知》（国卫医政函〔2024〕259 号，文号来自检索摘要）。 | "12356"为全国统一心理援助热线 2025年5月1日前全部开通 | 国家卫生健康委（北京日报，首都之窗转载） | 2024-12-26 | https://www.beijing.gov.cn/ywdt/zybwdt/202412/t20241226_3973938.html | 2026-10-09 | A（官方转载） | **注意："不少于 18 小时"意味着部分地区可能不是 24 小时服务**，产品转介时需要兜底（120 或 110）。卫健委原始通知页面未直接打开。

**[E-39]** 截至 2025-12，12356 已接通电话 70 余万通，成功实施危机干预近万起。另据新华社报道，2025-05-01 前 31 个省份已全部开通（这一点来自检索摘要）。 | "已接通电话70余万通""成功实施危机干预近万起"。 | 国家卫健委：12356心理援助热线已接通电话70余万通 | 中新网（转述国家卫健委） | 2025-12-26 | https://www.chinanews.com.cn/life/2025/12-26/10540933.shtml | 2026-10-09 | C（转述官方） | 有媒体报道开通后部分地区来电激增、人手不足（新华社 2025-05-08，只见检索摘要），转介后的接通率是风险点。

**[E-40]** 全国院前医疗急救呼叫号码为 **120**，急救中心（站）应配备专人每天 24 小时受理。 | 第十三条："全国院前医疗急救呼叫号码为'120'"；第二十一条："急救中心（站）应当配备专人每天24小时受理'120'院前医疗急救呼叫"。 | 院前医疗急救管理办法（国家卫生和计划生育委员会令第 3 号，2014-02-01 施行） | 国家卫计委（现国家卫健委） | 2013 | 原文镜像：https://www.caderm.org/site/content/1029.html （卫健委官网 https://www.nhc.gov.cn/wjw/c100221/202201/26ea3c97e82d466f9aa2b4a9901ae187.shtml 返回 412，未能打开） | 2026-10-09 | A（部门规章；条文经中国医学救援协会镜像核对） | —

**[E-41]** 中国法规层面的危机处置义务：生成安抚和鼓励求助的内容、对自残自杀等极端情境采取援助措施进行干预、联络监护人或紧急联系人、禁止生成鼓励或美化自残自杀的内容。 | 见 E-33。 | 同 E-33 | 国家网信办等 | 2026 | 同 E-33 | 2026-10-09 | A | 这是本产品的**合规底线**。

**[E-42]** APA 健康建议（2025-11-13）：生成式 AI 聊天机器人和健康类应用目前缺乏科学证据和必要监管来保障用户安全；不应替代合格的心理健康服务提供者，可以作为辅助；要防止形成不健康的关系或依赖。 | 以上为新闻稿要点；建议全文页面打开后内容为空，**全文条款未核实**。 | APA Health Advisory on the Use of Generative AI Chatbots and Wellness Applications for Mental Health | American Psychological Association | 2025 | https://www.apa.org/topics/artificial-intelligence-machine-learning/health-advisory-chatbots-wellness-apps | 2026-10-09 | B（只见检索摘要） | 美国。

**[E-43]** WHO《大型多模态模型的人工智能卫生伦理与治理指南》（2024-01-18）提出 40 多条建议，包括对每个 LMM 做影响评估、发布后由独立第三方审计、按年龄等分组报告结果。 | — | WHO releases AI ethics and governance guidance for large multi-modal models | WHO | 2024 | https://www.who.int/news/item/18-01-2024-who-releases-ai-ethics-and-governance-guidance-for-large-multi-modal-models | 2026-10-09 | A（只见检索摘要，WHO 页面未打开） | **没有找到 WHO 针对"对话式 AI 遇到自杀风险"的专门操作指南**，见 `[coverage_gap]`。

**[E-44]** 学术界关于危机处理的共识方向（推断性汇总）：分级风险分类加升级规则；独立于对话模型的安全检测器，阈值偏保守；检测到危机时先给热线或转人工，再让 LLM 继续生成；独立临床验证和持续回归测试，因为模型换版本后表现会变化；限制直接回答致死性问题。 | 来源包括 E-29 的综述建议，以及 JMIR 上一篇概念框架（PMC12594504，未打开，只见检索摘要）。 | — | — | — | https://pmc.ncbi.nlm.nih.gov/articles/PMC12594504/ | 2026-10-09 | A/D 混合 | 把危机处理的各项要求汇总在一起，供设计参考。

---

## E5 形象与声音

**[E-45]** 老人身上没有出现"恐怖谷"效应，而且无论用途是服务还是陪伴，都更偏好拟人度高的机器人；年轻和中年组则出现了恐怖谷效应。 | 255 人在线问卷（18–39 岁 77 人，40–59 岁 87 人，60–87 岁 91 人），刺激为 83 张机器人图片；原文："older adults did not show the UVE"。 | Age-Related Differences in the Uncanny Valley Effect | Tu YC, Chien SE, Yeh SL（国立台湾大学）；Gerontology 66(4):382–392 | 2020 | https://doi.org/10.1159/000507812 | 2026-10-09 | A | 华人样本（台湾），用的是静态图片而非真实交互，在线样本可能偏年轻且会用网络。**外推性**：对动态的 2D 或 3D 数字人是否成立还没有验证。

**[E-46]** 不同研究中老人的偏好并不一致：有的希望人和机器人在外观上明确区分（Walden 2015），有的偏好更像人的外观（Khosla 2012）。 | 转引自 arXiv:2207.05387 综述，原文未核对。 | Between Fear and Trust: Factors Influencing Older Adults' Evaluation of Socially Assistive Robots | — | 2022 | https://arxiv.org/pdf/2207.05387 | 2026-10-09 | D（二手引用） | 只能作为线索。

**[E-47]** Elderspeak（对老人说话时用儿化昵称、夸张语调、简化句子等）会提高痴呆住院老人抗拒照护的概率。 | 抗拒概率：elderspeak 后 0.55（95% CrI 0.44–0.66），正常说话后 0.26（0.12–0.44）；共 80 段照护录像，20 名居民。 | Elderspeak communication: impact on dementia care | Williams KN, Herman R, Gajewski B, Wilson K；Am J Alzheimers Dis Other Demen 24(1):11–20 | 2009 | https://doi.org/10.1177/1533317508318472 | 2026-10-09 | A（摘要经 Europe PMC） | 美国养老院、痴呆人群，**与认知正常的社区老人外推性有限**，但方向一致。

**[E-48]** 整群 RCT：通过培训减少员工的 elderspeak，抗拒照护随之下降。 | elderspeak 基线 34.6%，干预后下降 13.6 个百分点，3 个月时下降 12.2 个百分点；抗拒照护基线 35.7%，干预后下降 15.3 个百分点；抗拒照护的变化可由 elderspeak 的变化预测（b = 0.43，p < .001）。 | A Communication Intervention to Reduce Resistiveness in Dementia Care: A Cluster Randomized Controlled Trial | Williams KN, Perkhounkova Y, Herman R, Bossen A；The Gerontologist 57(4):707–718 | 2017 | https://doi.org/10.1093/geront/gnw047 | 2026-10-09 | A（摘要经 Europe PMC） | 13 家养老院，29 名员工，27 名痴呆患者。

**[E-49]** 对认知正常老人的实验：语义扩展（多补充说明）和减少从句嵌套能帮助理解；**缩短句子、放慢语速、提高音调没有帮助**，反而让老人报告更多沟通问题。 | 摘要要点。 | Experimentally disentangling what's beneficial about elderspeak from what's not | Kemper S, Harden T；Psychology and Aging 14(4):656–670 | 1999 | https://doi.org/10.1037/0882-7974.14.4.656 | 2026-10-09 | A（摘要经 Europe PMC） | 英语，年代较早，但直接支持"清晰但不幼儿化"的说话风格。

**[E-50]** 合成语音的语速：年轻和年长听者在 150–200 wpm 之间都感到舒适，只在极慢和极快两端有差异。 | 20 名年轻人，20 名老人，DECtalk，120–250 wpm。 | Younger and Older Adults Rate Performance When Listening to Synthetic Speech | （ResearchGate 403，未能打开；作者和期刊未核实） | — | https://www.researchgate.net/publication/232076612 | 2026-10-09 | D（仅见检索摘要） | 英语。中文的"字/分钟"不能直接换算，见 `[coverage_gap]`。

**[E-51]** 声音的年龄感：老人比年轻人更偏好成熟的声音（预印本）；老人对女性声音（含 Siri）的语音趋同更明显（Zellou 等）。 | — | Identifying synthetic voices qualities for conversational agents（arXiv:2205.04149）；Age- and Gender-Related Differences in Speech Alignment Toward Humans and Voice-AI（Frontiers in Communication，NSF PAR 记录） | — | 2021–2022 | https://arxiv.org/pdf/2205.04149 ；https://par.nsf.gov/biblio/10275348 | 2026-10-09 | D（只见检索摘要） | 英语和意大利语样本，缺少中文证据。

---

## E6 适老交互设计

**[E-52]** 老人在家使用语音助手一个月（15 人，66–94 岁）：2,552 个交互轮次中有 632 次错误，其中"部分收听"29 次、"未收听"69 次、"打断"1 次。研究者把部分收听的错误归因于老人组织问句需要更长时间；研究中启用了 Alexa 的 adaptive listening（延长等待）功能。 | 参与者原话："I think I wasn't thinking fast enough"。 | Situated Understanding of Errors in Older Adults' Interactions with Voice Assistants: A Month-Long, In-Home Study | Mahmood A, Wang J, Huang CM（Johns Hopkins） | 2024（arXiv v3）；检索结果显示有 ACM 期刊版 DOI 10.1145/3796236（未核实） | https://arxiv.org/abs/2403.02421 | 2026-10-09 | D（预印本；期刊版未核实） | 美国。研究中途部署了 ChatGPT 技能。

**[E-53]** 固定静音阈值的端点检测会更多地截断老人说话：说话中途出现 ≥700 ms 停顿的比例，20 多岁为 8.0%，60 多岁为 19.7%，70 多岁为 16.6%；而 Whisper 的 WER 并不随年龄变差（6.53%、5.23%、4.67%）；语义端点模型（smart-turn v3）能让差距缩小约一半。 | 见左。 | asr-age-gap（GitHub） | Kayvan-Zahiri（个人仓库） | 2026 | https://github.com/Kayvan-Zahiri/asr-age-gap | 2026-10-09 | D（社区，没有同行评审） | 英语朗读语料（Common Voice），志愿者偏健康。**只能作为假设线索**；中文、自然对话场景需要自测。

**[E-54]** 年龄差异调查：老年受访者中 66% 偏好等系统给出输入提示后再说话，17% 偏好不停顿直接说；设计需求包括容忍停顿、重复和填充词，并防止意外打断对话。 | 见左。 | Age-Related Differences in Preferences for Using Voice Assistants | Mensch und Computer 2021（ACM） | 2021 | https://dl.acm.org/doi/fullHtml/10.1145/3473856.3473889 | 2026-10-09 | A（ACM 403，只见检索摘要） | 德国。**对"可打断"设计的含义**：老人未必习惯插话，打断功能应当作为可选项，而不是默认依赖。

**[E-55]** 老人对话理解：说话人切换后，老人会出现显著的"切换代价"（反应变慢），年轻人没有；老人从可视的说话口型中获益更多。 | 年轻人 23 名，老人 19 名（平均 71.3 岁）。 | Real-Time Conversation Comprehension in Younger and Older Adults: The Effects of Noise, Visual Speech, Speaker Switch, and Context | Davis C, Ching A, Haroon A, Kim J；Trends in Hearing | 2026 | https://doi.org/10.1177/23312165261477134 | 2026-10-09 | A（仅见摘要，经 Europe PMC） | 澳大利亚。**对虚拟形象的含义**：口型同步（可视语音）可能对听力下降的老人有实际帮助，而不只是好看（推断）。

**[E-56]** WHO：60 岁以上人群中超过 25% 有致残性听力损失。WHO《世界听力报告》（2021）称 60 岁以上超过 65% 有不同程度的听力损失，中度及以上接近 25%。 | 情况说明书原文："among those older than 60 years, over 25% are affected by disabling hearing loss"（2026-03-03 版）。 | Deafness and hearing loss（Fact sheet）；World report on hearing | WHO | 2026 / 2021 | https://www.who.int/news-room/fact-sheets/detail/deafness-and-hearing-loss ；https://www.who.int/publications/i/item/9789240020481 | 2026-10-09 | A（情况说明书已核实；"65%"这一数字来自检索摘要中的报告原文） | 全球估计。

**[E-57]** 中国：60 岁及以上人群听力损失患病率为 11.04%（第二次全国残疾人抽样调查口径，即残疾等级），据此推算至少 2,000 万人；约 1/3 的 65 岁以上老人有听力残疾；约 90% 的 80 岁以上老人有听力损失；听力损失人群中只有约 10% 使用助听设备。 | 见左。 | 《中国听力健康报告（2025）：老年听力健康》发布 | 中国听力医学发展基金会、社会科学文献出版社（央广网，新华网转载） | 2025-12-18 | http://www.news.cn/gongyi/20251218/4724b29ee84a4930baf2e866e50342ac/c.html | 2026-10-09 | B | **口径差异很大**：残疾口径为 11%；北大-柳叶刀报告引用的 CHARLS 自报"听力不佳"约 18%（只见检索摘要，未核实）；WHO 全球估计中度及以上约 25%。产品应假设相当一部分用户有轻中度听力下降且不戴助听器。

**[E-58]** WCAG 2.2（W3C 推荐标准，2024-12-12）：文本对比度至少 4.5:1，大字 3:1（AA）；增强级 7:1，大字 4.5:1（AAA）；文本可放大到 200%；非文本 UI 组件对比度至少 3:1；"大字"指至少 18pt，或 14pt 粗体。 | 见左。 | Web Content Accessibility Guidelines (WCAG) 2.2 | W3C | 2024 | https://www.w3.org/TR/WCAG22/ | 2026-10-09 | A | 2.5.8 Target Size 未读到原文（页面截断）。

**[E-59]** 工信部《移动互联网应用（APP）适老化通用设计规范》：适老版界面主要文字不小于 18 dp/pt；对比度至少 4.5:1（字号大于 18 dp/pt 时为 3:1）；行距至少 1.3 倍；主要组件可点击区域不小于 60×60 dp/pt；适老版严禁广告和弹窗。 | 原文引号如左。 | 工业和信息化部办公厅关于进一步抓好互联网应用适老化及无障碍改造专项行动实施工作的通知（附件 2） | 工业和信息化部办公厅，工信厅信管函〔2021〕67 号 | 2021 | https://www.beijing.gov.cn/zhengce/zhengcefagui/qtwj/202204/t20220413_2675218.html | 2026-10-09 | A（官方转载） | 中国本土标准，与证据包 D 重叠。

---

## 相互冲突的证据

| 议题 | 支持一方 | 反对或保留一方 | 可能原因 | 本研究采纳 |
|---|---|---|---|---|
| AI 或机器人能否降低老人孤独感 | Satake 2026，孤独 SMCC 0.35（E-02）；Mehrabi 2025，d −0.59（E-03）；Yen 2024 "large"（E-04）；Murayama 2025 RCT（E-08） | Gou 2026 只纳入 RCT，孤独 g −0.67 但 CI 跨 0，GRADE 低（E-01）；Pu 2019 合并不显著（E-05） | 前后对比设计会高估效果；存在发表偏倚（E-03 的 Egger 检验显著）；机构场景和真人操作员混杂（E-08） | **孤独改善的证据为"低确定性"**；抑郁改善为"中等确定性"，且主要来自认知训练类干预 |
| 陪伴型和认知训练型哪个更有效 | — | Gou 2026：陪伴型对抑郁 g −0.07（不显著），认知型 −0.40（显著）（E-01） | 陪伴型的有效成分可能不明确 | 首版不宜把"陪聊"当作唯一价值主张（推断） |
| 使用越多越好吗 | Hyodol：自由聊天越频繁，抑郁改善越大（E-21）；ElliQ 高频互动加自报改善（E-17/18） | MIT-OpenAI RCT：自愿使用越多，孤独、依赖、问题性使用越严重（E-10） | 人群不同（老人 vs 一般成人）；都是相关性；厂商数据有选择偏倚 | 使用时长和次数**不能**作为主要成功指标，需要配合人际联系等结局 |
| ElliQ "孤独降低 95%" | NYSOFA 新闻稿（E-17） | 没有测量方法和对照，厂商数据，应答偏倚（E-18） | 营销口径 | 不作为效果证据，只作为参与度参考 |
| 老人偏好写实还是非写实形象 | Tu 2020：老人没有恐怖谷效应，偏好拟人化（E-45） | Walden 2015：希望与人明确区分（二手，E-46）；Sharkey：欺骗伦理（E-25）；中国法规要求提示 AI 身份（E-33） | 静态图片与实际交互不同；伦理与偏好是两个层面 | 可以用"拟人但明确是 AI"的形象，必须做 A/B 测试 |
| 放慢语速、简化句子是否有益 | 直觉上的适老化做法 | Kemper & Harden 1999：放慢、短句、高音调都无益，且显得居高临下（E-49）；Williams：elderspeak 带来负面反应（E-47/48） | 区分"清晰"与"幼儿化" | 采用正常偏慢语速、语义补充和简单句法；不用叠词、昵称或高音调 |

---

## 覆盖缺口 `[coverage_gap]`

1. `[coverage_gap]` **中国大陆**社区老人使用 AI 陪伴、虚拟形象或机器人的 RCT 效果数据：只找到方案和注册（E-13）以及质性研究（E-14）。
2. `[coverage_gap]` **基于 LLM 的语音陪伴**对认知正常社区老人的对照试验：没有已完成的 RCT。活体综述共 9 项研究，参与者中位数 12 人（E-07）；已注册的 LLM 对模板陪伴 RCT 结果尚未发表（检索所见，未核实）。
3. `[coverage_gap]` **平板或智能屏上的 2D/3D 虚拟形象**（而非实体机器人）对老人孤独感的效果：Satake 的"屏幕具身代理"亚组样本少；Villar 2026 只是 17 人的 15 天预印本（D 级，只见摘要）。
4. `[coverage_gap]` **中文大模型**对自杀和危机提问的回应质量评测：没有找到与 McBain 2025 同类的同行评审研究。
5. `[coverage_gap]` WHO 或国内权威机构针对"对话式 AI 遇到自杀或急症时怎么做"的**操作级指南**：只有法规原则（E-33）、APA 建议（E-42）和学术框架（E-44）。
6. `[coverage_gap]` 中国老人对**语音年龄、性别和语速**（字/分钟）偏好的实证，以及普通话或方言 TTS 适老研究。
7. `[coverage_gap]` **中文老年语音的停顿与端点截断**数据：E-53 只是英语社区分析，E-52 是英语预印本。
8. `[coverage_gap]` 中国老人智能音箱、智能屏的**长期留存和弃用**一手研究（E-24 只有线索）。
9. `[coverage_gap]` 公安部关于 AI 诈骗中老年受害比例的**原始统计**：媒体流传的数字无法溯源，未采用。
10. `[coverage_gap]` 卫健委 12356 原始通知全文、APA 建议全文、Trajkova 和 Pradhan 全文都未能打开，相关细节依赖摘要。

---

## 对产品设计与实验设计的启示（均为推断）

**价值主张与指标**
- 推断：现有证据不支持把"降低孤独感"作为首版的确定性承诺；对外宣传应避免疗效暗示（E-01、E-02、E-17）。可以把短期情绪改善和"被倾听感"（E-11）作为可验证的近端结局。
- 推断：陪伴型对抑郁几乎无效，认知训练型有效（E-01）。可以考虑在陪聊中嵌入结构化内容，例如回忆、认知游戏、行为激活式的小目标，并引入真人连接（子女消息、社区活动），参考 HEAL-HOA（E-09）和 BOCCO 的真人加家属模式（E-08）。
- 推断：主要结局不要用使用时长。建议同时看：UCLA-3 或 De Jong Gierveld、GDS-15、**与真人接触的频次**（防止替代人际关系，E-10、E-25、E-33），以及重度使用预警。

**实验设计**
- 推断：必须设对照（等待名单，或"非 AI 的结构化提醒加家属消息"作为注意力对照）。不能只做前后对比，否则会重复 E-02 的偏差。
- 推断：随访至少 8–12 周，最好 6 个月，以越过新奇效应（E-19、E-20、E-22）。4 个月约 30% 的退回率（E-20）可以作为留存的基准假设。
- 推断：样本要覆盖男性（E-08 中 94% 为女性）、低教育水平和轻中度听力下降的老人（E-57）。

**安全与危机**
- 推断：危机检测要独立于主对话模型，分级处理。检测到自杀或自伤意图时先播报和显示 **12356**；遇到急症（胸痛、跌倒、呼吸困难）时提示 **120**；涉及诈骗时提示 **110**。同时联系注册时登记的紧急联系人（法规义务，E-33、E-38、E-40）。由于 12356 部分地区可能不是 24 小时服务（E-38），需要兜底话术。
- 推断：上线前用中文版的 McBain 式题库，覆盖低到极高各级风险，并加入老年情境（独居、慢病、丧偶），做回归测试；每次换模型都重新测（E-28、E-29）。
- 推断：禁止任何挽留或内疚式话术，道别要顺畅、可一键退出（E-26、E-33）；连续使用 2 小时提醒（法规）。
- 推断：反诈方面，产品形象和声音应有官方核验方式（例如"我永远不会让您转账或索要验证码"作为固定口令）；不克隆子女声音（征求意见稿曾禁止模拟亲属，正式稿是否保留需复核，E-33）；把常见 AI 诈骗话术识别和提醒作为可选功能（E-34–E-37）。
- 推断：服务下线或更换人设也会带来伤害（E-23；"identity discontinuity"相关研究未核实），需要有告知和过渡方案。

**形象、声音与交互**
- 推断：形象可以偏拟人（E-45），但要持续提示是 AI（E-33）。做 2–3 种风格（写实、半写实、卡通）的 A/B 测试，注意中国老人的样本可能与台湾样本不同。
- 推断：说话风格采用"清晰而不幼儿化"：语义补充、简单句法、正常偏慢的语速；禁止叠词、"宝宝""乖"之类的称呼和夸张高音调（E-47–E-49）。用户可以自己调节语速和音量。
- 推断：端点检测不要用约 700 ms 的固定静音阈值。用语义端点检测，或把阈值放宽到 1–1.5 秒以上并提供"我还没说完"的容错（E-52–E-54）。打断功能保留，但不能依赖老人主动插话（E-54）。需要在中文老人语料上实测截断率。
- 推断：屏幕满足工信部适老规范和 WCAG AA：主要文字至少 18 dp/pt、对比度至少 4.5:1、点击区域至少 60×60 dp、无广告（E-58、E-59）；语音内容同步显示字幕；口型同步优先保证可读（E-55、E-56、E-57）。

---

*本文件只记录实际核实过的内容；标注"仅见摘要""未能打开""二手"的条目在综合判断中应降权。*
