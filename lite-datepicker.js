/*!
 * LiteDatePicker v1.2 - 轻量级原生 JS 日期选择器（单文件，无依赖）
 * 年：每行3个，每页10个，箭头翻页
 * 月：每行3个，一页12个
 * 日：每行6个，一页显示整月
 * 扩展：CSS 主题变量、窄屏布局、固定定位浮层、静默同步、公开 close()
 */
(function (global) {
  'use strict';

  /* ---------- 组件样式（自动注入，仅一次） ---------- */
  var CSS = ''
    + '.ldp,.ldp *{box-sizing:border-box}'
    + '.ldp{display:flex;gap:8px;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:var(--ldp-text,#334155);user-select:none;flex-wrap:nowrap}'
    + '.ldp button{font-family:inherit}'
    + '.ldp-unit{position:relative;flex:1;min-width:0}'
    + '.ldp-unit[data-unit="year"]{flex:1.3;min-width:0}'
    + '.ldp-trigger{display:flex;align-items:center;gap:6px;padding:9px 10px;background:var(--ldp-bg,#fff);'
    + 'border:1px solid var(--ldp-border,#e2e8f0);border-radius:10px;cursor:pointer;width:100%;font:inherit;color:inherit;justify-content:space-between;flex-shrink:0;min-width:0;'
    + 'transition:border-color .15s,box-shadow .15s}'
    + '.ldp-trigger:hover{border-color:var(--ldp-accent,#a5b4fc)}'
    + '.ldp-unit.open .ldp-trigger{border-color:var(--ldp-accent,#4f46e5);box-shadow:0 0 0 3px var(--ldp-ring,rgba(79,70,229,.12))}'
    + '.ldp-value{font-variant-numeric:tabular-nums;font-weight:500}'
    + '.ldp-caret{width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;'
    + 'border-top:5px solid var(--ldp-muted,#94a3b8);transition:transform .2s}'
    + '.ldp-unit.open .ldp-caret{transform:rotate(180deg);border-top-color:var(--ldp-accent,#4f46e5)}'
    + '.ldp-panel{position:fixed;z-index:9999;overflow:auto;overscroll-behavior:contain;background:var(--ldp-bg,#fff);'
    + 'border:1px solid var(--ldp-border,#e2e8f0);border-radius:12px;box-shadow:0 12px 32px rgba(30,41,59,.14);'
    + 'padding:10px;display:none;animation:ldpIn .16s ease;min-width:220px;white-space:nowrap}'
    + '.ldp-unit[data-unit="year"] .ldp-panel{min-width:220px;left:0;right:auto}'
    + '.ldp-unit[data-unit="month"] .ldp-panel{min-width:220px}'
    + '.ldp-unit[data-unit="day"] .ldp-panel{left:auto;right:0;min-width:260px}'
    + '.ldp-unit.open .ldp-panel{display:block}'
    + '@keyframes ldpIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}'
    + '.ldp-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;padding:0 2px}'
    + '.ldp-range{font-size:12px;color:var(--ldp-muted,#64748b);font-weight:600;font-variant-numeric:tabular-nums}'
    + '.ldp-arrow{width:26px;height:26px;border:none;background:var(--ldp-cell-bg,#f1f5f9);border-radius:7px;cursor:pointer;'
    + 'color:var(--ldp-text,#475569);font-size:13px;line-height:1;display:flex;align-items:center;justify-content:center;transition:all .15s}'
    + '.ldp-arrow:hover:not(:disabled){background:var(--ldp-accent,#4f46e5);color:#fff}'
    + '.ldp-arrow:disabled{opacity:.35;cursor:not-allowed}'
    + '.ldp-grid{display:grid;gap:6px}'
    + '.ldp-grid.cols-3{grid-template-columns:repeat(3,1fr)}'
    + '.ldp-grid.cols-6{grid-template-columns:repeat(6,1fr)}'
    + '.ldp-cell{border:none;background:var(--ldp-cell-bg,#f8fafc);border-radius:8px;padding:8px 0;cursor:pointer;'
    + 'font-size:13px;color:var(--ldp-text,#334155);text-align:center;font-variant-numeric:tabular-nums;transition:all .12s;white-space:nowrap}'
    + '.ldp-grid.cols-3 .ldp-cell{min-width:64px}'
    + '.ldp-grid.cols-6 .ldp-cell{min-width:34px;padding:7px 0}'
    + '.ldp-cell:hover{background:var(--ldp-tint,#eef2ff);color:var(--ldp-accent,#4f46e5)}'
    + '.ldp-cell.active{background:var(--ldp-accent,#4f46e5);color:#fff;font-weight:600;box-shadow:0 3px 8px var(--ldp-ring,rgba(79,70,229,.35))}'
    + '.ldp button:focus-visible{outline:2px solid var(--ldp-accent,#4f46e5);outline-offset:2px}'
    + '@media(max-width:480px){.ldp-trigger{padding:9px 10px;gap:4px}}'
    + '@media(prefers-reduced-motion:reduce){.ldp-panel{animation:none}.ldp *{transition:none}}';

  function injectStyle() {
    if (document.getElementById('ldp-style')) return;
    var s = document.createElement('style');
    s.id = 'ldp-style';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function daysInMonth(y, m) { return new Date(y, m, 0).getDate(); } // m: 1-12

  function parseDate(input) {
    if (input instanceof Date && !isNaN(input)) return input;
    if (typeof input === 'string') {
      var m = input.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
      if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    }
    return new Date();
  }

  /* ---------- 构造函数 ---------- */
  function LiteDatePicker(el, options) {
    if (!(this instanceof LiteDatePicker)) return new LiteDatePicker(el, options);
    injectStyle();

    this.el = typeof el === 'string' ? document.querySelector(el) : el;
    if (!this.el) throw new Error('LiteDatePicker: container element not found');

    var opts = options || {};
    this.minYear = opts.minYear == null ? 1950 : Number(opts.minYear);
    this.maxYear = opts.maxYear == null ? 2050 : Number(opts.maxYear);
    if (!Number.isInteger(this.minYear) || !Number.isInteger(this.maxYear) || this.minYear > this.maxYear) {
      throw new Error('LiteDatePicker: invalid year range');
    }
    this.yearsPerPage = 10;               // 每页 10 个年份
    this._listeners = { change: [] };
    if (typeof opts.onChange === 'function') this._listeners.change.push(opts.onChange);

    var d = parseDate(opts.date);
    this.year = Math.min(Math.max(d.getFullYear(), this.minYear), this.maxYear);
    this.month = d.getMonth() + 1;
    this.day = d.getDate();
    this._clampDay();

    // 年份翻页起点：让当前年所在页对齐
    this.yearPageStart = this.minYear +
      Math.floor((this.year - this.minYear) / this.yearsPerPage) * this.yearsPerPage;

    this._build();
    this._bindGlobal();
    this._renderAll();
  }

  var P = LiteDatePicker.prototype;

  /* ---------- DOM 构建 ---------- */
  P._build = function () {
    var root = document.createElement('div');
    root.className = 'ldp';
    root.innerHTML =
      unitHTML('year', '年') + unitHTML('month', '月') + unitHTML('day', '日');
    this.el.appendChild(root);
    this.root = root;

    this.units = {
      year:  root.querySelector('[data-unit="year"]'),
      month: root.querySelector('[data-unit="month"]'),
      day:   root.querySelector('[data-unit="day"]')
    };

    var self = this;

    // 触发器：点击展开/收起
    root.addEventListener('click', function (e) {
      var trigger = e.target.closest('.ldp-trigger');
      if (trigger) {
        var unit = trigger.parentNode;
        var wasOpen = unit.classList.contains('open');
        self._closeAll();
        if (!wasOpen) {
          unit.classList.add('open');
          trigger.setAttribute('aria-expanded', 'true');
          self._positionPanel(unit);
        }
        return;
      }
      // 选项点击
      var cell = e.target.closest('.ldp-cell');
      if (cell) {
        var selectedTrigger = cell.closest('.ldp-unit').querySelector('.ldp-trigger');
        var type = cell.dataset.type, val = +cell.dataset.val;
        if (type === 'year')  self._setYear(val);
        if (type === 'month') self._setMonth(val);
        if (type === 'day')   self._setDay(val);
        self._closeAll();
        selectedTrigger.focus({ preventScroll: true });
        return;
      }
      // 年份翻页箭头
      var arrow = e.target.closest('.ldp-arrow');
      if (arrow && !arrow.disabled) {
        var dir = +arrow.dataset.dir;
        self.yearPageStart += dir * self.yearsPerPage;
        self._renderYearPanel();
        self._positionPanel(self.units.year);
        var nextArrow = self.units.year.querySelector('[data-dir="' + dir + '"]');
        if (nextArrow.disabled) {
          nextArrow = self.units.year.querySelector('.ldp-arrow:not(:disabled), .ldp-cell');
        }
        nextArrow.focus({ preventScroll: true });
      }
    });

    function unitHTML(key, label) {
      return '<div class="ldp-unit" data-unit="' + key + '">'
        + '<button type="button" class="ldp-trigger" aria-label="选择' + label + '" aria-expanded="false" aria-haspopup="dialog"><span class="ldp-value"></span>'
        + '<span style="color:var(--ldp-muted,#94a3b8);font-size:12px">' + label + '</span>'
        + '<span class="ldp-caret" aria-hidden="true"></span></button>'
        + '<div class="ldp-panel" role="dialog" aria-label="选择' + label + '"></div></div>';
    }
  };

  P._bindGlobal = function () {
    var self = this;
    this._onDocClick = function (e) {
      if (!self.root.contains(e.target)) self._closeAll();
    };
    this._onDocKeydown = function (e) {
      if (e.key !== 'Escape') return;
      var openUnit = self.root.querySelector('.ldp-unit.open');
      if (openUnit) {
        // 先关闭日期浮层，不同时关闭承载它的菜单。
        e.preventDefault();
        e.stopImmediatePropagation();
        self._closeAll();
        openUnit.querySelector('.ldp-trigger').focus({ preventScroll: true });
      }
    };
    this._onResize = function () {
      var openUnit = self.root.querySelector('.ldp-unit.open');
      if (openUnit) self._positionPanel(openUnit);
    };
    this._onScroll = function (e) {
      if (!e.target.closest || !e.target.closest('.ldp-panel')) self._onResize();
    };
    // Check containment before paging replaces the clicked button.
    document.addEventListener('click', this._onDocClick, true);
    document.addEventListener('keydown', this._onDocKeydown);
    window.addEventListener('resize', this._onResize);
    document.addEventListener('scroll', this._onScroll, true);
  };

  P._closeAll = function () {
    for (var k in this.units) {
      this.units[k].classList.remove('open');
      this.units[k].querySelector('.ldp-trigger').setAttribute('aria-expanded', 'false');
    }
  };

  // 固定定位不受外层菜单滚动/裁切影响；按可视区域自动向上或向下展开。
  P._positionPanel = function (unit) {
    var panel = unit.querySelector('.ldp-panel');
    var anchor = unit.querySelector('.ldp-trigger').getBoundingClientRect();
    var vw = document.documentElement.clientWidth;
    var vh = window.innerHeight;
    var width = Math.min(unit.dataset.unit === 'day' ? 260 : 220, vw - 16);
    panel.style.minWidth = '0';
    panel.style.width = width + 'px';
    panel.style.right = 'auto';
    panel.style.maxHeight = 'none';
    var left = unit.dataset.unit === 'day' ? anchor.right - width : anchor.left;
    panel.style.left = Math.max(8, Math.min(left, vw - width - 8)) + 'px';
    var height = panel.getBoundingClientRect().height;
    var below = vh - anchor.bottom - 14;
    var above = anchor.top - 14;
    var upward = below < height && above > below;
    var available = Math.max(24, upward ? above : below);
    panel.style.maxHeight = available + 'px';
    panel.style.top = Math.max(8, upward ? anchor.top - Math.min(height, available) - 6 : anchor.bottom + 6) + 'px';
  };

  /* ---------- 渲染 ---------- */
  P._renderAll = function () {
    this._renderTriggers();
    this._renderYearPanel();
    this._renderMonthPanel();
    this._renderDayPanel();
  };

  P._renderTriggers = function () {
    this.units.year.querySelector('.ldp-value').textContent = this.year;
    this.units.month.querySelector('.ldp-value').textContent = pad(this.month);
    this.units.day.querySelector('.ldp-value').textContent = pad(this.day);
    this.units.year.querySelector('.ldp-trigger').setAttribute('aria-label', '选择年，当前 ' + this.year + ' 年');
    this.units.month.querySelector('.ldp-trigger').setAttribute('aria-label', '选择月，当前 ' + this.month + ' 月');
    this.units.day.querySelector('.ldp-trigger').setAttribute('aria-label', '选择日，当前 ' + this.day + ' 日');
  };

  // 年面板：每行3个，每页10个，可翻页
  P._renderYearPanel = function () {
    var start = this.yearPageStart;
    var end = Math.min(start + this.yearsPerPage - 1, this.maxYear);
    var html = '<div class="ldp-head">'
      + '<button type="button" class="ldp-arrow" aria-label="上一页年份" data-dir="-1"' + (start <= this.minYear ? ' disabled' : '') + '>‹</button>'
      + '<span class="ldp-range">' + start + ' - ' + end + '</span>'
      + '<button type="button" class="ldp-arrow" aria-label="下一页年份" data-dir="1"' + (end >= this.maxYear ? ' disabled' : '') + '>›</button>'
      + '</div><div class="ldp-grid cols-3">';
    for (var y = start; y <= end; y++) {
      html += '<button type="button" aria-pressed="' + (y === this.year) + '" class="ldp-cell' + (y === this.year ? ' active' : '')
        + '" data-type="year" data-val="' + y + '">' + y + '</button>';
    }
    html += '</div>';
    this.units.year.querySelector('.ldp-panel').innerHTML = html;
  };

  // 月面板：每行3个，一页12个
  P._renderMonthPanel = function () {
    var html = '<div class="ldp-grid cols-3">';
    for (var m = 1; m <= 12; m++) {
      html += '<button type="button" aria-pressed="' + (m === this.month) + '" class="ldp-cell' + (m === this.month ? ' active' : '')
        + '" data-type="month" data-val="' + m + '">' + m + '月</button>';
    }
    html += '</div>';
    this.units.month.querySelector('.ldp-panel').innerHTML = html;
  };

  // 日面板：每行6个，显示整月天数
  P._renderDayPanel = function () {
    var total = daysInMonth(this.year, this.month);
    var html = '<div class="ldp-grid cols-6">';
    for (var d = 1; d <= total; d++) {
      html += '<button type="button" aria-pressed="' + (d === this.day) + '" class="ldp-cell' + (d === this.day ? ' active' : '')
        + '" data-type="day" data-val="' + d + '">' + d + '</button>';
    }
    html += '</div>';
    var panel = this.units.day.querySelector('.ldp-panel');
    panel.innerHTML = html;
  };

  /* ---------- 内部状态变更 ---------- */
  P._clampDay = function () {
    var max = daysInMonth(this.year, this.month);
    if (this.day > max) this.day = max;
  };
  P._setYear = function (y) { this.year = y; this._clampDay(); this._afterChange(); };
  P._setMonth = function (m) { this.month = m; this._clampDay(); this._afterChange(); };
  P._setDay = function (d) { this.day = d; this._afterChange(); };

  P._afterChange = function (silent) {
    this._renderAll();
    if (silent) return;
    var self = this;
    this._listeners.change.forEach(function (cb) {
      cb(self.getDate(), self.getValue());
    });
  };

  /* ---------- 公开 API ---------- */
  P.getDate = function () { return new Date(this.year, this.month - 1, this.day); };

  P.getValue = function (fmt) {
    fmt = fmt || 'YYYY-MM-DD';
    return fmt
      .replace(/YYYY/g, this.year)
      .replace(/MM/g, pad(this.month))
      .replace(/DD/g, pad(this.day));
  };

  P.setDate = function (input, options) {
    var d = parseDate(input);
    this.year = Math.min(Math.max(d.getFullYear(), this.minYear), this.maxYear);
    this.month = d.getMonth() + 1;
    this.day = d.getDate();
    this._clampDay();
    this.yearPageStart = this.minYear +
      Math.floor((this.year - this.minYear) / this.yearsPerPage) * this.yearsPerPage;
    this._afterChange(!!(options && options.silent));
    return this;
  };

  P.close = function () { this._closeAll(); return this; };

  P.reposition = function () {
    var unit = this.root.querySelector('.ldp-unit.open');
    if (unit) this._positionPanel(unit);
    return this;
  };

  P.on = function (event, cb) {
    if (this._listeners[event] && typeof cb === 'function') this._listeners[event].push(cb);
    return this;
  };

  P.destroy = function () {
    document.removeEventListener('click', this._onDocClick, true);
    document.removeEventListener('keydown', this._onDocKeydown);
    window.removeEventListener('resize', this._onResize);
    document.removeEventListener('scroll', this._onScroll, true);
    if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root);
    this._listeners = { change: [] };
  };

  global.LiteDatePicker = LiteDatePicker;
})(window);
