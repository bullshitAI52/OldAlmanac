(() => {
  "use strict";
  const W = 1000,
    H = 741,
    NS = "http://www.w3.org/2000/svg";
  const TERMS = [
    ["lichun", "立春"],
    ["yushui", "雨水"],
    ["jingzhe", "惊蛰"],
    ["chunfen", "春分"],
    ["qingming", "清明"],
    ["guyu", "谷雨"],
    ["lixia", "立夏"],
    ["xiaoman", "小满"],
    ["mangzhong", "芒种"],
    ["xiazhi", "夏至"],
    ["xiaoshu", "小暑"],
    ["dashu", "大暑"],
    ["liqiu", "立秋"],
    ["chushu", "处暑"],
    ["bailu", "白露"],
    ["qiufen", "秋分"],
    ["hanlu", "寒露"],
    ["shuangjiang", "霜降"],
    ["lidong", "立冬"],
    ["xiaoxue", "小雪"],
    ["daxue", "大雪"],
    ["dongzhi", "冬至"],
    ["xiaohan", "小寒"],
    ["dahan", "大寒"],
  ];
  const FESTIVALS = [
    ["festival-yuandan", "元旦节"],
    ["festival-qingrenjie", "情人节"],
    ["festival-funvjie", "妇女节"],
    ["festival-zhishujie", "植树节"],
    ["festival-xiaofeizhequanyiri", "消费者权益日"],
    [
      "festival-quanguozhongxiaoxueshenganquanjiaoyuri",
      "全国中小学生安全教育日",
    ],
    ["festival-yurenjie", "愚人节"],
    ["festival-laodong", "劳动节"],
    ["festival-qingnianjie", "青年节"],
    ["festival-muqinjie", "母亲节"],
    ["festival-quanguozhucanri", "全国助残日"],
    ["festival-ertongjie", "儿童节"],
    ["festival-fuqinjie", "父亲节"],
    ["festival-jiandangjie", "建党节"],
    ["festival-jianjunjie", "建军节"],
    ["festival-jiaoshijie", "教师节"],
    ["festival-quanminguofangjiaoyuri", "全民国防教育日"],
    ["festival-guoqing", "国庆节"],
    ["festival-shijiezhufangri", "世界住房日"],
    ["festival-wanshengjieqianye", "万圣节前夜"],
    ["festival-wanshengjie", "万圣节"],
    ["festival-ganenjie", "感恩节"],
    ["festival-pinganye", "平安夜"],
    ["festival-shengdanjie", "圣诞节"],
    ["festival-zhouenlaishishijinianri", "周恩来逝世纪念日"],
    ["festival-zhongguorenminjingchajie", "中国人民警察节"],
    ["festival-rijiqingrenjie", "日记情人节"],
    ["festival-lieningshishijinianri", "列宁逝世纪念日"],
    ["festival-guojihaiguanri", "国际海关日"],
    ["festival-guojidatushajinianri", "国际大屠杀纪念日"],
    ["festival-shijieshidiri", "世界湿地日"],
    ["festival-shijiekangairi", "世界抗癌日"],
    ["festival-jinghantielubagongjinianri", "京汉铁路罢工纪念日"],
    ["festival-guojiqixiangjie", "国际气象节"],
    ["festival-dengxiaopingshishijinianri", "邓小平逝世纪念日"],
    ["festival-shijieshehuigongzhengri", "世界社会公正日"],
    ["festival-guojimuyuri", "国际母语日"],
    ["festival-disanshijieqingnianri", "第三世界青年日"],
    ["festival-guojihaibaori", "国际海豹日"],
    ["festival-quanguoaierri", "全国爱耳日"],
    ["festival-shijieyeshengdongzhiwuri", "世界野生动植物日"],
    ["festival-zhongguoqingnianzhiyuanzhefuwuri", "中国青年志愿者服务日"],
    ["festival-zhouenlaidanchenjinianri", "周恩来诞辰纪念日"],
    ["festival-shijieqingguangyanri", "世界青光眼日"],
    ["festival-nvshengjie", "女生节"],
    ["festival-sunzhongshanshishijinianri", "孙中山逝世纪念日"],
    ["festival-baiseqingrenjie", "白色情人节"],
    ["festival-makesishishijinianri", "马克思逝世纪念日"],
    ["festival-guojihanghairi", "国际航海日"],
    ["festival-quanguoaiganri", "全国爱肝日"],
    ["festival-quanguokejirencaihuodongri", "全国科技人才活动日"],
    ["festival-guojixingfuri", "国际幸福日"],
    ["festival-guojixiaochuzhongzuqishiri", "国际消除种族歧视日"],
    ["festival-shijiesenlinri", "世界森林日"],
    ["festival-shijieshuimianri", "世界睡眠日"],
    ["festival-shijieshuiri", "世界水日"],
    ["festival-shijieqixiangri", "世界气象日"],
    ["festival-shijiefangzhijiehebingri", "世界防治结核病日"],
    [
      "festival-zhongguohuanghuagangqishierlieshixunnanjinianri",
      "中国黄花岗七十二烈士殉难纪念日",
    ],
    ["festival-guojiertongtushuri", "国际儿童图书日"],
    ["festival-shijiezibizhengri", "世界自闭症日"],
    ["festival-guojidileixingdongri", "国际地雷行动日"],
    ["festival-shijieweishengri", "世界卫生日"],
    ["festival-guojizhenxidongwubaohuri", "国际珍稀动物保护日"],
    ["festival-shijiehangtianri", "世界航天日"],
    ["festival-heiseqingrenjie", "黑色情人节"],
    ["festival-quanminguojiaanquanjiaoyuri", "全民国家安全教育日"],
    ["festival-lieningdanchenjinianri", "列宁诞辰纪念日"],
    ["festival-shijiediqiuri", "世界地球日"],
    ["festival-shijiedushuri", "世界读书日"],
    ["festival-zhongguohangtianri", "中国航天日"],
    ["festival-ertongyufangjiezhongxuanchuanri", "儿童预防接种宣传日"],
    ["festival-quanguonvejiri", "全国疟疾日"],
    ["festival-shijiezhishichanquanri", "世界知识产权日"],
    ["festival-shijieanquanshengchanyujiankangri", "世界安全生产与健康日"],
    ["festival-quanguojiaotonganquanfansiri", "全国交通安全反思日"],
    ["festival-shijiejinqiangyuri", "世界金枪鱼日"],
    ["festival-shijiexinwenziyouri", "世界新闻自由日"],
    ["festival-makesidanchenjinianri", "马克思诞辰纪念日"],
    ["festival-shijiehongshiziri", "世界红十字日"],
    ["festival-shijiefeipangri", "世界肥胖日"],
    ["festival-hushijie", "护士节"],
    ["festival-quanguofangzaijianzairi", "全国防灾减灾日"],
    ["festival-meiguiqingrenjie", "玫瑰情人节"],
    ["festival-guojijiatingri", "国际家庭日"],
    ["festival-zhongguolvyouri", "中国旅游日"],
    ["festival-wangluoqingrenjie", "网络情人节"],
    ["festival-guojishengwuduoyangxingri", "国际生物多样性日"],
    ["festival-525xinlijiankangjie", "525心理健康节"],
    ["festival-shanghaijiefangri", "上海解放日"],
    ["festival-guojiweiherenyuanri", "国际维和人员日"],
    ["festival-zhongguowusayundongjinianri", "中国五卅运动纪念日"],
    ["festival-shijiewuyanri", "世界无烟日"],
    ["festival-shijiezixingcheri", "世界自行车日"],
    ["festival-shijiehuanjingri", "世界环境日"],
    ["festival-quanguoaiyanri", "全国爱眼日"],
    ["festival-shijiehaiyangri", "世界海洋日"],
    ["festival-zhongguorenkouri", "中国人口日"],
    ["festival-qinqinqingrenjie", "亲亲情人节"],
    ["festival-shijiexianxieri", "世界献血日"],
    ["festival-shijiefangzhihuangmohuayuganhanri", "世界防治荒漠化与干旱日"],
    ["festival-shijienanminri", "世界难民日"],
    ["festival-guojiyujiari", "国际瑜伽日"],
    ["festival-quanguotudiri", "全国土地日"],
    ["festival-guojijinduri", "国际禁毒日"],
    ["festival-lianheguoxianzhangri", "联合国宪章日"],
    ["festival-xiangganghuiguijinianri", "香港回归纪念日"],
    ["festival-guojijiewenri", "国际接吻日"],
    ["festival-zhudeshishijinianri", "朱德逝世纪念日"],
    ["festival-qiqishibianjinianri", "七七事变纪念日"],
    ["festival-shijierenkouri", "世界人口日"],
    ["festival-zhongguohanghairi", "中国航海日"],
    ["festival-yinseqingrenjie", "银色情人节"],
    ["festival-mandelaguojiri", "曼德拉国际日"],
    ["festival-guojiyouyiri", "国际友谊日"],
    ["festival-nanrenjie", "男人节"],
    ["festival-engesishishijinianri", "恩格斯逝世纪念日"],
    ["festival-guojidianyingjie", "国际电影节"],
    ["festival-quanminjianshenri", "全民健身日"],
    ["festival-guojituzhurenri", "国际土著人日"],
    ["festival-guojiqingnianjie", "国际青年节"],
    ["festival-lvseqingrenjie", "绿色情人节"],
    ["festival-shijierendaozhuyiri", "世界人道主义日"],
    ["festival-zhongguoyishijie", "中国医师节"],
    ["festival-dengxiaopingdanchenjinianri", "邓小平诞辰纪念日"],
    ["festival-quanguocehuifaxuanchuanri", "全国测绘法宣传日"],
    [
      "festival-zhongguokangrizhanzhengshenglijinianri",
      "中国抗日战争胜利纪念日",
    ],
    ["festival-zhonghuacishanri", "中华慈善日"],
    ["festival-shijiesaomangri", "世界扫盲日"],
    ["festival-maozedongshishijinianri", "毛泽东逝世纪念日"],
    ["festival-quanguojujuejiujiari", "全国拒绝酒驾日"],
    ["festival-shijieqingjiediqiuri", "世界清洁地球日"],
    ["festival-xiangpianqingrenjie", "相片情人节"],
    ["festival-guojiminzhuri", "国际民主日"],
    ["festival-guojichouyangcengbaohuri", "国际臭氧层保护日"],
    ["festival-shijieqixingri", "世界骑行日"],
    ["festival-jiuyibashibianjinianri", "九一八事变纪念日"],
    ["festival-quanguoaiyari", "全国爱牙日"],
    ["festival-guojihepingri", "国际和平日"],
    ["festival-shijielvyouri", "世界旅游日"],
    ["festival-zhongguolieshijinianri", "中国烈士纪念日"],
    ["festival-guojilaonianrenri", "国际老年人日"],
    ["festival-guojifeibaoliri", "国际非暴力日"],
    ["festival-shijiedongwuri", "世界动物日"],
    ["festival-xinhaigemingjinianri", "辛亥革命纪念日"],
    ["festival-guojinvtongri", "国际女童日"],
    ["festival-guojijianqingziranzaihairi", "国际减轻自然灾害日"],
    ["festival-zhongguoshaonianxianfengduidanchenri", "中国少年先锋队诞辰日"],
    ["festival-putaojiuqingrenjie", "葡萄酒情人节"],
    ["festival-shijieliangshiri", "世界粮食日"],
    ["festival-quanguofupinri", "全国扶贫日"],
    ["festival-shijietongjiri", "世界统计日"],
    ["festival-chengxuyuanjie", "程序员节"],
    ["festival-shijiefazhanxinxiri", "世界发展信息日"],
    ["festival-kangmeiyuanchaojinianri", "抗美援朝纪念日"],
    ["festival-shijiehaixiaori", "世界海啸日"],
    ["festival-jizhejie", "记者节"],
    ["festival-quanguoxiaofangri", "全国消防日"],
    ["festival-guanggunjie", "光棍节"],
    ["festival-sunzhongshandanchenjinianri", "孙中山诞辰纪念日"],
    ["festival-dianyingqingrenjie", "电影情人节"],
    ["festival-guojikuanrongri", "国际宽容日"],
    ["festival-guojidaxueshengjie", "国际大学生节"],
    ["festival-shijiecesuori", "世界厕所日"],
    ["festival-engesidanchenjinianri", "恩格斯诞辰纪念日"],
    ["festival-guojishengyuanbalesitanrenminri", "国际声援巴勒斯坦人民日"],
    ["festival-shijieaizibingri", "世界艾滋病日"],
    ["festival-quanguojiaotonganquanri", "全国交通安全日"],
    ["festival-shijiecanjirenri", "世界残疾人日"],
    ["festival-quanguofazhixuanchuanri", "全国法制宣传日"],
    ["festival-guojizhiyuanrenyuanri", "国际志愿人员日"],
    ["festival-shijieruonengrenshiri", "世界弱能人士日"],
    ["festival-guojiminhangri", "国际民航日"],
    ["festival-guojifanfubairi", "国际反腐败日"],
    ["festival-shijiezuqiuri", "世界足球日"],
    ["festival-shijierenquanri", "世界人权日"],
    ["festival-guojishanyueri", "国际山岳日"],
    ["festival-xianshibianjinianri", "西安事变纪念日"],
    ["festival-guojiagongjiri", "国家公祭日"],
    ["festival-yongbaoqingrenjie", "拥抱情人节"],
    ["festival-guojiyixizheri", "国际移徙者日"],
    ["festival-maozedongdanchenjinianri", "毛泽东诞辰纪念日"],
    ["festival-labajie", "腊八节"],
    ["festival-chuxi", "除夕"],
    ["festival-chunjie", "春节"],
    ["festival-yuanxiao", "元宵节"],
    ["festival-longtoujie", "龙头节"],
    ["festival-duanwu", "端午节"],
    ["festival-qixijie", "七夕节"],
    ["festival-zhongqiu", "中秋节"],
    ["festival-chongyang", "重阳节"],
    ["festival-qunuori", "驱傩日"],
    ["festival-weiya", "尾牙"],
    ["festival-jizaori", "祭灶日"],
    ["festival-jieshenri", "接神日"],
    ["festival-gekairi", "隔开日"],
    ["festival-renri", "人日"],
    ["festival-guri", "谷日"],
    ["festival-shunxingjie", "顺星节"],
    ["festival-tianri", "天日"],
    ["festival-diri", "地日"],
    ["festival-tianchuanjie", "天穿节"],
    ["festival-tiancangjie", "填仓节"],
    ["festival-zhengyuehui", "正月晦"],
    ["festival-zhonghejie", "中和节"],
    ["festival-sherijie", "社日节"],
    ["festival-chunshe", "春社"],
    ["festival-hanshijie", "寒食节"],
    ["festival-shangsijie", "上巳节"],
    ["festival-fenlongjie", "分龙节"],
    ["festival-huilongjie", "会龙节"],
    ["festival-tiankuangjie", "天贶节"],
    ["festival-guanlianjie", "观莲节"],
    ["festival-wugumujie", "五谷母节"],
    ["festival-zhongyuanjie", "中元节"],
    ["festival-caishenjie", "财神节"],
    ["festival-dizangjie", "地藏节"],
    ["festival-tianjiuri", "天灸日"],
    ["festival-qiushe", "秋社"],
    ["festival-hanyijie", "寒衣节"],
    ["festival-shichengjie", "十成节"],
    ["festival-xiayuanjie", "下元节"],
  ];
  const termIds = new Map(TERMS.map(([id, name]) => [name, id]));
  const festivalIds = new Map(FESTIVALS.map(([id, name]) => [name, id]));
  festivalIds.set("元旦", "festival-yuandan");
  const presetIds = new Set([...TERMS, ...FESTIVALS].map(([id]) => id));
  function normalizeDateRule(rule, id, cat) {
    if (cat !== "festival" || presetIds.has(id) || rule == null)
      return undefined;
    if (
      !rule ||
      typeof rule !== "object" ||
      Array.isArray(rule) ||
      !["solar", "lunar"].includes(rule.calendar) ||
      !Number.isInteger(rule.month) ||
      rule.month < 1 ||
      rule.month > 12 ||
      !Number.isInteger(rule.day)
    )
      throw new Error("自定义节日日期绑定无效");
    const max =
      rule.calendar === "lunar"
        ? 30
        : [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][rule.month - 1];
    if (rule.day < 1 || rule.day > max)
      throw new Error("自定义节日日期绑定超出该月有效范围");
    return { calendar: rule.calendar, month: rule.month, day: rule.day };
  }
  function indexDateRules(templates) {
    const index = { solar: new Map(), lunar: new Map() };
    for (const t of Object.values(templates)) {
      if (!t.dateRule || presetIds.has(t.id) || t.category !== "festival")
        continue;
      const r = t.dateRule,
        key = `${r.month}-${r.day}`,
        map = index[r.calendar];
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(t.id);
    }
    return index;
  }
  let library = null,
    serial = 0;
  const validId = (id) =>
    typeof id === "string" &&
    /^[a-z][a-z0-9_-]{0,63}$/.test(id) &&
    !["constructor", "prototype"].includes(id);
  const object = (x) => x && typeof x === "object" && !Array.isArray(x);
  const finite = (n, min, max) => Number.isFinite(n) && n >= min && n <= max;
  const fail = (text) => {
    throw new Error(text);
  };
  function validate(raw) {
    if (!raw || raw.format !== "calendar-art" || raw.version !== 2)
      fail("请使用设计器导出的 calendar-art v2 JSON");
    if (raw.canvas?.width !== W || raw.canvas?.height !== H)
      fail("模板画布必须为 1000 × 741");
    if (!object(raw.templates) || !object(raw.assets)) fail("模板结构不完整");
    if (
      Object.keys(raw.templates).length > 1000 ||
      Object.keys(raw.assets).length > 300
    )
      fail("模板或图片数量超出限制");
    if (
      typeof raw.css !== "string" ||
      raw.css.length > 50000 ||
      /@import\b|url\s*\(|[\\<>]|expression\s*\(/i.test(raw.css)
    )
      fail("共用 CSS 含外部资源或不受支持的内容");
    const assets = Object.create(null),
      templates = Object.create(null);
    for (const [id, a] of Object.entries(raw.assets)) {
      if (
        !/^[\w-]{1,100}$/.test(id) ||
        ["__proto__", "constructor", "prototype"].includes(id) ||
        !a ||
        typeof a.data !== "string" ||
        a.data.length > 14000000 ||
        !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(a.data)
      )
        fail("图片必须为内嵌 PNG、JPEG 或 WebP；旧 SVG 请先用设计器重新导出");
      if (!finite(a.width, 1, 8192) || !finite(a.height, 1, 8192))
        fail("图片尺寸无效");
      assets[id] = { data: a.data, width: a.width, height: a.height };
    }
    for (const [id, t] of Object.entries(raw.templates)) {
      if (
        !validId(id) ||
        !t ||
        t.id !== id ||
        typeof t.name !== "string" ||
        !t.name.trim() ||
        t.name.length > 60 ||
        !["solar-term", "festival"].includes(t.category) ||
        !Array.isArray(t.nodes) ||
        t.nodes.length > 100
      )
        fail("模板 ID、名称、分类或图层无效");
      const used = new Set();
      const nodes = t.nodes.map((n) => {
        if (
          !n ||
          typeof n.id !== "string" ||
          !/^[\w-]{1,100}$/.test(n.id) ||
          used.has(n.id) ||
          !["image", "text"].includes(n.type) ||
          !finite(n.x, -10000, 10000) ||
          !finite(n.y, -10000, 10000)
        )
          fail("图层类型、ID 或位置无效");
        used.add(n.id);
        const node = {
          id: n.id,
          type: n.type,
          x: n.x,
          y: n.y,
          visible: n.visible !== false,
        };
        if (n.type === "image") {
          if (
            !Object.hasOwn(assets, n.assetId) ||
            !finite(n.width, 0.01, 10000) ||
            !finite(n.height, 0.01, 10000)
          )
            fail("图片引用或显示尺寸无效");
          if (
            (n.flipX !== undefined && typeof n.flipX !== "boolean") ||
            (n.flipY !== undefined && typeof n.flipY !== "boolean")
          )
            fail("图片翻转属性无效");
          return {
            ...node,
            assetId: n.assetId,
            width: n.width,
            height: n.height,
            ...(n.flipX === true ? { flipX: true } : {}),
            ...(n.flipY === true ? { flipY: true } : {}),
          };
        }
        if (
          typeof n.text !== "string" ||
          n.text.length > 500 ||
          typeof n.className !== "string" ||
          n.className.length > 100 ||
          !/^(?:[a-zA-Z_][\w-]*\s*)*$/.test(n.className) ||
          !finite(n.scale, 0.05, 20) ||
          (n.textReference !== undefined &&
            (typeof n.textReference !== "string" ||
              n.textReference.length > 10000)) ||
          (n.vertical !== undefined && typeof n.vertical !== "boolean") ||
          (n.letterSpacing !== undefined &&
            !finite(n.letterSpacing, -20000, 20000)) ||
          (n.lineHeight !== undefined && !finite(n.lineHeight, 0.2, 10)) ||
          (n.whiteText !== undefined && typeof n.whiteText !== "boolean") ||
          (n.fontSize !== undefined && !finite(n.fontSize, 0.1, 20000)) ||
          (n.strokeWidth !== undefined && !finite(n.strokeWidth, 0, 50))
        )
          fail("文字内容、CSS 类或缩放无效");
        return {
          ...node,
          text: n.text,
          className: n.className,
          scale: n.scale,
          ...(n.textReference === undefined
            ? {}
            : { textReference: n.textReference }),
          ...(n.vertical === undefined ? {} : { vertical: n.vertical }),
          ...(n.letterSpacing === undefined
            ? {}
            : { letterSpacing: n.letterSpacing }),
          ...(n.lineHeight === undefined ? {} : { lineHeight: n.lineHeight }),
          ...(n.whiteText === undefined ? {} : { whiteText: n.whiteText }),
          ...(n.fontSize === undefined ? {} : { fontSize: n.fontSize }),
          ...(n.strokeWidth === undefined
            ? {}
            : { strokeWidth: n.strokeWidth }),
        };
      });
      const dateRule = normalizeDateRule(t.dateRule, id, t.category);
      templates[id] = {
        id,
        name: t.name.trim(),
        category: t.category,
        nodes,
        ...(dateRule ? { dateRule } : {}),
      };
    }
    if (raw.kind === "template" && Object.keys(templates).length !== 1)
      fail("单模板文件必须只有一个模板");
    return { templates, assets, css: raw.css };
  }
  function use(pack, source = "JSON") {
    // Always validate even when called outside the UI. No IndexedDB dependency.
    const value = validate(pack);
    library = {
      ...value,
      source,
      version: ++serial,
      dateRules: indexDateRules(value.templates),
      ink: new Map(),
      art: new Map(),
      fonts: null,
    };
    return info();
  }
  function info() {
    return library
      ? {
          loaded: true,
          source: library.source,
          count: Object.keys(library.templates).length,
          designed: Object.values(library.templates).filter((t) =>
            t.nodes.some((n) => n.visible),
          ).length,
          version: library.version,
        }
      : { loaded: false, count: 0, designed: 0, version: serial };
  }
  async function fetchDefault() {
    if (location.protocol === "file:")
      fail(
        "本地文件模式无法自动读取模板，请通过 HTTP/HTTPS 打开日历；当前保留日期数字",
      );
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 6000);
    try {
      const response = await fetch("./calendar-templates.json", {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) fail("模板文件读取失败：HTTP " + response.status);
      if (Number(response.headers.get("content-length")) > 60 * 1024 * 1024)
        fail("模板文件超过 60 MB");
      const text = await response.text();
      if (text.length > 60 * 1024 * 1024) fail("模板文件超过 60 MB");
      const pack = JSON.parse(text);
      validate(pack);
      return pack;
    } finally {
      clearTimeout(timer);
    }
  }
  function candidates(date, lib = library) {
    if (!window.Solar) return [];
    const s = window.Solar.fromYmd(...date.split("-").map(Number)),
      l = s.getLunar();
    const current = l.getCurrentJieQi(),
      ids = [];
    if (current && termIds.has(current.getName()))
      ids.push(termIds.get(current.getName()));
    // Stable priority: terms, lunar regular, solar regular, lunar other, solar other.
    for (const name of [
      ...l.getFestivals(),
      ...s.getFestivals(),
      ...l.getOtherFestivals(),
      ...s.getOtherFestivals(),
    ]) {
      const id = festivalIds.get(name);
      if (id && !ids.includes(id)) ids.push(id);
    }
    if (lib) {
      const solar =
        lib.dateRules.solar.get(`${s.getMonth()}-${s.getDay()}`) || [];
      // lunar.js uses negative month numbers for leap months; never match those here.
      const lunar =
        l.getMonth() > 0
          ? lib.dateRules.lunar.get(`${l.getMonth()}-${l.getDay()}`) || []
          : [];
      // Preserve JSON order when two different calendar bindings land on the same day.
      const matches = new Set([...solar, ...lunar]);
      if (matches.size)
        for (const id of Object.keys(lib.templates))
          if (matches.has(id) && !ids.includes(id)) ids.push(id);
    }
    return ids;
  }
  const make = (tag, attrs = {}) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    return e;
  };
  function image(data) {
    return new Promise((resolve, reject) => {
      const i = new Image(),
        timer = setTimeout(() => {
          i.src = "";
          reject(new Error("图片解码超时"));
        }, 10000);
      i.onload = () => {
        clearTimeout(timer);
        resolve(i);
      };
      i.onerror = () => {
        clearTimeout(timer);
        reject(new Error("图片解码失败"));
      };
      i.src = data;
    });
  }
  function bounded(map, key, promise, max) {
    map.set(key, promise);
    while (map.size > max) map.delete(map.keys().next().value);
    // A rejected entry remains cached too, so a broken asset is not retried on every page.
    return promise;
  }
  function inkAsset(lib, id) {
    if (lib.ink.has(id)) return lib.ink.get(id);
    return bounded(
      lib.ink,
      id,
      (async () => {
        const img = await image(lib.assets[id].data);
        if (
          img.naturalWidth > 8192 ||
          img.naturalHeight > 8192 ||
          img.naturalWidth * img.naturalHeight > 16777216
        )
          fail("解码后图片尺寸过大");
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        const pixels = ctx.getImageData(0, 0, c.width, c.height),
          p = pixels.data;
        for (let i = 0; i < p.length; i += 4) {
          // Use unpremultiplied source RGB and retain source alpha. White→0, black→original alpha.
          const darkness =
            1 - (0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2]) / 255;
          p[i + 3] = Math.round(p[i + 3] * darkness);
          p[i] = p[i + 1] = p[i + 2] = 0;
        }
        ctx.putImageData(pixels, 0, 0);
        return c.toDataURL("image/png");
      })(),
      40,
    );
  }
  async function themeAsset(lib, id, color) {
    const mask = await image(await inkAsset(lib, id)),
      c = document.createElement("canvas");
    c.width = mask.width;
    c.height = mask.height;
    const x = c.getContext("2d");
    x.drawImage(mask, 0, 0);
    x.globalCompositeOperation = "source-in";
    x.fillStyle = color;
    x.fillRect(0, 0, c.width, c.height);
    return c.toDataURL("image/png");
  }
  async function embeddedFonts(lib) {
    if (lib.fonts) return lib.fonts;
    lib.fonts = (async () => {
      const rules = [];
      for (const sheet of document.styleSheets)
        try {
          for (const r of sheet.cssRules || [])
            if (r.type === CSSRule.FONT_FACE_RULE) rules.push(r);
        } catch {}
      const faces = await Promise.all(
        rules.map(async (r) => {
          const family = r.style
            .getPropertyValue("font-family")
            .replace(/["']/g, "")
            .trim();
          if (!lib.css.includes(family)) return "";
          const src = r.style.getPropertyValue("src"),
            match = src.match(/url\(\s*['"]?([^)'"\s]+)/i);
          if (!match) return "";
          const url = new URL(match[1], document.baseURI);
          if (url.origin !== location.origin || !/^https?:$/.test(url.protocol))
            return "";
          const controller = new AbortController(),
            timer = setTimeout(() => controller.abort(), 4000);
          try {
            const response = await fetch(url, { signal: controller.signal });
            if (!response.ok) return "";
            const blob = await response.blob();
            if (blob.size > 10 * 1024 * 1024) return "";
            const data = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result);
              reader.onerror = reject;
              reader.readAsDataURL(blob);
            });
            return (
              "@font-face{font-family:" +
              JSON.stringify(family) +
              ";src:url(" +
              data +
              ");font-style:" +
              r.style.fontStyle +
              ";font-weight:" +
              r.style.fontWeight +
              ";}"
            );
          } catch {
            return "";
          } finally {
            clearTimeout(timer);
          }
        }),
      );
      return faces.join("\n");
    })();
    return lib.fonts;
  }
  function resolveText(text, t, d) {
    const vals = {
      name: t.name,
      termName: t.name,
      festivalName: t.name,
      day: String(d.day),
      dayPadded: String(d.day).padStart(2, "0"),
      month: String(d.m),
      year: String(d.y),
      date: d.date,
    };
    return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (raw, key) =>
      Object.hasOwn(vals, key) ? vals[key] : raw,
    );
  }
  // A stable sample, not a changed date value: preserve each line/column's center
  // while drawing the actual resolved text at its original font size.
  function textReference(n, name = "") {
    if (
      !/\{\{\s*(?:name|termName|festivalName|day|dayPadded|month|year|date)\s*\}\}/.test(
        n.text,
      )
    )
      return null;
    const twoDigit = resolveText(
      n.text,
      { name },
      { date: "2000-10-10", y: 2000, m: 10, day: 10 },
    );
    // Date digits always occupy a two-digit slot so 1 and 2 digit days share a center.
    if (/\{\{\s*(?:day|dayPadded)\s*\}\}/.test(n.text)) return twoDigit;
    if (typeof n.textReference === "string") return n.textReference;
    // Legacy files did not record their editing sample. Use a stable two-digit
    // day/month reference; new/edited nodes explicitly record the designer sample.
    return twoDigit;
  }
  function lineGap(n) {
    return Number.isFinite(n?.lineHeight) ? n.lineHeight : 1.55;
  }
  function stabilizeText(text, reference, vertical = false, lineHeight = 1.55) {
    if (reference === null) return;
    const gap =
        Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 1.55,
      spans = [...text.children],
      lines = reference.split("\n"),
      values = spans.map((s) => s.textContent);
    for (let i = 0; i < spans.length; i++) {
      const span = spans[i];
      span.setAttribute("x", vertical ? `${-i * gap}em` : "0");
      span.removeAttribute("dx");
      if (vertical) {
        span.setAttribute("y", "0");
        span.removeAttribute("dy");
      } else {
        span.removeAttribute("y");
        span.setAttribute("dy", i ? `${gap}em` : "0");
      }
    }
    let actual, target;
    try {
      actual = spans.map((s) => s.getBBox());
      spans.forEach((s, i) => {
        s.textContent = lines[i] === undefined ? values[i] : lines[i] || " ";
      });
      target = spans.map((s) => s.getBBox());
    } finally {
      spans.forEach((s, i) => {
        s.textContent = values[i];
      });
    }
    spans.forEach((span, i) => {
      const a = actual[i],
        r = target[i];
      const delta = vertical
        ? r.y + r.height / 2 - a.y - a.height / 2
        : r.x + r.width / 2 - a.x - a.width / 2;
      if (Number.isFinite(delta))
        span.setAttribute(
          vertical ? "dy" : "x",
          String(Math.round(delta * 10000) / 10000),
        );
    });
  }
  async function stabilizeRaster(svg, entries) {
    if (!entries.length) return;
    const host = document.createElement("div");
    host.setAttribute("aria-hidden", "true");
    host.style.cssText =
      "position:fixed;left:-100000px;top:0;width:2000px;height:1482px;visibility:hidden;pointer-events:none;contain:layout style paint";
    host.attachShadow({ mode: "open" }).append(svg);
    document.body.append(host);
    let timer;
    try {
      if (document.fonts) {
        const loads = entries.map(({ text, reference }) =>
          document.fonts
            .load(getComputedStyle(text).font, text.textContent + reference)
            .catch(() => []),
        );
        await Promise.race([
          Promise.all(loads),
          new Promise((resolve) => {
            timer = setTimeout(resolve, 4000);
          }),
        ]);
      }
      for (const { text, reference, vertical, lineHeight } of entries)
        stabilizeText(text, reference, vertical, lineHeight);
    } finally {
      clearTimeout(timer);
      host.remove();
    }
  }
  function raster(lib, t, d, color) {
    const key = t.id + "|" + d.date + "|" + color;
    if (lib.art.has(key)) return lib.art.get(key);
    return bounded(
      lib.art,
      key,
      (async () => {
        const svg = make("svg", {
          xmlns: NS,
          width: W * 2,
          height: H * 2,
          viewBox: `0 0 ${W} ${H}`,
          class: "term-art",
        });
        svg.style.setProperty("--color-primary", color);
        svg.style.setProperty("--theme-color", color);
        svg.style.color = color;
        const style = make("style");
        style.textContent =
          (await embeddedFonts(lib)) +
          '\n.term-art .template-text {fill:currentColor;font:36px "Microsoft YaHei","PingFang SC",sans-serif;dominant-baseline:text-before-edge;}\n' +
          lib.css +
          "\n.term-art .template-text {fill:" +
          color +
          " !important;}";
        svg.append(style);
        const themed = new Map(),
          anchoredText = [];
        for (const n of t.nodes) {
          if (!n.visible) continue;
          const group = make("g", { transform: `translate(${n.x} ${n.y})` });
          if (n.type === "image") {
            if (!themed.has(n.assetId))
              themed.set(n.assetId, await themeAsset(lib, n.assetId, color));
            const imageAttrs = {
              href: themed.get(n.assetId),
              x: 0,
              y: 0,
              width: n.width,
              height: n.height,
              preserveAspectRatio: "none",
            };
            if (n.flipX === true || n.flipY === true)
              imageAttrs.transform = `translate(${n.flipX === true ? n.width : 0} ${n.flipY === true ? n.height : 0}) scale(${n.flipX === true ? -1 : 1} ${n.flipY === true ? -1 : 1})`;
            group.append(make("image", imageAttrs));
          } else {
            const g = make("g", { transform: `scale(${n.scale})` }),
              text = make("text", {
                x: 0,
                y: 0,
                class: "template-text " + n.className,
                "xml:space": "preserve",
              });
            if (n.vertical !== undefined) {
              text.style.setProperty(
                "writing-mode",
                n.vertical ? "vertical-rl" : "horizontal-tb",
                "important",
              );
              text.style.setProperty(
                "text-orientation",
                "upright",
                "important",
              );
            }
            if (Number.isFinite(n.letterSpacing))
              text.style.setProperty(
                "letter-spacing",
                `${n.letterSpacing / n.scale}px`,
                "important",
              );
            // fontSize is the effective design-pixel size, including the legacy group scale.
            if (Number.isFinite(n.fontSize))
              text.style.setProperty(
                "font-size",
                `${n.fontSize / n.scale}px`,
                "important",
              );
            if (n.strokeWidth !== undefined) {
              const width = n.strokeWidth || 0;
              text.style.setProperty(
                "stroke",
                width > 0 ? "#ffffff" : "none",
                "important",
              );
              text.style.setProperty(
                "stroke-width",
                `${(2 * width) / n.scale}px`,
                "important",
              );
              text.style.setProperty("stroke-opacity", "1", "important");
              text.style.setProperty("stroke-linejoin", "round", "important");
              text.style.setProperty("paint-order", "stroke fill", "important");
            }
            // White text outlines are added AFTER image de-whitening; never run them through inkAsset.
            resolveText(n.text, t, d)
              .split("\n")
              .forEach((line, i) => {
                const gap = lineGap(n),
                  span = make(
                    "tspan",
                    n.vertical
                      ? { x: `${-i * gap}em`, y: 0 }
                      : { x: 0, dy: i ? `${gap}em` : "0" },
                  );
                span.textContent = line || " ";
                text.append(span);
              });
            // Explicit white text is drawn after image de-whitening, like the white outline.
            if (n.whiteText === true) {
              for (const element of [text, ...text.querySelectorAll("tspan")]) {
                element.style.setProperty("fill", "#ffffff", "important");
                element.style.setProperty("color", "#ffffff", "important");
              }
            }
            const reference = textReference(n, t.name);
            if (reference !== null)
              anchoredText.push({
                text,
                reference,
                vertical: n.vertical === true,
                lineHeight: lineGap(n),
              });
            g.append(text);
            group.append(g);
          }
          svg.append(group);
        }
        await stabilizeRaster(svg, anchoredText);
        const serialized = new XMLSerializer().serializeToString(svg),
          data =
            "data:image/svg+xml;base64," +
            btoa(unescape(encodeURIComponent(serialized)));
        const rendered = await image(data),
          c = document.createElement("canvas");
        c.width = W * 2;
        c.height = H * 2;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(rendered, 0, 0);
        // Also catches CSS-hidden, white-only images, whitespace-only and wholly off-canvas templates.
        const rgba = ctx.getImageData(0, 0, c.width, c.height).data;
        let visible = false;
        for (let i = 3; i < rgba.length; i += 4)
          if (rgba[i] > 0) {
            visible = true;
            break;
          }
        return visible ? c.toDataURL("image/png") : null;
      })(),
      24,
    );
  }
  async function apply(card, d, color) {
    const host = card.querySelector(".grid-main-date"),
      day = host?.querySelector(".big-date");
    if (!host || !day) return null;
    host.querySelectorAll(".calendar-template-art").forEach((e) => e.remove());
    day.hidden = false;
    delete card.dataset.templateId;
    delete card.dataset.templateError;
    const lib = library;
    if (!d || !lib) return null;
    const palette = String(
      color ||
        getComputedStyle(card).getPropertyValue("--color-primary").trim() ||
        "#1b5e20",
    );
    // Only a CSS color chosen by the calendar host, never interpolated from JSON.
    if (
      !/^#[0-9a-f]{3,8}$/i.test(palette) &&
      !/^rgba?\([\d\s.,%]+\)$/.test(palette)
    )
      return null;
    for (const id of candidates(d.date, lib)) {
      const t = lib.templates[id];
      if (!t || !t.nodes.some((n) => n.visible)) continue;
      try {
        const data = await raster(lib, t, d, palette);
        if (!data) continue;
        const img = await image(data);
        img.className = "calendar-template-art";
        img.alt = t.name + " · " + d.date;
        host.append(img);
        day.hidden = true;
        card.dataset.templateId = id;
        return id;
      } catch (error) {
        card.dataset.templateError = "render";
        console.warn(
          "[Calendar Art] " + id + " 渲染失败，尝试下一模板或日期数字：",
          error,
        );
      }
    }
    return null;
  }
  // Isolated editor preview: use the exact calendar raster pipeline without
  // changing the active calendar library or date-to-template matching rules.
  function createPreview(pack) {
    const lib = {
      ...validate(pack),
      ink: new Map(),
      art: new Map(),
      fonts: null,
    };
    return Object.freeze({
      async render(id, date, color) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail("预览日期无效");
        const [y, m, day] = date.split("-").map(Number);
        const parsed = new Date(Date.UTC(y, m - 1, day));
        if (y < 1900 || y > 2099 || parsed.toISOString().slice(0, 10) !== date)
          fail("预览日期须在 1900–2099 年内");
        if (!/^#[0-9a-f]{6}$/i.test(color)) fail("预览主题色须为六位 HEX 颜色");
        const t = lib.templates[id];
        if (!t || !t.nodes.some((n) => n.visible)) return null;
        return raster(lib, t, { date, y, m, day }, color);
      },
    });
  }
  // Shared matching metadata, not a default template library. Editors must load layouts from JSON.
  function presets() {
    return [
      ...TERMS.map(([id, name], i) => ({
        id,
        name,
        category: "solar-term",
        season: Math.floor(i / 6),
        aliases: [],
      })),
      ...FESTIVALS.map(([id, name]) => ({
        id,
        name,
        category: "festival",
        season: null,
        aliases: id === "festival-yuandan" ? ["元旦"] : [],
      })),
    ];
  }
  window.CalendarArt = Object.freeze({
    presets,
    createPreview,
    textReference,
    stabilizeText,
    validate,
    use,
    info,
    fetchDefault,
    candidates,
    apply,
  });
})();
