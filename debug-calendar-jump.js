/*!
 * 调试用：左侧节日/节气列表，点击跳转到对应日期。
 * 完成后删除本文件，并去掉 index.html 中对应的 <script src="./debug-calendar-jump.js">。
 */
(function () {
  "use strict";

  var picker = null;
  var Orig = window.LiteDatePicker;
  if (typeof Orig === "function") {
    window.LiteDatePicker = function (el, options) {
      var inst = new Orig(el, options);
      var node = typeof el === "string" ? document.querySelector(el) : el;
      if (node && node.id === "date-picker-ui") picker = inst;
      return inst;
    };
  }

  var YEAR_MIN = 1900;
  var YEAR_MAX = 2099;
  var year = Math.min(YEAR_MAX, Math.max(YEAR_MIN, new Date().getFullYear()));
  var query = "";
  var collapsed = false;
  var datesByYear = Object.create(null);
  var libVersion = -1;
  var lastJump = "";
  var root = null;

  function pad(n) {
    return n < 10 ? "0" + n : String(n);
  }

  function daysInYear(y) {
    return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 366 : 365;
  }

  function presets() {
    return window.CalendarArt && typeof window.CalendarArt.presets === "function"
      ? window.CalendarArt.presets()
      : [];
  }

  function collectYear(y) {
    if (datesByYear[y]) return datesByYear[y];
    var map = Object.create(null);
    if (!window.Solar || !window.CalendarArt || typeof window.CalendarArt.candidates !== "function") {
      datesByYear[y] = map;
      return map;
    }
    var start = window.Solar.fromYmd(y, 1, 1);
    var n = daysInYear(y);
    for (var i = 0; i < n; i++) {
      var solar = i ? start.next(i) : start;
      var date = solar.toYmd();
      var ids = window.CalendarArt.candidates(date);
      for (var j = 0; j < ids.length; j++) {
        if (!map[ids[j]]) map[ids[j]] = date;
      }
    }
    datesByYear[y] = map;
    return map;
  }

  function jump(date) {
    if (!date) return;
    lastJump = date;
    var tries = 0;
    (function attempt() {
      var btn = document.getElementById("btn-date-go");
      if (picker && typeof picker.setDate === "function" && btn) {
        picker.setDate(date);
        btn.click();
        render();
        return;
      }
      if (++tries < 50) setTimeout(attempt, 80);
    })();
  }

  function injectStyle() {
    if (document.getElementById("debug-cal-jump-style")) return;
    var s = document.createElement("style");
    s.id = "debug-cal-jump-style";
    s.textContent =
      "#debug-cal-jump{position:fixed;left:0;top:0;bottom:0;z-index:8000;width:268px;display:flex;flex-direction:column;" +
      "background:#2b2e33;color:#f4efe4;font:13px/1.45 'PingFang SC','Microsoft YaHei',sans-serif;" +
      "box-shadow:4px 0 24px rgba(0,0,0,.35);transition:transform .2s ease}" +
      "#debug-cal-jump.is-collapsed{transform:translateX(-100%)}" +
      "#debug-cal-jump *{box-sizing:border-box}" +
      "#debug-cal-jump .dcj-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.08);flex-shrink:0}" +
      "#debug-cal-jump .dcj-title{font-weight:700;letter-spacing:.08em;font-size:12px;color:#e8d5a3;flex:1}" +
      "#debug-cal-jump .dcj-year{display:flex;align-items:center;gap:4px;padding:8px 12px;flex-shrink:0}" +
      "#debug-cal-jump .dcj-year button,#debug-cal-jump .dcj-toggle{width:28px;height:28px;border:0;border-radius:6px;" +
      "background:#3d424a;color:#f4efe4;cursor:pointer;font:inherit}" +
      "#debug-cal-jump .dcj-year button:hover,#debug-cal-jump .dcj-toggle:hover{background:#4d7c50}" +
      "#debug-cal-jump .dcj-year-val{flex:1;text-align:center;font-variant-numeric:tabular-nums;font-weight:600;font-size:16px}" +
      "#debug-cal-jump .dcj-search{margin:0 12px 8px;padding:7px 10px;border:1px solid rgba(255,255,255,.12);border-radius:8px;" +
      "background:#1f2226;color:#f4efe4;font:inherit;width:calc(100% - 24px);flex-shrink:0}" +
      "#debug-cal-jump .dcj-list{flex:1;overflow:auto;padding:0 8px 16px}" +
      "#debug-cal-jump .dcj-group{margin:10px 4px 4px;font-size:11px;color:#c9a227;letter-spacing:.12em;font-weight:700}" +
      "#debug-cal-jump .dcj-item{display:flex;align-items:baseline;gap:8px;width:100%;padding:6px 8px;margin:2px 0;border:0;" +
      "border-radius:6px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}" +
      "#debug-cal-jump .dcj-item:hover{background:rgba(77,124,80,.35)}" +
      "#debug-cal-jump .dcj-item.is-on{background:#1b5e20;color:#fff}" +
      "#debug-cal-jump .dcj-item.is-miss{opacity:.4;cursor:default}" +
      "#debug-cal-jump .dcj-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      "#debug-cal-jump .dcj-date{font-variant-numeric:tabular-nums;color:#b7c4b8;font-size:12px;flex-shrink:0}" +
      "#debug-cal-jump .dcj-item.is-on .dcj-date{color:#e8f5e9}" +
      "#debug-cal-jump .dcj-tab{position:absolute;right:-28px;top:18px;width:28px;height:56px;border:0;border-radius:0 8px 8px 0;" +
      "background:#2b2e33;color:#e8d5a3;cursor:pointer;font-size:14px;box-shadow:4px 0 12px rgba(0,0,0,.25)}" +
      "#debug-cal-jump .dcj-count{font-weight:400;letter-spacing:0;color:#8a9088}";
    document.head.appendChild(s);
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function render() {
    if (!root) return;
    root.classList.toggle("is-collapsed", collapsed);
    root.querySelector(".dcj-year-val").textContent = String(year);
    root.querySelector(".dcj-tab").textContent = collapsed ? "›" : "‹";
    var list = root.querySelector(".dcj-list");
    list.textContent = "";
    var dates = collectYear(year);
    var q = query.trim();
    var terms = [];
    var festivals = [];
    presets().forEach(function (p) {
      if (q && p.name.indexOf(q) === -1) return;
      var row = { id: p.id, name: p.name, date: dates[p.id] || "", category: p.category };
      if (p.category === "solar-term") terms.push(row);
      else festivals.push(row);
    });
    festivals.sort(function (a, b) {
      if (a.date && b.date && a.date !== b.date) return a.date < b.date ? -1 : 1;
      if (a.date && !b.date) return -1;
      if (!a.date && b.date) return 1;
      return a.name.localeCompare(b.name, "zh");
    });
    function section(title, rows) {
      var g = el("div", "dcj-group");
      g.textContent = title + " ";
      var c = el("span", "dcj-count", "(" + rows.length + ")");
      g.appendChild(c);
      list.appendChild(g);
      rows.forEach(function (row) {
        var btn = el("button", "dcj-item");
        btn.type = "button";
        if (!row.date) btn.classList.add("is-miss");
        if (row.date && row.date === lastJump) btn.classList.add("is-on");
        btn.appendChild(el("span", "dcj-name", row.name));
        btn.appendChild(el("span", "dcj-date", row.date ? row.date.slice(5) : "—"));
        if (row.date) {
          btn.addEventListener("click", function () {
            jump(row.date);
          });
        }
        list.appendChild(btn);
      });
    }
    section("节气", terms);
    section("节日", festivals);
  }

  function mount() {
    injectStyle();
    root = el("aside", "");
    root.id = "debug-cal-jump";
    root.innerHTML =
      '<div class="dcj-head"><span class="dcj-title">调试跳转</span></div>' +
      '<div class="dcj-year"><button type="button" data-y="-1" aria-label="上一年">‹</button>' +
      '<div class="dcj-year-val"></div>' +
      '<button type="button" data-y="1" aria-label="下一年">›</button></div>' +
      '<input class="dcj-search" type="search" placeholder="搜索节日 / 节气" />' +
      '<div class="dcj-list"></div>' +
      '<button type="button" class="dcj-tab" aria-label="折叠"></button>';
    root.querySelector(".dcj-year").addEventListener("click", function (e) {
      var b = e.target.closest("button[data-y]");
      if (!b) return;
      year = Math.min(YEAR_MAX, Math.max(YEAR_MIN, year + Number(b.getAttribute("data-y"))));
      render();
    });
    root.querySelector(".dcj-search").addEventListener("input", function (e) {
      query = e.target.value;
      render();
    });
    root.querySelector(".dcj-tab").addEventListener("click", function () {
      collapsed = !collapsed;
      render();
    });
    document.body.appendChild(root);
    render();
  }

  function watchLibrary() {
    setInterval(function () {
      if (!window.CalendarArt || typeof window.CalendarArt.info !== "function") return;
      var v = window.CalendarArt.info().version;
      if (v !== libVersion) {
        libVersion = v;
        datesByYear = Object.create(null);
        render();
      }
    }, 800);
  }

  function start() {
    mount();
    watchLibrary();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
