/* ============================================================
   均成智能 · junchengzn.com 交互脚本
   仅保留必要动效：滚动淡入 / 数字计数 / 导航状态 / 移动菜单
   ============================================================ */
(function () {
  "use strict";

  var prefersReduced =
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- 移动端菜单 ---------- */
  var menuBtn = document.getElementById("menuBtn");
  var mobileMenu = document.getElementById("mobileMenu");

  function closeMenu() {
    if (!mobileMenu) return;
    mobileMenu.classList.remove("open");
    if (menuBtn) {
      menuBtn.classList.remove("open");
      menuBtn.setAttribute("aria-expanded", "false");
      menuBtn.setAttribute("aria-label", "打开菜单");
    }
  }

  if (menuBtn && mobileMenu) {
    menuBtn.addEventListener("click", function () {
      var isOpen = mobileMenu.classList.toggle("open");
      menuBtn.classList.toggle("open", isOpen);
      menuBtn.setAttribute("aria-expanded", String(isOpen));
      menuBtn.setAttribute("aria-label", isOpen ? "关闭菜单" : "打开菜单");
    });
    mobileMenu.querySelectorAll("a").forEach(function (a) {
      a.addEventListener("click", closeMenu);
    });
  }

  /* ---------- 导航滚动状态 ---------- */
  var siteNav = document.getElementById("siteNav");
  var onScroll = function () {
    if (!siteNav) return;
    siteNav.classList.toggle("scrolled", window.scrollY > 8);
  };
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  /* ---------- 滚动淡入（fade-up） ---------- */
  var revealEls = document.querySelectorAll(".reveal");

  if (prefersReduced || !("IntersectionObserver" in window)) {
    revealEls.forEach(function (el) { el.classList.add("in"); });
  } else {
    var revealObserver = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("in");
            revealObserver.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -60px 0px" }
    );
    revealEls.forEach(function (el) { revealObserver.observe(el); });
  }

  /* ---------- 数字滚动计数 ---------- */
  var statsGrid = document.getElementById("statsGrid");
  var statNums = document.querySelectorAll(".stat-num");

  function renderCount(el, progress) {
    var target = parseFloat(el.getAttribute("data-count")) || 0;
    var decimals = parseInt(el.getAttribute("data-decimals") || "0", 10);
    var suffix = el.getAttribute("data-suffix") || "";
    var value = target * progress;
    var text =
      (decimals > 0 ? value.toFixed(decimals) : String(Math.floor(value))) +
      suffix;
    el.textContent = text;
  }

  function runCounters() {
    var duration = 1800;
    var startTime = null;

    function frame(now) {
      if (startTime === null) startTime = now;
      var elapsed = now - startTime;
      var progress = Math.min(elapsed / duration, 1);
      var eased = 1 - Math.pow(1 - progress, 3); /* easeOutCubic */
      statNums.forEach(function (el) { renderCount(el, eased); });
      if (progress < 1) requestAnimationFrame(frame);
      else statNums.forEach(function (el) { renderCount(el, 1); });
    }
    requestAnimationFrame(frame);
  }

  if (statNums.length) {
    if (prefersReduced || !("IntersectionObserver" in window)) {
      statNums.forEach(function (el) { renderCount(el, 1); });
    } else if (statsGrid) {
      // 渐进增强：HTML 初始已显示目标值（无 JS 环境也正确），
      // JS 接管后归零，滚动进入视口时再计数到目标。
      statNums.forEach(function (el) { el.textContent = "0"; });
      var statsObserver = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (entry) {
            if (entry.isIntersecting) {
              runCounters();
              statsObserver.disconnect();
            }
          });
        },
        { threshold: 0.35 }
      );
      statsObserver.observe(statsGrid);
    }
  }
})();
