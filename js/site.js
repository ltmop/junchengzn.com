// 均成智能官网 — 黑洞背景联调
// 1) mousemove 视差:归一化坐标 postMessage 给 iframe 里的 GARGANTUA 渲染器
//    (协议 {type:'gargantua:parallax', nx, ny},渲染器 bg 模式已实现)。
// 2) 窄屏降级:渲染器不识别 dprcap URL 参数(bg 模式内部已 cap DPR 1.5),
//    且 stills/ 不随站点分发、无静态图可换。故宽度 < 640px 时直接隐藏
//    iframe,由 css/site.css 的纯 CSS 深空渐变接管背景,零 GPU 开销。
(() => {
  const iframe = document.getElementById('bh-bg');
  if (!iframe) return;

  // ---- 窄屏降级 ----------------------------------------------
  const NARROW = 640;
  function applyBgMode() {
    const narrow = window.innerWidth < NARROW;
    iframe.style.display = narrow ? 'none' : 'block';
    // display 切换后 iframe 视口变化未必触发其内部 resize,手动补一发
    if (!narrow && iframe.contentWindow) {
      try { iframe.contentWindow.dispatchEvent(new Event('resize')); } catch {}
    }
  }
  applyBgMode();
  window.addEventListener('resize', applyBgMode);

  // ---- 鼠标视差 ----------------------------------------------
  let raf = 0;
  let nx = 0, ny = 0;
  window.addEventListener('mousemove', (e) => {
    nx = (e.clientX / Math.max(window.innerWidth, 1)) * 2 - 1;
    ny = (e.clientY / Math.max(window.innerHeight, 1)) * 2 - 1;
    if (!raf) raf = requestAnimationFrame(send);
  }, { passive: true });

  function send() {
    raf = 0;
    //  iframe 尚未加载完成时 contentWindow 仍在,postMessage 安全;
    //  渲染器侧收到消息前只是无视差,无错误。
    if (iframe.contentWindow) {
      iframe.contentWindow.postMessage(
        { type: 'gargantua:parallax', nx, ny }, window.location.origin);
    }
  }
})();
