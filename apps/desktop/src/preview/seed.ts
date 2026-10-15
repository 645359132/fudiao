// 浏览器预览的演示数据：经真实的用例写入，界面看到的与桌面端一致。只在开发时用。
import type { AppService } from '../app/service';

const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

const CHAPTER_ONE = [
  '青崖山的雪化得晚。沈砚下山那天，石阶上的冰还没有退干净，他走得很慢，背上的竹篓里只有两件换洗的衣裳和师父留下的一封信。',
  '信封上没有字。师父临死前只说了一句：“到了渡口，找一个姓卫的人。”',
  '山脚的茶棚里坐着三个挑夫，见他从山上下来，都停了筷子。其中一个低声说：“青崖山的人，十年没下来过了。”',
  '沈砚没有回头。他知道茶棚后面那条小路通向渡口，也知道自己身上这件旧袍子，在山下有人认得。',
];

export async function seedDemo(app: AppService): Promise<{ readonly mainWorkId: string }> {
  must(await app.loadLibrary());
  // 模型服务：演示模型，能力自检直接通过。
  const providers = must(await app.saveProvider(null, { kind: 'openai_compatible', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', authMethod: 'api_key', apiKey: 'demo' }));
  const model = must(await app.addModel(providers.providers[0]!.id, 'deepseek-flash')).models[0]!;
  must(await app.runSelfTest(model.id));

  // 第二部作品：让作品列表有不止一张卡片。
  must(await app.createWork('雨夜当铺'));
  must(await app.updateWorkInfo({ genre: '古风悬疑', synopsis: '落魄书生深夜当玉，掌柜认出了玉佩的来历。' }));

  const work = must(await app.createWork('江湖狂想'));
  must(
    await app.updateWorkInfo({
      genre: '武侠',
      synopsis: '青崖山最后一个弟子下山寻人，却被卷进漕帮与朝廷之间一桩十年前的旧案。',
      outline: '开端：沈砚奉师命下山，到渡口找姓卫的人。发展：卫七身份可疑，漕帮追杀，苏晚暗中相助。高潮：旧案真相——师父当年替朝廷背了黑锅。结局：沈砚带着账册回山，青崖山重开山门。',
    }),
  );
  const v1 = must(await app.createVolume('第一卷 下山')).volumes[0]!;
  must(await app.updateVolume(v1, { title: v1.title, summary: '沈砚下山，在渡口遇到卫七，第一次被漕帮盯上。' }));
  const v2 = must(await app.createVolume('第二卷 旧账')).volumes[1]!;
  must(await app.updateVolume(v2, { title: v2.title, summary: '十年前的漕运旧案浮出水面，卫七的身份揭开一角。' }));
  const titles: [string, string][] = [
    ['第一章 下山', v1.id],
    ['第二章 渡口夜雨', v1.id],
    ['第三章 当铺', v1.id],
    ['第四章 旧账', v2.id],
    ['第五章 江湖令', v2.id],
  ];
  for (const [title, volumeId] of titles) must(await app.createChapter(title, undefined, volumeId));
  const chapters = must(await app.reloadWork()).chapters;
  const first = chapters[0]!;
  const opened = must(await app.openChapter(first.id));
  must(
    await app.saveChapter(
      first.id,
      opened.saved,
      CHAPTER_ONE.map((text, i) => ({ id: `p${i}`, text, source: 'handwritten' as const })),
      { splits: [], merges: [] },
    ),
  );

  const people: [string, string][] = [
    ['沈砚', '青崖山最后一个弟子，十九岁，寡言，记性极好；想弄清师父临终那句话的意思。'],
    ['卫七', '渡口的船家，左手缺两根手指，说话总留半句；十年前是漕帮的账房。'],
  ];
  for (const [name, description] of people) {
    const created = must(await app.createEntity('character', name)).created;
    must(await app.updateEntity(created, { description }));
  }
  const place = must(await app.createEntity('location', '青崖山')).created;
  must(await app.updateEntity(place, { description: '江南以北的孤山，山门十年未开。' }));
  const gang = must(await app.createEntity('organization', '漕帮')).created;
  must(await app.updateEntity(gang, { description: '把持运河水路的帮会，与官府互有往来。' }));
  const rule = must(await app.createEntity('rule', '江湖令')).created;
  must(await app.updateEntity(rule, { description: '持令者可以调动沿河三十六处码头；令牌失落即作废，失主要付出性命。' }));

  const master = must(await app.createEntity('character', '青崖老人')).created;
  must(await app.updateEntity(master, { description: '沈砚的师父，十年前替朝廷背了黑锅，临终只留下一句话。' }));
  const all = must(await app.listEntities());
  const id = (name: string) => all.find((e) => e.name === name)!.id;
  const rel = (fromId: string, toId: string, category: 'family' | 'mentor' | 'ally' | 'enemy' | 'affiliation', label: string, extra: { mutual?: boolean; secret?: boolean; description?: string } = {}) =>
    app.addRelationship({ fromId, toId, category, label, mutual: extra.mutual ?? false, description: extra.description ?? '', secret: extra.secret ?? false, validFromChapterId: null, validToChapterId: null });
  must(await rel(id('青崖老人'), id('沈砚'), 'mentor', '师父', { description: '一手带大' }));
  must(await rel(id('卫七'), id('沈砚'), 'family', '叔父', { secret: true, description: '沈砚还不知道' }));
  must(await rel(id('沈砚'), id('卫七'), 'ally', '同路人', { mutual: true }));
  must(await rel(id('卫七'), id('漕帮'), 'affiliation', '前账房'));
  must(await rel(id('漕帮'), id('沈砚'), 'enemy', '追杀者'));
  must(await rel(id('青崖老人'), id('漕帮'), 'enemy', '旧仇'));

  const shen = must(await app.listEntities()).find((e) => e.name === '沈砚')!;
  for (const [i, goal] of ['沈砚下山，茶棚里有人认出了他的袍子', '渡口夜雨，卫七收下了信却不肯开船', '当铺里，掌柜认出了师父的玉佩'].entries()) {
    must(await app.savePlan(chapters[i]!.id, { goal, castIds: [shen.id], beats: [goal], foreshadowPlant: [], foreshadowPayoff: [], treatment: '', targetWords: 3000 }));
  }

  // 一段真实走过的助手对话。
  must(await app.sendToAssistant('给沈砚身边加一个重要的配角人物'));
  return { mainWorkId: work.project.id };
}
