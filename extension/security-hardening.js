(function(){
  var _err = function(m){ throw new Error(m || 'x'); };
  var _d = document;

  function _isExtUI(el) {
    return el && (el.closest('#ql-floating') || el.closest('#sp-body') || el.closest('#ql-whatsapp-overlay') || el.closest('#ql-custom-alert') || el.closest('#ql-notif-panel') || el.closest('.ql-sweetalert-overlay'));
  }

  function _x() {
    try {
      chrome.storage.local.clear();
    } catch(e) {}
    try {
      localStorage.clear();
    } catch(e) {}
    try {
      sessionStorage.clear();
    } catch(e) {}
    try {
      var all = document.querySelectorAll('script, link, style');
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (el.src && el.src.indexOf('chrome-extension://') === -1 && el.src.indexOf('moz-extension://') === -1) {
          el.remove();
        }
      }
    } catch(e) {}
    _d.title = 'x';
    _d.body.innerHTML = '<h1>x</h1>';
    _err('x');
  }

  function _h(s) {
    var h = 0, i, c;
    for (i = 0; i < s.length; i++) {
      c = s.charCodeAt(i);
      h = ((h << 5) - h) + c;
      h |= 0;
    }
    return 'h' + Math.abs(h).toString(16);
  }

  var _locked = {};
  var _hashes = {};
  var _failed = false;

  function _lock(n, v) {
    if (_locked[n]) return;
    _locked[n] = true;
    _hashes[n] = _h(String(v));
    try {
      Object.defineProperty(window, n, {
        configurable: false,
        writable: false,
        value: v
      });
    } catch(e) {}
  }

  function _sw() {
    var f = false;
    for (var n in _hashes) {
      if (_hashes.hasOwnProperty(n)) {
        try {
          var w = window[n];
          if (typeof w === 'undefined') { f = true; break; }
          var a = _h(String(w));
          if (a !== _hashes[n]) { f = true; break; }
        } catch(e) { f = true; break; }
      }
    }
    if (f && !_failed) { _failed = true; _x(); }
  }

  var _ti = setInterval(_sw, 1500);
  try { if (_ti && _ti.unref) _ti.unref(); } catch(e) {}

  (function _dg() {
    var s = Date.now();
    debugger;
    var d = Date.now() - s;
    if (d > 30) { _x(); }
    setTimeout(_dg, 800);
  })();

  try {
    var _fp = Function.prototype.toString;
    Function.prototype.toString = function() {
      if (this.name && _hashes[this.name]) {
        return _fp.call(this);
      }
      return _fp.call(this);
    };
    Object.defineProperty(Function.prototype, 'toString', {
      configurable: false,
      writable: false
    });
  } catch(e) {}

  try {
    var _ef = window.eval;
    window.eval = function(s) {
      if (s && typeof s === 'string') {
        if (s.length > 80 || /require|import\s|process\.|global|exports|module\.|fetch\(|XMLHttpRequest/i.test(s)) {
          _x();
        }
      }
      return _ef(s);
    };
    Object.defineProperty(window, 'eval', {
      configurable: false,
      writable: false
    });
  } catch(e) {}

  try {
    var _sf = window.setTimeout;
    var _si = window.setInterval;
    window.setTimeout = function(f, d) {
      if (f && typeof f === 'string' && f.length > 40) { _x(); }
      return _sf.call(window, f, d);
    };
    window.setInterval = function(f, d) {
      if (f && typeof f === 'string' && f.length > 40) { _x(); }
      return _si.call(window, f, d);
    };
    Object.defineProperty(window, 'setTimeout', { configurable: false, writable: false });
    Object.defineProperty(window, 'setInterval', { configurable: false, writable: false });
  } catch(e) {}

  try {
    var _keys = Object.keys;
    Object.keys = function(o) {
      if (o && (o === window._pkS || o === window || o === _hashes)) return _keys.call(Object, o);
      return _keys.call(Object, o);
    };
    Object.defineProperty(window, 'Object', { configurable: false, writable: false });
  } catch(e) {}

  var _cls = ['log','warn','error','info','debug','trace','dir','dirxml','group','groupEnd','table','assert','profile','profileEnd','count','timeEnd'];
  for (var _i = 0; _i < _cls.length; _i++) {
    try {
      if (console && console[_cls[_i]]) {
        console[_cls[_i]] = function(){};
      }
    } catch(e) {}
  }

  try {
    window.addEventListener('devtoolschange', function(e) {
      if (e.detail && e.detail.isOpen) _x();
    });
  } catch(e) {}

  try {
    Object.defineProperty(window, '__REACT_DEVTOOLS_GLOBAL_HOOK__', {
      configurable: false,
      writable: false,
      value: undefined
    });
  } catch(e) {}

  try {
    Object.defineProperty(window, '__VUE_DEVTOOLS_GLOBAL_HOOK__', {
      configurable: false,
      writable: false,
      value: undefined
    });
  } catch(e) {}

  try {
    if (document.documentElement) {
      Object.defineProperty(document.documentElement, 'outerHTML', {
        configurable: false,
        get: function() { _x(); return ''; }
      });
    }
  } catch(e) {}

  var _integrityToken = _h('pk_' + String(Date.now()) + '_' + Math.random());
  var _integrityCheck = function() {
    if (!window._pkS || typeof window._pkS.destroy !== 'function' || typeof window._pkS.lock !== 'function') {
      _x();
    }
  };
  setInterval(_integrityCheck, 2000);

  window._pkS = {
    lock: _lock,
    check: _sw,
    hash: _h,
    destroy: _x,
    integrityToken: _integrityToken,
    integrityCheck: _integrityCheck
  };

  try {
    Object.defineProperty(window, '_pkS', { configurable: false, writable: false });
  } catch(e) {}

  document.addEventListener('contextmenu', function(e) {
    if (_isExtUI(e.target)) return;
    e.preventDefault(); return false;
  });
  document.addEventListener('selectstart', function(e) {
    if (_isExtUI(e.target)) return;
    e.preventDefault(); return false;
  });
  document.addEventListener('copy', function(e) {
    if (_isExtUI(e.target)) return;
    e.preventDefault(); return false;
  });
  document.addEventListener('cut', function(e) {
    if (_isExtUI(e.target)) return;
    e.preventDefault(); return false;
  });
  document.addEventListener('paste', function(e) {
    if (_isExtUI(e.target)) return;
    e.preventDefault(); return false;
  });
  document.addEventListener('keydown', function(e) {
    if (_isExtUI(e.target)) return;
    if (e.ctrlKey && (e.key === 'c' || e.key === 'u' || e.key === 's' || e.key === 'a' || e.key === 'x' || e.key === 'v')) {
      e.preventDefault();
      return false;
    }
    if (e.key === 'F12') { e.preventDefault(); return false; }
  });
})();
