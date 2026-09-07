// i18n strings for the HUD. Keys are language codes; `params` maps the
// pNN ids to localized short labels (ids themselves never change).

export const LANGS = ['zh', 'en'];

export const STRINGS = {
  en: {
    title: 'GARGANTUA · SCHWARZSCHILD RAYTRACER',
    headings: { quality: 'QUALITY', cinematic: 'CINEMATIC', preset: 'PRESET', parameters: 'PARAMETERS', aesthetics: 'AESTHETICS' },
    qualities: { standard: 'STANDARD', high: 'HIGH', cinematic: 'CINEMATIC' },
    play: 'PLAY ⏵', pause: 'PAUSE ⏸', shotAB: 'SHOT A/B', save: 'SAVE',
    saveTip: 'Overwrite current preset with current view',
    langBtn: '中/EN',
    langTip: 'Switch language / 切换语言',
    viewPrefix: 'VIEW',
    debugNames: [
      'COMPOSITE', 'STEPS HEAT', 'NO LENS', 'NO DOPPLER', 'NO REDSHIFT',
      'NO TURB', 'CROSSINGS', 'HIT CLASS', 'HDR ZONES', 'RAW HDR',
    ],
    shotNames: ['DEEP ORBIT', 'EDGE-ON PASS'],
    shotPrefix: 'SHOT',
    audioOn: 'AUDIO ON', audioArmed: 'AUDIO ARMED', muted: 'MUTED', audioOff: 'AUDIO OFF',
    custom: 'CUSTOM', fpsSuffix: 'FPS', dynresPrefix: 'DYNRES',
    valueTip: 'double-click to type a value',
    legend: [
      ['SPACE', 'CINEMATIC PLAY/PAUSE'],
      ['0–9', 'DEBUG VIEW'],
      ['SHIFT+1–4', 'PRESET P1–P4'],
      ['W/S', 'DISTANCE'],
      ['A/D', 'ORBIT AZIMUTH'],
      ['Q/E', 'INCLINATION'],
      ['↑/↓', 'EXPOSURE'],
      ['B', 'BLOOM'],
      ['G', 'GRAIN'],
      ['F', 'FULLSCREEN'],
      ['M', 'MUTE'],
      ['R', 'RESET PRESET'],
      ['K', 'AUTO-ORBIT'],
      ['L', 'LANGUAGE'],
      ['H', 'HUD'],
    ],
    params: {
      p01: 'cam dist', p02: 'incline', p03: 'auto orb', p04: 'disk in',
      p05: 'disk out', p06: 'disk temp', p07: 'turb amp', p08: 'turb scale',
      p09: 'turb flow', p10: 'doppler k', p11: 'redshift', p12: 'min step',
      p13: 'max step', p14: 'max cross', p15: 'exposure', p16: 'bloom str',
      p17: 'bloom rad', p18: 'grain', p19: 'chroma', p20: 'vignette',
      p21: 'saturate',
      tintIn: 'inner tint ×', tintOut: 'outer tint ×', diskH: 'disk thick',
    },
  },
  zh: {
    title: 'GARGANTUA · 施瓦西黑洞光线追踪',
    headings: { quality: '质量档', cinematic: '电影镜头', preset: '视角预设', parameters: '参数', aesthetics: '美学' },
    qualities: { standard: '标准', high: '高', cinematic: '电影级' },
    play: '播放 ⏵', pause: '暂停 ⏸', shotAB: '镜头 A/B', save: '保存',
    saveTip: '用当前视角覆盖保存当前预设',
    langBtn: '中/EN',
    langTip: 'Switch language / 切换语言',
    viewPrefix: '视图',
    debugNames: [
      '合成', '步数热力', '无透镜', '无多普勒', '无红移',
      '无湍流', '穿越次数', '命中分类', 'HDR 分区', '线性原图',
    ],
    shotNames: ['深空环游', '贴盘穿越'],
    shotPrefix: '镜头',
    audioOn: '音频开', audioArmed: '音频待触发', muted: '已静音', audioOff: '音频关',
    custom: '自定义', fpsSuffix: 'FPS', dynresPrefix: '动态分辨率',
    valueTip: '双击可直接输入数值',
    legend: [
      ['SPACE', '电影镜头 播放/暂停'],
      ['0–9', '调试视图'],
      ['SHIFT+1–4', '预设 P1–P4'],
      ['W/S', '相机距离'],
      ['A/D', '方位角旋转'],
      ['Q/E', '倾角'],
      ['↑/↓', '曝光'],
      ['B', '辉光开关'],
      ['G', '颗粒开关'],
      ['F', '全屏'],
      ['M', '静音'],
      ['R', '重置预设'],
      ['K', '自动环绕'],
      ['L', '语言切换'],
      ['H', 'HUD 折叠'],
    ],
    params: {
      p01: '相机距离', p02: '倾角', p03: '自动环绕', p04: '盘内缘',
      p05: '盘外缘', p06: '盘温度', p07: '湍流振幅', p08: '湍流尺度',
      p09: '湍流平流', p10: '多普勒指数', p11: '引力红移', p12: '最小步长',
      p13: '最大步长', p14: '穿越上限', p15: '曝光', p16: '辉光强度',
      p17: '辉光半径', p18: '颗粒', p19: '色散', p20: '暗角',
      p21: '饱和度',
      tintIn: '内圈色温 ×', tintOut: '外圈色温 ×', diskH: '盘厚度 h/r',
    },
  },
};

export function detectLang() {
  const n = (navigator.language || 'en').toLowerCase();
  return n.startsWith('zh') ? 'zh' : 'en';
}
